import {
  AgentContentSchema,
  DeepAgentContentSchema,
  RecordKindSchema,
  type RecordBody,
} from '@agent-os/contracts';
import type { AgentBanRow, AgentRecordRow, AgentShareRow } from '@agent-os/db';

/**
 * The rows of `agents` with their active versions and of `agent_shares` as the library's services read
 * them: the kind and the content checked by the kind's schema, the holder rows folded into one audience. Authors and
 * holders come by id: their names live in `identity` and are added by `LibraryRecords`.
 */

/** The audience of a record as stored: "everyone", roles and employees, each in the order of its row's id. */
interface StoredHolders {
  readonly everyone: boolean;
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
}

/** A stored record with its audience. */
export interface StoredRecord {
  readonly id: string;
  /** `null` — a system record. */
  readonly ownerId: string | null;
  readonly name: string;
  readonly description: string;
  readonly offerInChat: boolean;
  readonly builtinKey: string | null;
  /** The id and the number of the active version. */
  readonly versionId: string;
  readonly version: number;
  /** When an admin closed sharing; `null` — not closed. */
  readonly closedAt: Date | null;
  readonly updatedAt: Date;
  readonly body: RecordBody;
  readonly holders: StoredHolders;
}

/** A stored record under a sharing ban: no description, no content (AC-09.4). */
export interface StoredBan {
  readonly id: string;
  readonly kind: RecordBody['kind'];
  readonly name: string;
  /** `null` — a system record. */
  readonly ownerId: string | null;
  readonly closedAt: Date;
}

const NO_HOLDERS: StoredHolders = { everyone: false, roleIds: [], userIds: [] };

/** The kind and the content of a stored row, checked by the kind's schema. */
export function recordBody(kind: string, content: unknown): RecordBody {
  return RecordKindSchema.parse(kind) === 'agent'
    ? { kind: 'agent', content: AgentContentSchema.parse(content) }
    : { kind: 'deep_agent', content: DeepAgentContentSchema.parse(content) };
}

/** The holders of the records, by record id; roles and employees each in the order the holder rows came in. */
function holdersByRecord(
  shares: readonly AgentShareRow[],
): Map<string, StoredHolders> {
  const result = new Map<string, StoredHolders>();
  for (const row of shares) {
    const current = result.get(row.agentId) ?? NO_HOLDERS;
    result.set(row.agentId, {
      everyone: current.everyone || row.everyone,
      roleIds:
        row.roleId === null
          ? current.roleIds
          : [...current.roleIds, row.roleId],
      userIds:
        row.userId === null
          ? current.userIds
          : [...current.userIds, row.userId],
    });
  }
  return result;
}

/** The record rows with their holder rows as stored records; the order of the records stays. */
export function toStoredRecords(
  rows: readonly AgentRecordRow[],
  shares: readonly AgentShareRow[],
): StoredRecord[] {
  const holders = holdersByRecord(shares);
  return rows.map((record) => ({
    id: record.id,
    ownerId: record.ownerId,
    name: record.name,
    description: record.description,
    offerInChat: record.offerInChat,
    builtinKey: record.builtinKey,
    versionId: record.versionId,
    version: record.version,
    closedAt: record.closedAt,
    updatedAt: record.updatedAt,
    body: recordBody(record.kind, record.content),
    holders: holders.get(record.id) ?? NO_HOLDERS,
  }));
}

export function toStoredBan(row: AgentBanRow): StoredBan {
  if (row.closedAt === null)
    throw new Error(`agents ban row ${row.id} is broken`);
  return {
    id: row.id,
    kind: RecordKindSchema.parse(row.kind),
    name: row.name,
    ownerId: row.ownerId,
    closedAt: row.closedAt,
  };
}
