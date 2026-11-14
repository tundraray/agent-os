import type { AgentStatus, TaskStatus, WaitReason } from '@agent-os/contracts';
import type { Task } from '@agent-os/runtime';

export interface AgentStatusInput {
  readonly taskStatus: TaskStatus;
  readonly waitReason: WaitReason | null;
  /** An `interrupt` message without text waits in the agent's inbox. */
  readonly pendingInterruptWithoutText: boolean;
  /** The session's mark «прерван». */
  readonly sessionInterrupted: boolean;
}

/**
 * The status of an agent for the employee (State Transitions, KD-3): «Прерван» is seen at once from a
 * pending `interrupt` without text, and after the step took it, from the session's mark.
 */
export function agentStatus(input: AgentStatusInput): AgentStatus {
  switch (input.taskStatus) {
    case 'completed':
    case 'failed':
    case 'stopped':
      return input.taskStatus;
    case 'queued':
    case 'running':
      return input.pendingInterruptWithoutText ? 'interrupted' : 'working';
    case 'waiting':
      return waitingStatus(input);
  }
}

function waitingStatus(input: AgentStatusInput): AgentStatus {
  if (input.waitReason === 'decision') return 'awaiting_confirmation';
  // Agents always interrupt with a message (KD-3); the runtime's own reason is shown the same way.
  if (input.waitReason === 'interrupted') return 'interrupted';
  return input.sessionInterrupted ? 'interrupted' : 'working';
}

/** The fields of an agent's session the view reads; the `agent_sessions` row has them. */
export interface AgentViewSession {
  readonly definition: string;
  readonly description: string;
  readonly model: string;
  readonly interrupted: boolean;
  readonly forkedFromTaskId: string | null;
  readonly forkedThroughSeq: number | null;
}

/** An agent as the operations return it (design-agents.md, AgentView); no tokens and no cost. */
export interface AgentView {
  readonly agentId: string;
  readonly parentId: string | null;
  readonly rootId: string;
  readonly depth: number;
  readonly definition: string;
  readonly description: string;
  readonly model: string;
  readonly status: AgentStatus;
  /** Set when `failed`: `turn_limit`, `model_error` or the runtime's reason. */
  readonly failureReason: string | null;
  /** Set for a fork: the parent's history through `throughSeq` precedes this one. */
  readonly forkedFrom: { readonly agentId: string; readonly throughSeq: number } | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

/** The view of an agent from its runtime task and its session. */
export function toAgentView(
  task: Task,
  session: AgentViewSession,
  pendingInterruptWithoutText: boolean,
): AgentView {
  const status = agentStatus({
    taskStatus: task.status,
    waitReason: task.waitReason,
    pendingInterruptWithoutText,
    sessionInterrupted: session.interrupted,
  });
  return {
    agentId: task.taskId,
    parentId: task.parentId,
    rootId: task.rootId,
    depth: task.depth,
    definition: session.definition,
    description: session.description,
    model: session.model,
    status,
    failureReason: status === 'failed' ? (task.failure?.reason ?? null) : null,
    forkedFrom:
      session.forkedFromTaskId !== null && session.forkedThroughSeq !== null
        ? { agentId: session.forkedFromTaskId, throughSeq: session.forkedThroughSeq }
        : null,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
  };
}
