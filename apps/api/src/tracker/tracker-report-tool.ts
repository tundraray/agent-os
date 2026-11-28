import type { InCommitAgentTool } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import {
  TRACKER_REPORT_TOOL,
  type TrackerReportArgs,
  TrackerReportArgsSchema,
} from '@agent-os/contracts';
import type { TrackerService } from './tracker.service';

/** What the model reads of the tool (KD-4, Risks: told apart from the tools of an MCP server `tracker`). */
const DESCRIPTION = [
  "Report on the employee's tracker task this conversation was opened for: it writes to that task only, no other.",
  'Pass a comment on how the work goes, a status, or both.',
  'Status in_review when the work is done; needs_decision when the employee must decide something.',
  'When you started an agent for the task, carry its result over to the task with this call.',
].join('\n');

const REPORTED_TEXT = 'Written on the task.';
const DELETED_TEXT =
  'The employee deleted the task of this conversation, so nothing was written.';
const CLOSED_TEXT =
  'The employee has closed the task, so its status was not changed.';

/**
 * `tracker_report` (task-tracker design-server.md, «Инструмент `tracker_report`», Flow 2): declared only by the chat
 * of a conversation a delegation opened (KD-4), `in_commit` — its rows commit with its `tool_result` in the step's
 * commit, so a step repeated after a restart writes once. The task comes from the link of the caller's
 * conversation. The log carries the status and the comment's length, never its text (Security Considerations).
 */
export function createTrackerReportTool(deps: {
  readonly tracker: Pick<TrackerService, 'report'>;
  readonly logger: Logger;
}): InCommitAgentTool<TrackerReportArgs> {
  const logger = deps.logger.child({ service: 'tracker.report' });
  return {
    name: TRACKER_REPORT_TOOL,
    description: DESCRIPTION,
    argsSchema: TrackerReportArgsSchema,
    mode: 'in_commit',
    loggedArgs: ({ status, comment }) => ({
      status,
      commentLength: comment?.length,
    }),
    async execute({ args, caller, callId }) {
      const startedAt = Date.now();
      const { outcome, taskId } = await deps.tracker.report(
        caller.rootId,
        args,
      );
      logger.info('tracker report', {
        ownerId: caller.ownerId,
        agentId: caller.agentId,
        conversationId: caller.rootId,
        callId,
        taskId,
        status: args.status,
        commentLength: args.comment?.length,
        outcome,
        durationMs: Date.now() - startedAt,
      });
      if (outcome === 'reported')
        return { kind: 'done', outcome: 'success', text: REPORTED_TEXT };
      return {
        kind: 'refused',
        reason: 'invalid_arguments',
        text:
          outcome === 'task_deleted'
            ? DELETED_TEXT
            : args.comment === undefined
              ? CLOSED_TEXT
              : `${CLOSED_TEXT} The comment was written.`,
      };
    },
  };
}
