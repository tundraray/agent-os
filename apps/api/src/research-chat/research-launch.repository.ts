import {
  ResearchSourceModeSchema,
  type ResearchSourceMode,
} from '@agent-os/contracts';
import { type Database, researchChatLaunches } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import {
  LAUNCH_MODES,
  LAUNCH_STATES,
  type LaunchMode,
  type LaunchRecord,
  type LaunchState,
} from './launch-state.js';

/** The pool's client, or the transaction of an event consumer. */
type Queries = Database | RuntimeTx;

type LaunchRow = typeof researchChatLaunches.$inferSelect;

/** The thread of an owner; every read of the card scopes by both. */
export interface LaunchThread {
  readonly resourceId: string;
  readonly threadId: string;
}

/** A launch the `deepResearch` tool records: an explicit launch starts in `launching`, a proposal in `proposed`. */
export interface NewLaunch extends LaunchThread {
  readonly launchKey: string;
  readonly mode: LaunchMode;
  readonly goal: string;
  readonly tokenBudget: number;
  /** The user message that carried research mode; only for an explicit launch. */
  readonly userMessageId: string | null;
}

/** Columns a transition may set along with the state. */
export type LaunchFields = Partial<
  Pick<
    LaunchRow,
    | 'investigationId'
    | 'controllerTaskId'
    | 'finishedAt'
    | 'answeredAt'
    | 'appendFailedAt'
    | 'nextAppendAt'
  >
>;

/** A conditional write: the row moves to `to` only while it is still in `from`. */
export interface LaunchTransition {
  readonly launchKey: string;
  readonly from: LaunchState;
  readonly to: LaunchState;
  readonly set?: LaunchFields;
}

const oneOf = <T extends string>(
  values: readonly T[],
  value: string | null,
  column: string,
): T => {
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(
      `research_chat_launches.${column} holds an unknown value ${String(value)}`,
    );
  }
  return match;
};

/** Narrows the enumerated columns; the table's CHECK constraints keep them in range. */
function toRecord(row: LaunchRow): LaunchRecord {
  return {
    ...row,
    state: oneOf(LAUNCH_STATES, row.state, 'state'),
    mode: oneOf(LAUNCH_MODES, row.mode, 'mode'),
    sourceMode:
      row.sourceMode === null
        ? null
        : oneOf(
            ResearchSourceModeSchema.options,
            row.sourceMode,
            'source_mode',
          ),
  };
}

const toRecordOrUndefined = (
  row: LaunchRow | undefined,
): LaunchRecord | undefined => (row === undefined ? undefined : toRecord(row));

/** Queries of `research_chat_launches` (ADR-0003: drizzle-orm; design-chat-entry.md, Data Model, KD-3). */
export const researchLaunchRepository = {
  async insert(db: Queries, launch: NewLaunch): Promise<LaunchRecord> {
    const [row] = await db
      .insert(researchChatLaunches)
      .values({
        launchKey: launch.launchKey,
        resourceId: launch.resourceId,
        threadId: launch.threadId,
        mode: launch.mode,
        goal: launch.goal,
        tokenBudget: launch.tokenBudget,
        userMessageId: launch.userMessageId,
        state: launch.mode === 'explicit' ? 'launching' : 'proposed',
      })
      .returning();
    if (row === undefined) {
      throw new Error(`launch ${launch.launchKey} was not inserted`);
    }
    return toRecord(row);
  },

  /** The thread's launches in creation order, without `discarded` (`GET /api/threads/:threadId/research`). */
  async listByThread(
    db: Queries,
    thread: LaunchThread,
  ): Promise<LaunchRecord[]> {
    const rows = await db
      .select()
      .from(researchChatLaunches)
      .where(
        and(
          eq(researchChatLaunches.resourceId, thread.resourceId),
          eq(researchChatLaunches.threadId, thread.threadId),
          ne(researchChatLaunches.state, 'discarded'),
        ),
      )
      .orderBy(
        asc(researchChatLaunches.createdAt),
        asc(researchChatLaunches.launchKey),
      );
    return rows.map(toRecord);
  },

  /** The launch of `launchKey` in this owner's thread; `undefined` for another thread or owner. */
  async findByLaunchKey(
    db: Queries,
    thread: LaunchThread,
    launchKey: string,
  ): Promise<LaunchRecord | undefined> {
    const [row] = await db
      .select()
      .from(researchChatLaunches)
      .where(
        and(
          eq(researchChatLaunches.launchKey, launchKey),
          eq(researchChatLaunches.resourceId, thread.resourceId),
          eq(researchChatLaunches.threadId, thread.threadId),
        ),
      );
    return toRecordOrUndefined(row);
  },

  /** The launch whose investigation's controller task is `controllerTaskId`; the consumer matches events by it. */
  async findByControllerTaskId(
    db: Queries,
    controllerTaskId: string,
  ): Promise<LaunchRecord | undefined> {
    const [row] = await db
      .select()
      .from(researchChatLaunches)
      .where(eq(researchChatLaunches.controllerTaskId, controllerTaskId));
    return toRecordOrUndefined(row);
  },

  /**
   * `UPDATE … WHERE launch_key = … AND state = from`: the moved row, or `undefined` when the row is no longer in
   * `from` — another writer got there first.
   */
  async transition(
    db: Queries,
    change: LaunchTransition,
  ): Promise<LaunchRecord | undefined> {
    const [row] = await db
      .update(researchChatLaunches)
      .set({ ...change.set, state: change.to })
      .where(
        and(
          eq(researchChatLaunches.launchKey, change.launchKey),
          eq(researchChatLaunches.state, change.from),
        ),
      )
      .returning();
    return toRecordOrUndefined(row);
  },

  /**
   * Copies the investigation's source mode into a started launch once (invariant 6, KD-8): a recorded mode is never
   * overwritten. `undefined` when the mode was already recorded or the launch has no investigation.
   */
  async copySourceMode(
    db: Queries,
    launchKey: string,
    sourceMode: ResearchSourceMode,
  ): Promise<LaunchRecord | undefined> {
    const [row] = await db
      .update(researchChatLaunches)
      .set({ sourceMode })
      .where(
        and(
          eq(researchChatLaunches.launchKey, launchKey),
          isNull(researchChatLaunches.sourceMode),
          isNotNull(researchChatLaunches.investigationId),
        ),
      )
      .returning();
    return toRecordOrUndefined(row);
  },
};
