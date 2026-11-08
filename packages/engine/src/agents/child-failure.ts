import type { FailureReason } from '@agent-os/contracts';
import type { RuntimeTx, UpstreamTask } from '@agent-os/runtime';
import { callSubtreeSpentTokens } from '../model/ledger.js';
import { agentRunsRepository } from './agent-runs.repository.js';
import { CHILD_RESULT_REREAD } from './session-window.js';
import type { CallEnding, ToolCallRow } from './tool-calls.repository.js';
import { cutToFit, jsonBytes } from './tools/tool-context.js';

/** The closed list a parent reads a failed child by (design-agent-core.md, FR-05, DC-6). */
export type ChildFailedReason = 'budget_exhausted' | 'deadline' | 'turn_limit' | 'model_unavailable' | 'failed';

/**
 * The reason of `child_failed` from the child's failure (Error Handling): class `budget_exhausted` — `budget_exhausted`,
 * class `deadline` — `deadline`, code `turn_limit` — `turn_limit`, code `model_unavailable` — `model_unavailable`; any
 * other reason, `context_overflow`, `recovery_exhausted` and `internal` of the runtime among them, is `failed` (UC-E15).
 */
export function childFailedReason(failure: Pick<FailureReason, 'class' | 'code'> | null): ChildFailedReason {
  if (failure === null) return 'failed';
  if (failure.class === 'budget_exhausted') return 'budget_exhausted';
  if (failure.class === 'deadline') return 'deadline';
  if (failure.code === 'turn_limit') return 'turn_limit';
  if (failure.code === 'model_unavailable') return 'model_unavailable';
  return 'failed';
}

/** What the model reads with a child's result cut to the limit: how to read it whole. */
export const CHILD_RESULT_CUT_MARK = `[cut] Read the whole result of this run with ${CHILD_RESULT_REREAD}.`;

/**
 * A child's result as its parent's session gets it: whole within `maxBytes` — the `call_agent` result limit of the tool
 * registry — or, over it, the longest prefix of its JSON text that fits, with its whole size, the child's run and a
 * mark naming `investigation_read`, which reads the whole result in pieces by that run.
 */
export function childResultForSession(result: unknown, run: string, maxBytes: number): unknown {
  if (jsonBytes(result) <= maxBytes) return result;
  const bytes = jsonBytes(result);
  return cutToFit(JSON.stringify(result), maxBytes, (cut) => ({
    cut: true,
    bytes,
    run,
    mark: CHILD_RESULT_CUT_MARK,
    resultText: cut,
  }));
}

/**
 * How a `call_agent` call ends once its child's task is final (`waiting` → `done`, DC-5, DC-6): the child's result cut
 * to the limit, or `child_failed` with its reason; either way with the spend of the child's subtree by the ledger walk
 * of the share (KD-4), which the call row records.
 */
export async function childCallEnding(
  tx: RuntimeTx,
  call: Pick<ToolCallRow, 'id' | 'runTaskId'>,
  child: Pick<UpstreamTask, 'taskId' | 'status' | 'failure'>,
  resultMaxBytes: number,
): Promise<CallEnding> {
  const spentTokens = await callSubtreeSpentTokens(tx, call);
  if (child.status === 'succeeded') {
    const childRun = await agentRunsRepository.read(tx, child.taskId);
    return { to: 'done', outcome: 'success', result: childResultForSession(childRun?.result ?? null, child.taskId, resultMaxBytes), spentTokens };
  }
  const reason = childFailedReason(child.failure);
  return { to: 'done', outcome: 'tool_error', reason: 'child_failed', result: { child_failed: reason }, spentTokens };
}
