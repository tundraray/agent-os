import type { AgentStatus, RunOrigin, TaskStatus, WaitReason } from '@agent-os/contracts';
import type { Task } from '@agent-os/runtime';

import type { Session } from './store/sessions.repository';

export interface AgentStatusInput {
  readonly taskStatus: TaskStatus;
  readonly waitReason: WaitReason | null;
  /** An `interrupt` message waits in the agent's inbox. */
  readonly pendingInterrupt: boolean;
  /** The session's mark «прерван». */
  readonly sessionInterrupted: boolean;
}

/**
 * The status of an agent for the employee (State Transitions, KD-3): «Прерван» is seen at once from a
 * pending `interrupt`, and after the step took it, from the session's mark.
 */
export function agentStatus(input: AgentStatusInput): AgentStatus {
  switch (input.taskStatus) {
    case 'completed':
    case 'failed':
    case 'stopped':
      return input.taskStatus;
    case 'queued':
    case 'running':
      return input.pendingInterrupt ? 'interrupted' : 'working';
    case 'waiting':
      // Agents always interrupt with an `interrupt` message (KD-3), so the runtime's own `interrupted` reason never occurs.
      if (input.waitReason === 'decision') return 'awaiting_confirmation';
      return input.sessionInterrupted ? 'interrupted' : 'working';
  }
}

/** An agent as the operations return it (design-agents.md, AgentView); no tokens and no cost. */
export interface AgentView {
  readonly agentId: string;
  readonly parentId: string | null;
  readonly rootId: string;
  readonly depth: number;
  /** The run's name from its snapshot. */
  readonly name: string;
  /**
   * The record the run started from; `null` for a root, which the employee sees as the conversation
   * itself and not as a run of a record (its session row does carry the builtin record `chat`).
   */
  readonly origin: RunOrigin | null;
  /** The owner had no earlier session with this record. */
  readonly firstRun: boolean;
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
export function toAgentView(task: Task, session: Session, pendingInterrupt: boolean): AgentView {
  const status = agentStatus({
    taskStatus: task.status,
    waitReason: task.waitReason,
    pendingInterrupt,
    sessionInterrupted: session.interrupted,
  });
  return {
    agentId: task.taskId,
    parentId: task.parentId,
    rootId: task.rootId,
    depth: task.depth,
    name: session.name,
    origin: task.parentId === null ? null : session.origin,
    firstRun: session.firstRun,
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
