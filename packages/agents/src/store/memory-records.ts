import {
  type MemoryVersionKind,
  MemoryVersionKindSchema,
  type RevertMemoryBody,
} from '@agent-os/contracts';
import {
  type CurrentMemoryRow,
  MemoriesRepository,
  type MemoryOwner,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';

const { created, changed, deleted, reverted } = MemoryVersionKindSchema.enum;

/**
 * The outcome of a change of a memory record: a new version; the record is already on another version (its
 * current state, a deletion included); there is no such record.
 */
export type MemoryChange =
  | { readonly kind: 'written'; readonly version: number }
  | { readonly kind: 'changed'; readonly current: CurrentMemoryRow }
  | { readonly kind: 'missing' };

/** The outcome of a revert: a change, or its source is the current version, a deletion or a number the record never had. */
type MemoryRevert = MemoryChange | { readonly kind: 'invalid_source' };

const MISSING: MemoryChange = { kind: 'missing' };

function isDeleted(record: CurrentMemoryRow): boolean {
  return record.kind === deleted;
}

/**
 * The one rule of changing a memory record, for the agent's tools and for the person on a memory screen
 * (memory-hygiene KD-3): a new version from the expected one, then the pointer moves; otherwise the record is
 * already on another version. It opens no transaction: the tools call it in the step's commit, the API in its own.
 *
 * Version `expected + 1` is inserted with `ON CONFLICT DO NOTHING` before the pointer moves (plan Notes 2.4): a
 * second writer from the same version waits on the key `(memory_id, version)` for the first one's commit, inserts
 * nothing and reads the first one's text. A key violation would abort the step's commit, so it is never the signal.
 */
@Injectable()
export class MemoryRecords {
  constructor(
    @Inject(MemoriesRepository) private readonly rows: MemoriesRepository,
  ) {}

  /** The live record of this description with its current version; a deleted one is not read (Data Model, rule 4). */
  async read(
    owner: MemoryOwner,
    description: string,
  ): Promise<CurrentMemoryRow | undefined> {
    const record = await this.rows.current(owner, description);
    return record === undefined || isDeleted(record) ? undefined : record;
  }

  /** A new record, or the record the agent deleted back as `created` (DC-3); a live one is `changed` (DC-2). */
  async create(
    owner: MemoryOwner,
    description: string,
    text: string,
  ): Promise<MemoryChange> {
    const id = await this.rows.insertRecord(owner, description);
    if (id !== undefined) {
      await this.rows.insertVersion({
        memoryId: id,
        version: 1,
        kind: created,
        text,
      });
      await this.movePointer(id, null, 1);
      return { kind: 'written', version: 1 };
    }
    const record = await this.rows.current(owner, description);
    if (record === undefined)
      throw new Error('memory record of a taken description is missing');
    if (!isDeleted(record)) return { kind: 'changed', current: record };
    return this.advance(owner, record, record.version, { kind: created, text });
  }

  /** Replaces the text of a live record still on `expectedVersion`; a deleted record is `changed`. */
  async change(
    owner: MemoryOwner,
    description: string,
    text: string,
    expectedVersion: number,
  ): Promise<MemoryChange> {
    const record = await this.rows.current(owner, description);
    if (record === undefined) return MISSING;
    if (isDeleted(record)) return { kind: 'changed', current: record };
    return this.advance(owner, record, expectedVersion, {
      kind: changed,
      text,
    });
  }

  /** Adds a `deleted` version to a live record still on `expectedVersion`; without a live record — `missing`. */
  async forget(
    owner: MemoryOwner,
    description: string,
    expectedVersion: number,
  ): Promise<MemoryChange> {
    const record = await this.rows.current(owner, description);
    if (record === undefined || isDeleted(record)) return MISSING;
    return this.advance(owner, record, expectedVersion, {
      kind: deleted,
      text: null,
    });
  }

  /** A person brings back the text of `version` as a `reverted` version authored by them (KD-6, KD-7). */
  async revert(
    owner: MemoryOwner,
    memoryId: string,
    body: RevertMemoryBody,
    authorId: string,
  ): Promise<MemoryRevert> {
    const record = await this.rows.currentById(owner, memoryId);
    if (record === undefined) return MISSING;
    if (record.version !== body.expectedVersion)
      return { kind: 'changed', current: record };
    const source = await this.rows.version(memoryId, body.version);
    if (
      source === undefined ||
      source.version === record.version ||
      source.text === null
    )
      return { kind: 'invalid_source' };
    return this.advance(owner, record, body.expectedVersion, {
      kind: reverted,
      text: source.text,
      authorId,
    });
  }

  /** The one way a record moves on: from `expected`, by inserting version `expected + 1`, then the pointer. */
  private async advance(
    owner: MemoryOwner,
    record: CurrentMemoryRow,
    expected: number,
    next: {
      readonly kind: MemoryVersionKind;
      readonly text: string | null;
      readonly authorId?: string;
    },
  ): Promise<MemoryChange> {
    if (record.version !== expected)
      return { kind: 'changed', current: record };
    const version = expected + 1;
    const inserted = await this.rows.insertVersion({
      memoryId: record.id,
      version,
      ...next,
    });
    if (!inserted) {
      const current = await this.rows.currentById(owner, record.id);
      return current === undefined ? MISSING : { kind: 'changed', current };
    }
    await this.movePointer(record.id, expected, version);
    return { kind: 'written', version };
  }

  /** The version is ours, so the pointer cannot have moved elsewhere: a miss is a broken invariant. */
  private async movePointer(
    id: string,
    expected: number | null,
    next: number,
  ): Promise<void> {
    if (!(await this.rows.movePointer({ id, expected, next })))
      throw new Error(
        `memory record ${id} pointer did not move from ${expected} to ${next}`,
      );
  }
}
