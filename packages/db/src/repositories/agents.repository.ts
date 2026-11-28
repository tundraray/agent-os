import {
  and,
  asc,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Db } from '../db';
import { agentShares, agentVersions, agents } from '../schema';

/** A row of `agents`. */
export type AgentRow = typeof agents.$inferSelect;

/**
 * An agent with its active version: `versionId` and `version` are the version's id and number, `content` its
 * definition. `kind` and `content` are read by the api, which owns their shape.
 */
export type AgentRecordRow = AgentRow & {
  readonly versionId: string;
  readonly version: number;
  readonly content: unknown;
};

/** A version with its agent's kind: what a conversation runs on (KD-6). */
export interface AgentVersionRow {
  readonly id: string;
  readonly agentId: string;
  readonly kind: string;
  readonly number: number;
  readonly content: unknown;
  /** Set on a version a training or test run proposed. */
  readonly changes: string | null;
}

/** A holder row of an agent's audience: exactly one of "everyone", a role and an employee is set. */
export type AgentShareRow = Pick<
  typeof agentShares.$inferSelect,
  'agentId' | 'everyone' | 'roleId' | 'userId'
>;

/** An agent under a sharing ban: no description, no content (AC-09.4). */
export type AgentBanRow = Pick<
  AgentRow,
  'id' | 'kind' | 'name' | 'closedAt' | 'ownerId'
>;

/** Who looks: the employee, whether they are enabled, and the roles they are in now. */
export interface LibraryViewer {
  readonly id: string;
  readonly active: boolean;
  readonly roleIds: readonly string[];
}

/** One panel agent by id, or a panel list: the system agents or the shared employee agents. */
export type AgentPanelQuery =
  { readonly id: string } | { readonly list: 'system' | 'shared' };

export interface NewAgentRow {
  /** Chosen before the save when a card named it (deep-agents KD-3); absent — the database's. */
  readonly id?: string;
  /** `null` — a system agent. */
  readonly ownerId: string | null;
  readonly name: string;
  readonly description: string;
  readonly offerInChat: boolean;
  readonly kind: string;
  /** The content of version 1. */
  readonly content: unknown;
  /** The author of version 1. */
  readonly authorId: string;
}

export type AgentInsertOutcome =
  | { readonly outcome: 'inserted'; readonly id: string }
  | { readonly outcome: 'name_taken' };

/** The holders an agent gets; an employee agent holds only roles (the service keeps that). */
export interface AgentHolderIds {
  readonly everyone: boolean;
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
}

/** SQLSTATE unique_violation. */
const UNIQUE_VIOLATION = '23505';
const NAME_INDEXES = new Set([
  'agents_owner_name_idx',
  'agents_system_name_idx',
]);
const VERSION_NUMBER_KEY = 'agent_versions_agent_number_key';

/** The constraint of a unique violation in the error chain; `undefined` — not a unique violation. */
function uniqueViolation(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code, constraint } = current as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === UNIQUE_VIOLATION && typeof constraint === 'string')
      return constraint;
  }
  return undefined;
}

function isNameCollision(error: unknown): boolean {
  const constraint = uniqueViolation(error);
  return constraint !== undefined && NAME_INDEXES.has(constraint);
}

// ---------- Conditions ----------

const notDeleted = isNull(agents.deletedAt);

/** A holder row of the agent being filtered that meets `holder`. */
function holderExists(db: Db, holder: SQL): SQL {
  return exists(
    db.client
      .select({ one: sql`1` })
      .from(agentShares)
      .where(and(eq(agentShares.agentId, agents.id), holder)),
  );
}

/**
 * The visibility procedure as one condition, its questions in order: a disabled viewer sees nothing, a
 * deleted agent nobody; the default agents every enabled one; the owner their agent; an employee agent by
 * one of its roles the viewer is in; a system agent by the viewer himself, his role, or "everyone" when he
 * has at least one role.
 */
function visibleTo(db: Db, viewer: LibraryViewer): SQL {
  if (!viewer.active) return sql`false`;
  const hasRoles = viewer.roleIds.length > 0;
  const viewerRole = hasRoles
    ? inArray(agentShares.roleId, [...viewer.roleIds])
    : sql`false`;
  const systemHolder =
    or(
      eq(agentShares.userId, viewer.id),
      viewerRole,
      hasRoles ? eq(agentShares.everyone, true) : undefined,
    ) ?? sql`false`;
  return (
    and(
      notDeleted,
      or(
        isNotNull(agents.builtinKey),
        eq(agents.ownerId, viewer.id),
        and(isNotNull(agents.ownerId), holderExists(db, viewerRole)),
        and(isNull(agents.ownerId), holderExists(db, systemHolder)),
      ),
    ) ?? sql`false`
  );
}

/** The panel condition: system agents, and employee agents open to a role and not banned; none deleted. */
function inPanel(db: Db): SQL {
  return (
    and(
      notDeleted,
      or(
        isNull(agents.ownerId),
        and(
          isNotNull(agents.ownerId),
          isNull(agents.closedAt),
          holderExists(db, isNotNull(agentShares.roleId)),
        ),
      ),
    ) ?? sql`false`
  );
}

function panelQueryCondition(
  query: AgentPanelQuery | undefined,
): SQL | undefined {
  if (query === undefined) return undefined;
  if ('id' in query) return eq(agents.id, query.id);
  return query.list === 'system'
    ? isNull(agents.ownerId)
    : isNotNull(agents.ownerId);
}

/**
 * Drizzle queries of `agents`, `agent_versions` and `agent_shares`. The only place that reads and writes
 * the catalogue tables (ADR-0016). Agents are read under the visibility procedure (design-library.md, «Как
 * решается видимость») by {@link findVisible}, and under the panel condition
 * by {@link findInPanel}, which never finds a personal agent (KD-2); each with its active version. A deleted
 * agent answers as a missing one in every read (data-model design-agents.md, KD-7). The admin right takes
 * no part in either (DC-3). Authors and holders come by id: their names live in `identity`.
 */
export class AgentsRepository {
  constructor(private readonly db: Db) {}

  /**
   * The agents the viewer sees, or the one with this id when it is visible, in the order of {@link where}:
   * the order the name winner of KD-5 reads (`nameWinners` of `@agent-os/contracts`). Every read of the
   * employee routes and of the agents' record operations goes through here (KD-2).
   */
  findVisible(viewer: LibraryViewer, id?: string): Promise<AgentRecordRow[]> {
    return this.where(
      and(
        visibleTo(this.db, viewer),
        id === undefined ? undefined : eq(agents.id, id),
      ) ?? sql`false`,
    );
  }

  /**
   * The default agent with this key and its active version, without a visibility check (data-model
   * design-agents.md, «Порт `RecordLibrary`»): it exists always and is never deleted.
   */
  async findBuiltin(builtinKey: string): Promise<AgentRecordRow | undefined> {
    const [row] = await this.where(eq(agents.builtinKey, builtinKey));
    return row;
  }

  /**
   * The undeleted agents of `ids` with their active versions, without a visibility check: the skills of an
   * agent's list come with the agent (agent-guidance design-server.md, KD-6).
   */
  async findNotDeleted(ids: readonly string[]): Promise<AgentRecordRow[]> {
    if (ids.length === 0) return [];
    return this.where(
      and(notDeleted, inArray(agents.id, [...ids])) ?? sql`false`,
    );
  }

  /** The agent with its active version, deleted or not: a test run's view reads it (design-test-run.md, KD-6). */
  async findAny(id: string): Promise<AgentRecordRow | undefined> {
    const [row] = await this.where(eq(agents.id, id));
    return row;
  }

  /**
   * A version by its id with its agent's kind, whatever the agent's visibility or deletion mark: a
   * conversation reads the version it started on (KD-6).
   */
  findVersion(id: string): Promise<AgentVersionRow | undefined> {
    return this.versionWhere(eq(agentVersions.id, id));
  }

  /** The version a training proposed (`training_id`), if it proposed one. */
  findTrainingVersion(
    trainingId: string,
  ): Promise<AgentVersionRow | undefined> {
    return this.versionWhere(eq(agentVersions.trainingId, trainingId));
  }

  /** The versions a test run proposed, by number ascending (design-trainer-dialog.md, KD-7). */
  trainingVersions(trainingId: string): Promise<AgentVersionRow[]> {
    return this.versionsWhere(eq(agentVersions.trainingId, trainingId));
  }

  private async versionWhere(
    condition: SQL,
  ): Promise<AgentVersionRow | undefined> {
    const [row] = await this.versionsWhere(condition);
    return row;
  }

  private versionsWhere(condition: SQL): Promise<AgentVersionRow[]> {
    return this.db.client
      .select({
        id: agentVersions.id,
        agentId: agentVersions.agentId,
        kind: agents.kind,
        number: agentVersions.number,
        content: agentVersions.content,
        changes: agentVersions.changes,
      })
      .from(agentVersions)
      .innerJoin(agents, eq(agents.id, agentVersions.agentId))
      .where(condition)
      .orderBy(asc(agentVersions.number));
  }

  /** The agents of the admin panel, in the same order: all of them, one list, or one by id when the panel shows it. */
  findInPanel(query?: AgentPanelQuery): Promise<AgentRecordRow[]> {
    return this.where(
      and(inPanel(this.db), panelQueryCondition(query)) ?? sql`false`,
    );
  }

  /** The holder rows of the agents, by the id of the holder row. */
  async sharesOf(agentIds: readonly string[]): Promise<AgentShareRow[]> {
    if (agentIds.length === 0) return [];
    return this.db.client
      .select({
        agentId: agentShares.agentId,
        everyone: agentShares.everyone,
        roleId: agentShares.roleId,
        userId: agentShares.userId,
      })
      .from(agentShares)
      .where(inArray(agentShares.agentId, [...agentIds]))
      .orderBy(asc(agentShares.id));
  }

  /** The panel's ban list, by name without regard to case, then id. */
  listBans(): Promise<AgentBanRow[]> {
    return this.bansWhere();
  }

  /** The ban of one agent; `undefined` — the agent has none (or is gone). */
  async findBan(id: string): Promise<AgentBanRow | undefined> {
    const [ban] = await this.bansWhere(eq(agents.id, id));
    return ban;
  }

  /**
   * Names of the owner's agents, or of the system agents when `ownerId` is `null`, the agent `exceptId`
   * and deleted agents left out — the input of the name rule (DC-8).
   */
  async names(ownerId: string | null, exceptId?: string): Promise<string[]> {
    const rows = await this.db.client
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(
          notDeleted,
          ownerId === null
            ? isNull(agents.ownerId)
            : eq(agents.ownerId, ownerId),
        ),
      );
    return rows.filter((row) => row.id !== exceptId).map((row) => row.name);
  }

  /** Whether the agent exists and is not deleted. */
  async exists(id: string): Promise<boolean> {
    const [row] = await this.db.client
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), notDeleted));
    return row !== undefined;
  }

  /**
   * Adds the agent, its version 1 by the author and points the agent at it. A name taken under a name
   * index answers `name_taken`, not an error; it comes from the database, so a transaction it ran in is
   * aborted and must be rolled back.
   */
  async insert(agent: NewAgentRow): Promise<AgentInsertOutcome> {
    let id: string;
    try {
      const [row] = await this.db.client
        .insert(agents)
        .values({
          ...(agent.id === undefined ? {} : { id: agent.id }),
          ownerId: agent.ownerId,
          name: agent.name,
          description: agent.description,
          offerInChat: agent.offerInChat,
          kind: agent.kind,
        })
        .returning({ id: agents.id });
      if (row === undefined) throw new Error('agents insert returned no row');
      id = row.id;
    } catch (error) {
      if (isNameCollision(error)) return { outcome: 'name_taken' };
      throw error;
    }
    const [version] = await this.db.client
      .insert(agentVersions)
      .values({
        agentId: id,
        number: 1,
        content: agent.content,
        authorId: agent.authorId,
      })
      .returning({ id: agentVersions.id });
    if (version === undefined)
      throw new Error(`agent_versions insert of agent ${id} returned no row`);
    await this.db.client
      .update(agents)
      .set({ activeVersionId: version.id })
      .where(eq(agents.id, id));
    return { outcome: 'inserted', id };
  }

  /**
   * Adds a version with the agent's next number; the agent row and its pointer stay (KD-3). `number_taken` —
   * a concurrent write took the number; it comes from the database and aborts the transaction it ran in. The
   * author is an employee or a training (self-learning design-training.md, KD-6).
   */
  async createVersion(
    version: {
      readonly agentId: string;
      readonly content: unknown;
    } & (
      | { readonly authorId: string }
      | { readonly trainingId: string; readonly changes: string }
    ),
  ): Promise<
    | {
        readonly outcome: 'created';
        readonly id: string;
        readonly number: number;
      }
    | { readonly outcome: 'number_taken' }
  > {
    try {
      const [row] = await this.db.client
        .insert(agentVersions)
        .values({
          agentId: version.agentId,
          number: sql`(select coalesce(max(${agentVersions.number}), 0) + 1 from ${agentVersions} where ${agentVersions.agentId} = ${version.agentId})`,
          content: version.content,
          ...('authorId' in version
            ? { authorId: version.authorId }
            : { trainingId: version.trainingId, changes: version.changes }),
        })
        .returning({ id: agentVersions.id, number: agentVersions.number });
      if (row === undefined)
        throw new Error(
          `agent_versions insert of agent ${version.agentId} returned no row`,
        );
      return { outcome: 'created', ...row };
    } catch (error) {
      if (uniqueViolation(error) === VERSION_NUMBER_KEY)
        return { outcome: 'number_taken' };
      throw error;
    }
  }

  /**
   * Points the agent at `versionId` with its name and description, in one guarded update: only while the
   * agent is not deleted and active in the version numbered `expectedNumber` (KD-3). A concurrent save of
   * the same agent waits on the row and then finds its number no longer active — `stale`. `name_taken`
   * comes from the database and aborts the transaction it ran in.
   */
  async activateVersion(change: {
    readonly agentId: string;
    readonly versionId: string;
    readonly expectedNumber: number;
    readonly name: string;
    readonly description: string;
  }): Promise<'activated' | 'stale' | 'name_taken'> {
    const expectedVersion = this.db.client
      .select({ id: agentVersions.id })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.agentId, change.agentId),
          eq(agentVersions.number, change.expectedNumber),
        ),
      );
    try {
      const [agent] = await this.db.client
        .update(agents)
        .set({
          activeVersionId: change.versionId,
          name: change.name,
          description: change.description,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(agents.id, change.agentId),
            notDeleted,
            inArray(agents.activeVersionId, expectedVersion),
          ),
        )
        .returning({ id: agents.id });
      return agent === undefined ? 'stale' : 'activated';
    } catch (error) {
      if (isNameCollision(error)) return 'name_taken';
      throw error;
    }
  }

  /** Replaces the agent's holders; the version stays (DC-11). */
  async replaceHolders(
    agentId: string,
    holders: AgentHolderIds,
  ): Promise<void> {
    await this.db.client
      .delete(agentShares)
      .where(eq(agentShares.agentId, agentId));
    const rows = [
      ...(holders.everyone ? [{ agentId, everyone: true }] : []),
      ...holders.roleIds.map((roleId) => ({ agentId, roleId })),
      ...holders.userIds.map((userId) => ({ agentId, userId })),
    ];
    if (rows.length > 0) await this.db.client.insert(agentShares).values(rows);
  }

  /** Sets «предлагать в главном чате»; the version stays (DC-11). */
  async setOfferInChat(id: string, offerInChat: boolean): Promise<void> {
    await this.db.client
      .update(agents)
      .set({ offerInChat })
      .where(eq(agents.id, id));
  }

  /** Closes sharing (Flow 4): every holder removed and the ban date set, which it returns; the version stays. */
  async closeSharing(id: string): Promise<Date> {
    await this.db.client.delete(agentShares).where(eq(agentShares.agentId, id));
    const [row] = await this.db.client
      .update(agents)
      .set({ closedAt: sql`now()` })
      .where(eq(agents.id, id))
      .returning({ closedAt: agents.closedAt });
    if (row === undefined || row.closedAt === null)
      throw new Error(`agent ${id} has no ban after its close`);
    return row.closedAt;
  }

  /** Lifts the sharing ban; `false` — the agent has none (or is gone). The version stays. */
  async liftBan(id: string): Promise<boolean> {
    const [row] = await this.db.client
      .update(agents)
      .set({ closedAt: null })
      .where(and(eq(agents.id, id), notDeleted, isNotNull(agents.closedAt)))
      .returning({ id: agents.id });
    return row !== undefined;
  }

  /** Marks the agent deleted (KD-7); its versions, holders and memory records stay as rows. */
  async markDeleted(id: string): Promise<void> {
    await this.db.client
      .update(agents)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(agents.id, id), notDeleted));
  }

  /**
   * Agents meeting the condition with their active versions, by name without regard to case, agents of one
   * name earliest created first, then by id — the name winner (KD-5) takes the first of several colleagues'
   * agents in this order.
   */
  private where(where: SQL): Promise<AgentRecordRow[]> {
    return this.withActiveVersion()
      .where(where)
      .orderBy(
        sql`lower(${agents.name})`,
        asc(agents.createdAt),
        asc(agents.id),
      );
  }

  /** The select of agents joined to their active versions. */
  private withActiveVersion() {
    return this.db.client
      .select({
        ...getTableColumns(agents),
        versionId: agentVersions.id,
        version: agentVersions.number,
        content: agentVersions.content,
      })
      .from(agents)
      .innerJoin(agentVersions, eq(agentVersions.id, agents.activeVersionId));
  }

  /** Agents under a sharing ban meeting the condition, by name, then id. */
  private bansWhere(where?: SQL): Promise<AgentBanRow[]> {
    return this.db.client
      .select({
        id: agents.id,
        kind: agents.kind,
        name: agents.name,
        closedAt: agents.closedAt,
        ownerId: agents.ownerId,
      })
      .from(agents)
      .where(and(notDeleted, isNotNull(agents.closedAt), where))
      .orderBy(sql`lower(${agents.name})`, asc(agents.id));
  }
}
