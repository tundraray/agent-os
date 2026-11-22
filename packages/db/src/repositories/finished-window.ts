import type { ToolOutcome } from '@agent-os/contracts';
import { and, gt, isNotNull, lte, type SQL } from 'drizzle-orm';
import type { agentCodeCalls, agentMessages } from '../schema';

/** Calls that finished in (`after`, `through`]; `after` null — no lower bound. */
export interface FinishedWindow {
  readonly after: Date | null;
  readonly through: Date;
}

/** A finished MCP call of some tasks: what both tables of calls give a reader of many sessions. */
export interface FinishedMcpCall<O extends ToolOutcome> {
  readonly server: string;
  readonly tool: string;
  readonly outcome: O;
  readonly args: unknown;
  readonly finishedAt: Date;
}

/** `finished_at` within the window, for either table of calls. */
export function finishedIn(
  finishedAt: typeof agentMessages.finishedAt | typeof agentCodeCalls.finishedAt,
  window: FinishedWindow,
): SQL | undefined {
  return and(
    isNotNull(finishedAt),
    lte(finishedAt, window.through),
    window.after === null ? undefined : gt(finishedAt, window.after),
  );
}
