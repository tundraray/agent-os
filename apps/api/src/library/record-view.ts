import {
  ALL_SERVERS,
  CHAT_BUILTIN_KEY,
  type BannedRecord,
  type MissingRight,
  type RecordAudience,
  type RecordBody,
  type RecordDetail,
  type RecordHeader,
  type RecordSummary,
  type ResolvedRecord,
} from '@agent-os/contracts';
import type { BannedRecordRow, LibraryRecord } from './library.repository';
import { contentParts } from './record-content';

/**
 * How a stored record is shown (design-library.md, `RecordSummary`, `RecordDetail`, «Для части
 * `runtime`», KD-7): the answer of each route and operation, and the sample of an audit event.
 */

/** Who looks and with what rights; read once per operation. */
export interface ViewContext {
  readonly viewerId: string;
  readonly isAdmin: boolean;
  /** Roles the viewer is in now. */
  readonly roleIds: readonly string[];
  /** `panel` — a route of the admin panel, which shows the whole audience of every record it lists. */
  readonly scope: 'employee' | 'panel';
  /** Servers usable to the viewer. */
  readonly usableServers: readonly string[];
  /** Models allowed to the viewer. */
  readonly allowedModels: readonly string[];
}

type ViewFields = Omit<RecordSummary, 'kind'>;

export function recordSummary(
  record: LibraryRecord,
  context: ViewContext,
): RecordSummary {
  return { ...viewFields(record, context), kind: record.body.kind };
}

export function recordDetail(record: LibraryRecord, context: ViewContext): RecordDetail {
  return { ...viewFields(record, context), ...record.body };
}

/** The record has at least one holder: `shared` of a header. */
export function hasHolders({ holders }: LibraryRecord): boolean {
  return (
    holders.everyone || holders.roles.length > 0 || holders.users.length > 0
  );
}

/** A row of `listVisible`: no content; `shared` — the record has at least one holder. */
export function recordHeader(
  record: LibraryRecord,
  viewerId: string,
): RecordHeader {
  return { ...headerFields(record, viewerId), kind: record.body.kind };
}

/** The answer of `resolve` and `resolveBuiltin`: the header with the content of its kind. */
export function resolvedRecord(
  record: LibraryRecord,
  viewerId: string,
): ResolvedRecord {
  return { ...headerFields(record, viewerId), ...record.body };
}

/** A row of the ban list: no description, no content (AC-09.4). */
export function bannedRecord(row: BannedRecordRow): BannedRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    author: row.author,
    closedAt: row.closedAt.toISOString(),
  };
}

/**
 * «Было» or «стало» of an audit event (KD-7): kind, name, owner, version, the switch, the holders by
 * id, the ban date and, for a copy, the original's id. Never the description or the content.
 */
export function auditSample(
  record: LibraryRecord,
  copiedFrom?: string,
): Record<string, unknown> {
  return {
    kind: record.body.kind,
    name: record.name,
    ownerId: record.ownerId,
    version: record.version,
    offerInChat: record.offerInChat,
    everyone: record.holders.everyone,
    roleIds: record.holders.roles.map((role) => role.id),
    userIds: record.holders.users.map((user) => user.id),
    closedAt: record.closedAt?.toISOString() ?? null,
    ...(copiedFrom === undefined ? {} : { copiedFrom }),
  };
}

/** The audit sample of a record known only by its ban-list row (the panel reads nothing else of it). */
export function banAuditSample(
  row: BannedRecordRow,
  closedAt: Date | null,
): Record<string, unknown> {
  return {
    kind: row.kind,
    name: row.name,
    ownerId: row.author.id,
    closedAt: closedAt?.toISOString() ?? null,
  };
}

function headerFields(
  record: LibraryRecord,
  viewerId: string,
): Omit<RecordHeader, 'kind'> {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    version: record.version,
    builtinKey: record.builtinKey,
    author: record.author,
    mine: record.ownerId === viewerId,
    shared: hasHolders(record),
    offerInChat: record.offerInChat,
  };
}

function viewFields(record: LibraryRecord, context: ViewContext): ViewFields {
  const mine = record.ownerId === context.viewerId;
  const system = record.ownerId === null;
  const canEdit = mine || (context.isAdmin && system);
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    version: record.version,
    updatedAt: record.updatedAt.toISOString(),
    offerInChat: record.offerInChat,
    builtinKey: record.builtinKey,
    mine,
    author: record.author,
    audience: audienceOf(record, context, mine),
    ban:
      mine && record.closedAt !== null
        ? { closedAt: record.closedAt.toISOString() }
        : null,
    missingRights: missingRights(record.body, context),
    canEdit,
    canShare:
      canEdit &&
      record.closedAt === null &&
      record.builtinKey !== CHAT_BUILTIN_KEY,
    canDelete: canEdit && record.builtinKey === null,
  };
}

/**
 * The owner, an admin on a system record and the panel see the audience whole; anyone else only the
 * roles they are in, without `everyone` and `users`.
 */
function audienceOf(
  record: LibraryRecord,
  context: ViewContext,
  mine: boolean,
): RecordAudience {
  const viewerRoles = new Set(context.roleIds);
  const roles = record.holders.roles.map((role) => ({
    ...role,
    member: viewerRoles.has(role.id),
  }));
  const whole =
    mine ||
    context.scope === 'panel' ||
    (context.isAdmin && record.ownerId === null);
  if (!whole) return { roles: roles.filter((role) => role.member) };
  return {
    everyone: record.holders.everyone,
    roles,
    users: [...record.holders.users],
  };
}

/** What the viewer lacks to run the record, part by part; «все серверы» lack nothing. */
function missingRights(body: RecordBody, context: ViewContext): MissingRight[] {
  const usable = new Set(context.usableServers);
  const allowed = new Set(context.allowedModels);
  return contentParts(body).flatMap((part) => {
    const servers = part.servers.filter(
      (server) => server !== ALL_SERVERS && !usable.has(server),
    );
    // A `null` model lacks nothing here: the start checks the default chat model (KD-5).
    const model =
      part.model === null || allowed.has(part.model) ? null : part.model;
    return servers.length > 0 || model !== null
      ? [{ subagent: part.subagent, servers, model }]
      : [];
  });
}

