import {
  type DeepAgentContent,
  DeepAgentContentSchema,
} from '@agent-os/contracts';
import type {
  AgentTrainingRow,
  AgentsRepository,
  ConversationsRepository,
  TrainingsRepository,
} from '@agent-os/db';

import type { AccessGate } from '../access-gate';
import type { History } from '../store/history';
import type { ToolCaller } from '../tools/tool';

/** The newest past tasks a start and a trainer's read look through. */
const PAST_TASKS_SCANNED = 50;

/**
 * The past tasks of the agent, newest first, whose runs called no MCP tool the owner has no right to
 * (design-training.md, KD-2): the comparison of a start and every trainer's read take them by this one rule.
 * With `conversationId`, only that conversation when it is one.
 */
export async function pastTaskIds(
  deps: {
    readonly conversationRows: Pick<
      ConversationsRepository,
      'pastTasks' | 'serversCalled'
    >;
    readonly access: Pick<AccessGate, 'tools'>;
  },
  ownerId: string,
  agentId: string,
  conversationId?: string,
): Promise<string[]> {
  const past = (
    await deps.conversationRows.pastTasks(agentId, {
      limit: PAST_TASKS_SCANNED,
      ...(conversationId === undefined ? {} : { conversationId }),
    })
  ).map((row) => row.id);
  const [access, calls] = await Promise.all([
    deps.access.tools(ownerId),
    deps.conversationRows.serversCalled(past),
  ]);
  const denied = new Set(
    calls
      .filter(
        (call) =>
          access.kind === 'owner_disabled' ||
          !access.allows(call.server, call.tool),
      )
      .map((call) => call.runId),
  );
  return past.filter((id) => !denied.has(id));
}

/** A training with its base version. */
export interface TrainingBase {
  readonly training: AgentTrainingRow;
  readonly number: number;
  readonly content: DeepAgentContent;
}

/** The refusal of a read of the base before a test run created its agent. */
export interface NoAgentYet {
  readonly kind: 'refused';
  readonly reason: 'invalid_arguments';
  readonly text: string;
}

/**
 * The caller's training — the row of its tree's root — with the version the trainer works on: a training's base,
 * a test run's latest (design-trainer-dialog.md, KD-7); never from the model's arguments. A test run before its
 * agent is created gets a refusal for the model.
 */
export async function trainingBase(
  deps: {
    readonly trainingRows: Pick<TrainingsRepository, 'find'>;
    readonly agentRows: Pick<
      AgentsRepository,
      'findVersion' | 'trainingVersions'
    >;
  },
  caller: Pick<ToolCaller, 'rootId'>,
): Promise<TrainingBase | NoAgentYet> {
  const row = await deps.trainingRows.find(caller.rootId);
  if (row === undefined)
    throw new Error(`Training tree ${caller.rootId} has no training row`);
  const { agentId, baseVersionId } = row;
  if (agentId === null || baseVersionId === null)
    return {
      kind: 'refused',
      reason: 'invalid_arguments',
      text: 'The agent is not created yet.',
    };
  const latest =
    row.description === null
      ? undefined
      : (await deps.agentRows.trainingVersions(row.id)).at(-1);
  const version = latest ?? (await deps.agentRows.findVersion(baseVersionId));
  if (version?.kind !== 'deep_agent')
    throw new Error(
      `Training ${row.id} has no deep agent base version ${baseVersionId}`,
    );
  return {
    training: { ...row, agentId, baseVersionId },
    number: version.number,
    content: DeepAgentContentSchema.parse(version.content),
  };
}

/** The employee's messages in the parent chat after this run's report, up to the next report (re-asks). */
export async function reAsksOf(
  history: Pick<History, 'after'>,
  parentId: string,
  runId: string,
): Promise<string[]> {
  const entries = await history.after(parentId, 0);
  const reportAt = entries.findIndex(
    (entry) => entry.kind === 'child_report' && entry.content.agentId === runId,
  );
  if (reportAt === -1) return [];
  const reAsks: string[] = [];
  for (const entry of entries.slice(reportAt + 1)) {
    if (entry.kind === 'child_report') break;
    if (entry.kind === 'user_message') reAsks.push(entry.content.text);
  }
  return reAsks;
}
