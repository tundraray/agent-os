import { type HttpException, Injectable } from '@nestjs/common';
import type { RecordDetail } from '@agent-os/contracts';
import {
  type Executor,
  LibraryRecordsRepository,
  type LibraryViewer,
  type Transaction,
} from '@agent-os/db';
import { isUuid } from '../common/is-uuid';
import {
  LibraryRecords,
  notFound,
  present,
  readOnly,
  refersToRecords,
} from './library-records';
import { kindChangedError, libraryError } from './library.errors';
import type {
  LibraryRecord,
  SaveCheck,
  SaveRefusal,
  SaveRequest,
  SaveResult,
  SaveScope,
  ServerFacts,
} from './library.types';
import type { ViewContext } from './record-view';
import { decideSave, type SaveChoices, type SaveInput } from './save-rules';

type ViewScope = ViewContext['scope'];

/** Thrown inside a save transaction to roll it back; caught right outside it. */
class SaveRefused {
  constructor(readonly refusal: SaveRefusal) {}
}

/** The HTTP answer of a refused save. */
function saveRefusalError(refusal: SaveRefusal): HttpException {
  switch (refusal) {
    case 'not_found':
      return notFound();
    case 'read_only':
      return readOnly();
    case 'version_conflict':
      return libraryError('RECORD_VERSION_CONFLICT');
    case 'name_taken':
      return libraryError('RECORD_NAME_TAKEN', 'own');
    case 'system_name':
      return libraryError('RECORD_NAME_TAKEN', 'system');
    case 'invalid':
      return kindChangedError();
    default:
      return libraryError('RECORD_REJECTED', refusal);
  }
}

/** The save of a record, shared by the employee's routes, the panel's and the main chat (Flow 1). */
@Injectable()
export class LibrarySave {
  constructor(
    private readonly records: LibraryRecords,
    private readonly repository: LibraryRecordsRepository,
  ) {}

  /**
   * The one save path of POST and PUT (employee and panel) and of the chat's save (Flow 1): visibility →
   * the right to change → the rule → the versioned write and its audit event in one transaction. A refusal
   * writes nothing. On the plain client the write opens its own transaction; on the caller's
   * transaction it is a savepoint, so a `name_taken` from the database rolls back only the save and
   * the caller's transaction goes on.
   */
  async save(
    request: SaveRequest,
    executor: Executor = this.records.db,
  ): Promise<SaveResult> {
    const check = await this.checkSave(request, executor);
    if (check.outcome === 'refused') return check;
    const { previous } = check;
    const write = (tx: Transaction): Promise<LibraryRecord> =>
      previous === null
        ? this.insertSaved(tx, request)
        : this.updateSaved(tx, request, previous);
    try {
      const record = await executor.transaction(write);
      return { outcome: 'saved', record };
    } catch (error) {
      if (error instanceof SaveRefused)
        return { outcome: 'refused', refusal: error.refusal };
      throw error;
    }
  }

  /** The checks of {@link save} before its write; writes nothing, so the chat asks it before the card. */
  async checkSave(
    request: SaveRequest,
    executor: Executor,
  ): Promise<SaveCheck> {
    // A disabled author sees no record, so whatever was written could not be read back (KD-2).
    if (!request.author.active)
      return { outcome: 'refused', refusal: 'not_found' };
    let previous: LibraryRecord | null = null;
    if (request.target !== null) {
      const { id } = request.target;
      const record = isUuid(id)
        ? await this.readOne(executor, request.scope, request.author, id)
        : undefined;
      if (record === undefined)
        return { outcome: 'refused', refusal: 'not_found' };
      const owner = request.scope === 'employee' ? request.author.id : null;
      if (record.ownerId !== owner)
        return { outcome: 'refused', refusal: 'read_only' };
      if (record.body.kind !== request.body.kind)
        return { outcome: 'refused', refusal: 'invalid' };
      previous = record;
    }
    const decision = decideSave(
      await this.saveInput(executor, request, previous),
    );
    if (decision.kind === 'name_taken')
      return {
        outcome: 'refused',
        refusal: decision.reason === 'own' ? 'name_taken' : 'system_name',
        field: { path: decision.path, values: decision.values },
      };
    if (decision.kind === 'refused')
      return {
        outcome: 'refused',
        refusal: decision.reason,
        field: { path: decision.path, values: decision.values },
      };
    return { outcome: 'allowed', previous };
  }

  /** The input of the save rule: other records' names, the author's choices, the agents he sees. */
  private async saveInput(
    executor: Executor,
    request: SaveRequest,
    previous: LibraryRecord | null,
  ): Promise<SaveInput> {
    const { scope, author, body } = request;
    const exceptId = previous?.id;
    const [ownNames, systemNames, visibleAgentIds, models] = await Promise.all([
      scope === 'employee'
        ? this.repository.names(executor, author.id, exceptId)
        : [],
      this.repository.names(
        executor,
        null,
        scope === 'system' ? exceptId : undefined,
      ),
      this.records.visibleAgentIds(executor, author, refersToRecords(body)),
      request.models ??
        (scope === 'employee'
          ? this.records.allowedModelIds(author.id)
          : this.records.catalogueModelIds()),
    ]);
    const choices: SaveChoices =
      scope === 'employee'
        ? {
            scope,
            usableServers: request.servers,
            allowedModels: models,
            visibleAgentIds,
          }
        : {
            scope,
            registryServers: request.servers,
            catalogueModels: models,
            visibleAgentIds,
          };
    return {
      name: body.name,
      body,
      previous: previous && { name: previous.name, body: previous.body },
      takenNames: { own: ownNames, system: systemNames },
      choices,
    };
  }

  private async insertSaved(
    tx: Transaction,
    request: SaveRequest,
  ): Promise<LibraryRecord> {
    const { scope, author, body } = request;
    const inserted = await this.repository.insert(tx, {
      ...(request.newId === undefined ? {} : { id: request.newId }),
      ownerId: scope === 'employee' ? author.id : null,
      name: body.name,
      description: body.description,
      offerInChat: true,
      kind: body.kind,
      content: body.content,
    });
    if (inserted.outcome === 'name_taken') throw new SaveRefused('name_taken');
    const record = present(
      await this.readOne(tx, scope, author, inserted.id),
      inserted.id,
    );
    await this.records.audit(tx, author.id, 'library_create', null, record);
    return record;
  }

  /**
   * `name_taken` aborts the transaction, so it is thrown and the transaction rolled back.
   */
  private async updateSaved(
    tx: Transaction,
    request: SaveRequest,
    previous: LibraryRecord,
  ): Promise<LibraryRecord> {
    const { scope, author, body } = request;
    const updated = await this.repository.updateContent(tx, {
      id: previous.id,
      version: request.target?.version ?? previous.version,
      name: body.name,
      description: body.description,
      content: body.content,
    });
    if (updated.outcome === 'name_taken') throw new SaveRefused('name_taken');
    const current = await this.readOne(tx, scope, author, previous.id);
    if (updated.outcome === 'stale')
      throw new SaveRefused(
        current === undefined ? 'not_found' : 'version_conflict',
      );
    const record = present(current, previous.id);
    await this.records.audit(tx, author.id, 'library_update', previous, record);
    return record;
  }

  async savedDetail(
    result: SaveResult,
    author: LibraryViewer,
    isAdmin: boolean,
    scope: ViewScope,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    if (result.outcome === 'refused') throw saveRefusalError(result.refusal);
    return this.records.detail(result.record, author, isAdmin, scope, facts);
  }

  /** The one record an employee route (visibility) or a panel route (panel condition) may touch. */
  private readOne(
    executor: Executor,
    scope: SaveScope,
    viewer: LibraryViewer,
    id: string,
  ): Promise<LibraryRecord | undefined> {
    return scope === 'employee'
      ? this.records.visibleOne(executor, viewer, id)
      : this.records.panelOne(executor, id);
  }
}
