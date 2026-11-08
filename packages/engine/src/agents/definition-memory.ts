import { randomUUID } from 'node:crypto';
import { agentDefinitionMemory, type Database } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import { type AgentDefinition, type AgentProcessConfig, isAgentsForm } from '../config/agent-config.schema.js';
import type { ProcessSet } from '../config/process-set.js';
import type { SnapshotEntry } from './fingerprint.js';
import type { ResultFormRegistry } from './result-forms.js';

/**
 * The definition memory of an agent (design-agent-core.md, FR-22, «Правила доступа к памяти определения»): records of
 * a process's agent definition that outlive investigations. The scope `deployment` is written and read by a holder of
 * the memory admin role (`AGENT_MEMORY_ADMIN_ROLE`); a `user` scope only by its user. An investigation's agent never reads
 * the table: it gets the snapshot taken at the start (invariant 11).
 */

/** The role that writes and reads the scope `deployment` by default (design-agent-core.md, Runtime Settings). */
export const DEFAULT_MEMORY_ADMIN_ROLE = 'agent-memory-admin';

/** A record's text is at most 2000 characters (Contract `writeDefinitionMemory`). */
const RECORD_TEXT_MAX_CHARS = 2_000;
/** The active texts of one scope of one definition stay within 8 KiB (DC-15). */
const SCOPE_TEXT_MAX_BYTES = 8 * 1_024;

export type DefinitionMemoryScope = { readonly kind: 'deployment' } | { readonly kind: 'user'; readonly userId: string };

/** Who writes or reads, as the chat server takes it from the checked subject of the request (`AuthUser`). */
export interface MemoryActor {
  readonly userId: string;
  readonly roles: readonly string[];
}

export interface WriteDefinitionMemoryInput {
  readonly processId: string;
  readonly agentName: string;
  readonly scope: DefinitionMemoryScope;
  readonly text: string;
  readonly writer: MemoryActor;
}

export type WriteDefinitionMemoryResult =
  | { readonly outcome: 'written'; readonly id: string }
  | {
      readonly outcome: 'refused';
      readonly reason: 'no_write_right' | 'limit_reached' | 'unknown_definition' | 'scope_not_allowed';
    };

export interface RemoveDefinitionMemoryInput {
  readonly id: string;
  readonly remover: MemoryActor;
}

export type RemoveDefinitionMemoryResult =
  | { readonly outcome: 'removed' }
  | { readonly outcome: 'refused'; readonly reason: 'no_write_right' | 'not_found' };

export interface ListDefinitionMemoryInput {
  readonly processId: string;
  readonly agentName: string;
  readonly reader: MemoryActor;
}

/** An active record as the list returns it. */
export interface DefinitionMemoryRecord {
  readonly id: string;
  readonly scope: 'deployment' | 'user';
  /** The user of a `user` record; null for `deployment`. */
  readonly userId: string | null;
  readonly text: string;
  readonly writtenBy: string;
  readonly writtenAt: Date;
}

/** The three engine operations of the definition memory. */
export interface DefinitionMemory {
  write(input: WriteDefinitionMemoryInput): Promise<WriteDefinitionMemoryResult>;
  remove(input: RemoveDefinitionMemoryInput): Promise<RemoveDefinitionMemoryResult>;
  list(input: ListDefinitionMemoryInput): Promise<DefinitionMemoryRecord[]>;
}

export interface DefinitionMemoryDeps {
  readonly database: Database;
  readonly processes: ProcessSet;
  readonly forms: ResultFormRegistry;
  /** `AGENT_MEMORY_ADMIN_ROLE`. */
  readonly adminRole: string;
}

/** The snapshot of an investigation: the records each definition's agent sees, by agent name (DC-24). */
export type DefinitionMemorySnapshot = Readonly<Record<string, readonly SnapshotEntry[]>>;

/** Whether the definition's result form forbids the `user` scope (DC-24). */
function userScopeForbidden(definition: AgentDefinition, forms: ResultFormRegistry): boolean {
  return forms.get(definition.result)?.userMemoryForbidden === true;
}

/** The definition of the process's highest loaded version, when it is of the agents form and has the agent. */
function findDefinition(processes: ProcessSet, processId: string, agentName: string): AgentDefinition | undefined {
  const resolved = processes.resolve(processId);
  if (!resolved.ok || !isAgentsForm(resolved.config) || !Object.hasOwn(resolved.config.agents, agentName)) {
    return undefined;
  }
  return resolved.config.agents[agentName];
}

/** An actor with a user: a checked subject always has one; an empty id is nobody's and gets no right. */
const identified = (actor: MemoryActor): boolean => actor.userId !== '';

/**
 * Who may write or read a scope: the admin role for `deployment`, the user alone for `user`; an actor or a `user` scope
 * without a user id, never.
 */
function mayUse(actor: MemoryActor, scope: { readonly scope: string; readonly userId: string | null }, adminRole: string) {
  if (!identified(actor)) return false;
  return scope.scope === 'deployment' ? actor.roles.includes(adminRole) : scope.userId === actor.userId;
}

const scopeOf = (scope: DefinitionMemoryScope) =>
  scope.kind === 'deployment' ? { scope: 'deployment', userId: null } : { scope: 'user', userId: scope.userId };

/** Active records of one scope of one definition. */
function activeOfScope(input: { processId: string; agentName: string; scope: string; userId: string | null }): SQL {
  return and(
    eq(agentDefinitionMemory.processId, input.processId),
    eq(agentDefinitionMemory.agentName, input.agentName),
    eq(agentDefinitionMemory.scope, input.scope),
    input.userId === null ? isNull(agentDefinitionMemory.userId) : eq(agentDefinitionMemory.userId, input.userId),
    isNull(agentDefinitionMemory.removedAt),
  ) as SQL;
}

export function createDefinitionMemory(deps: DefinitionMemoryDeps): DefinitionMemory {
  const { database, adminRole } = deps;
  return {
    async write(input) {
      const definition = findDefinition(deps.processes, input.processId, input.agentName);
      if (definition === undefined) return { outcome: 'refused', reason: 'unknown_definition' };
      const scope = scopeOf(input.scope);
      if (!mayUse(input.writer, scope, adminRole)) return { outcome: 'refused', reason: 'no_write_right' };
      if (scope.scope === 'user' && userScopeForbidden(definition, deps.forms)) {
        return { outcome: 'refused', reason: 'scope_not_allowed' };
      }
      if (input.text.length > RECORD_TEXT_MAX_CHARS) return { outcome: 'refused', reason: 'limit_reached' };
      const key = { processId: input.processId, agentName: input.agentName, ...scope };
      return database.transaction(async (tx) => {
        // Writes of one scope of one definition queue here, so two of them cannot both pass the limit.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`agent-definition-memory:${JSON.stringify(key)}`}))`,
        );
        const [held] = await tx
          .select({ bytes: sql<number>`coalesce(sum(octet_length(${agentDefinitionMemory.text})), 0)::int` })
          .from(agentDefinitionMemory)
          .where(activeOfScope(key));
        if ((held?.bytes ?? 0) + Buffer.byteLength(input.text, 'utf8') > SCOPE_TEXT_MAX_BYTES) {
          return { outcome: 'refused', reason: 'limit_reached' } as const;
        }
        const id = randomUUID();
        await tx.insert(agentDefinitionMemory).values({ id, ...key, text: input.text, writtenBy: input.writer.userId });
        return { outcome: 'written', id } as const;
      });
    },

    async remove({ id, remover }) {
      return database.transaction(async (tx) => {
        const [record] = await tx
          .select()
          .from(agentDefinitionMemory)
          .where(and(eq(agentDefinitionMemory.id, id), isNull(agentDefinitionMemory.removedAt)))
          .for('update');
        if (record === undefined) return { outcome: 'refused', reason: 'not_found' } as const;
        if (!mayUse(remover, record, adminRole)) return { outcome: 'refused', reason: 'no_write_right' } as const;
        await tx.update(agentDefinitionMemory).set({ removedAt: sql`now()` }).where(eq(agentDefinitionMemory.id, id));
        return { outcome: 'removed' } as const;
      });
    },

    async list({ processId, agentName, reader }) {
      if (!identified(reader)) return [];
      const readable: SQL[] = [eq(agentDefinitionMemory.userId, reader.userId)];
      if (reader.roles.includes(adminRole)) readable.push(eq(agentDefinitionMemory.scope, 'deployment'));
      const rows = await database
        .select()
        .from(agentDefinitionMemory)
        .where(
          and(
            eq(agentDefinitionMemory.processId, processId),
            eq(agentDefinitionMemory.agentName, agentName),
            isNull(agentDefinitionMemory.removedAt),
            or(...readable),
          ),
        )
        .orderBy(asc(agentDefinitionMemory.writtenAt), asc(agentDefinitionMemory.id));
      return rows.map((row) => ({
        id: row.id,
        scope: row.scope as DefinitionMemoryRecord['scope'],
        userId: row.userId,
        text: row.text,
        writtenBy: row.writtenBy,
        writtenAt: row.writtenAt,
      }));
    },
  };
}

/**
 * The definition memory snapshot of an investigation at its start (Data Model, DC-24): for each definition of the
 * configuration its active `deployment` records and those of the owner's `user` scope — none of the `user` scope for a
 * definition whose form forbids it. The start writes it to the investigation's engine row in its own transaction; a
 * record removed later stays in it.
 */
export async function takeDefinitionMemorySnapshot(
  db: Database | RuntimeTx,
  input: { readonly config: AgentProcessConfig; readonly forms: ResultFormRegistry; readonly resourceId: string },
): Promise<DefinitionMemorySnapshot> {
  const rows = await db
    .select({
      id: agentDefinitionMemory.id,
      agentName: agentDefinitionMemory.agentName,
      scope: agentDefinitionMemory.scope,
      text: agentDefinitionMemory.text,
    })
    .from(agentDefinitionMemory)
    .where(
      and(
        eq(agentDefinitionMemory.processId, input.config.processId),
        isNull(agentDefinitionMemory.removedAt),
        or(eq(agentDefinitionMemory.scope, 'deployment'), eq(agentDefinitionMemory.userId, input.resourceId)),
      ),
    )
    .orderBy(asc(agentDefinitionMemory.writtenAt), asc(agentDefinitionMemory.id));
  const snapshot: Record<string, SnapshotEntry[]> = {};
  for (const [agentName, definition] of Object.entries(input.config.agents)) {
    const forbidden = userScopeForbidden(definition, input.forms);
    snapshot[agentName] = rows
      .filter((row) => row.agentName === agentName && (row.scope === 'deployment' || !forbidden))
      .map((row) => ({ id: row.id, scope: row.scope as SnapshotEntry['scope'], text: row.text }));
  }
  return snapshot;
}
