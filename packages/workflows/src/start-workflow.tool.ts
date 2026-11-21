import {
  type Agents,
  type InCommitAgentTool,
  logStart,
  START_WORKFLOW_TOOL,
  type StartRefusal,
  type StartResolution,
  WAITING_RULE,
} from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import { WORKFLOWS_BRIEF_CONFIRMATION } from '@agent-os/contracts';
import { z } from 'zod';

const BRIEF_FIELD_MAX = 4000;

/**
 * The three fields of a brief. The tool writes them as the coordinator's task (JSON) and `runs.get`
 * reads them back with this schema; `boundaries` and `result` may be empty but are always present.
 */
export const WorkflowBriefSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(BRIEF_FIELD_MAX)
    .describe('The question the workflow must answer, in the employee’s words'),
  boundaries: z
    .string()
    .max(BRIEF_FIELD_MAX)
    .describe('Boundaries of the work: systems, period, what to leave out; empty string if none'),
  result: z
    .string()
    .max(BRIEF_FIELD_MAX)
    .describe('What counts as the result: its form and contents; empty string if not stated'),
});
export type WorkflowBrief = z.infer<typeof WorkflowBriefSchema>;

/** Arguments of `start_workflow` (design-runtime.md, «Инструменты модели»). */
const StartWorkflowArgsSchema = WorkflowBriefSchema.extend({
  workflow: z.uuid().describe('The id of the workflow record to start, as the list below gives it'),
});
export type StartWorkflowArgs = z.infer<typeof StartWorkflowArgsSchema>;

/** What the employee is shown in the brief card: the workflow record and the three fields. */
type BriefConfirmationContent = StartWorkflowArgs;

export interface StartWorkflowToolOptions {
  /**
   * The one start procedure of `agents` (the coordinator's snapshot on behalf of the employee) and the
   * root launch-set rule `start_agent` applies (KD-4); the audit record of a refused model is written
   * through it only when that refusal is the call's outcome.
   */
  readonly agents: Pick<Agents, 'resolveStart' | 'auditStartRefusal' | 'rootMayStart'>;
  readonly logger: Logger;
}

/**
 * What `prepare` hands `execute`: the start procedure's answer, whether the chat may start the record
 * and when the start began (the log's duration).
 */
export interface PreparedWorkflowStart {
  readonly resolution: StartResolution;
  readonly inLaunchSet: boolean;
  readonly startedAt: number;
}

type WorkflowRefusalReason = StartRefusal['reason'] | 'not_allowed';

/** The tool's own text; at the root the registry appends the workflows the chat offers. */
const DESCRIPTION = [
  'Start a workflow on a brief. The call shows the employee the brief to confirm, edit or reject;',
  'the workflow starts only after the employee confirms it, and the result names its run id.',
].join('\n');

/** The brief as the coordinator's task: always the three fields, in this order. */
function briefJson({ question, boundaries, result }: WorkflowBrief): string {
  return JSON.stringify({ question, boundaries, result });
}

/**
 * `start_workflow` (design-runtime.md, KD-5, Flow 2): a root-only tool. `agents` asks the employee for a
 * decision on the brief; after a confirmation `prepare` resolves the workflow record of the confirmed
 * arguments through `resolveStart` on behalf of the employee and asks `rootMayStart` whether the chat
 * may start it, both before the commit (ADR-0017), and `execute` starts the coordinator as a child of the
 * caller on the snapshot of the whole team. A refusal is the call's result, in the order of `start_agent`
 * (plan Notes 2): the record is unavailable, then it is outside the chat's launch set (`not_allowed`,
 * AC-15.2), then its coordinator's model is not allowed, has no ready provider or is the default and
 * none is chosen; no coordinator starts. Only a refused model is audited.
 */
export function createStartWorkflowTool(
  options: StartWorkflowToolOptions,
): InCommitAgentTool<StartWorkflowArgs, PreparedWorkflowStart> {
  const { agents } = options;
  const logger = options.logger.child({ service: 'workflows.start' });

  return {
    name: START_WORKFLOW_TOOL,
    description: DESCRIPTION,
    argsSchema: StartWorkflowArgsSchema,
    mode: 'in_commit',
    rootOnly: true,
    // The brief stays out of the log.
    loggedArgs: ({ workflow }) => ({ workflow }),
    confirmation: {
      kind: WORKFLOWS_BRIEF_CONFIRMATION,
      editableArgs: true,
      content(args): BriefConfirmationContent {
        return {
          workflow: args.workflow,
          question: args.question,
          boundaries: args.boundaries,
          result: args.result,
        };
      },
    },
    async prepare({ args, caller }) {
      const startedAt = Date.now();
      const [resolution, inLaunchSet] = await Promise.all([
        agents.resolveStart({
          ownerId: caller.ownerId,
          source: { kind: 'record', recordId: args.workflow, expected: 'workflow' },
        }),
        agents.rootMayStart({ ownerId: caller.ownerId, recordId: args.workflow, kind: 'workflow' }),
      ]);
      return { resolution, inLaunchSet, startedAt };
    },
    async execute({ args, caller, startChild, prepared }) {
      if (prepared === undefined) {
        throw new Error(`start_workflow of agent ${caller.agentId} runs without its prepare`);
      }
      const { resolution, inLaunchSet } = prepared;
      // Logged as `start_agent` logs a start (design-runtime.md, «Логирование»); the brief stays out.
      const entry = {
        ownerId: caller.ownerId,
        rootId: caller.rootId,
        parentId: caller.agentId,
        source: 'record' as const,
        recordId: args.workflow,
        resolution,
        startedAt: prepared.startedAt,
      };
      const refuse = (reason: WorkflowRefusalReason, model: string | null) => {
        logStart(logger, { ...entry, agentId: null, refusal: reason });
        return {
          kind: 'refused' as const,
          reason,
          refusalDetail: model === null ? null : { model },
        };
      };
      if (resolution.kind === 'refused' && resolution.reason === 'record_unavailable') {
        return refuse(resolution.reason, null);
      }
      if (!inLaunchSet) return refuse('not_allowed', null);
      if (resolution.kind === 'refused') {
        await agents.auditStartRefusal(resolution);
        return refuse(resolution.reason, resolution.model);
      }

      const { snapshot } = resolution;
      const brief = briefJson(args);
      const { agentId } = await startChild({ snapshot, prompt: brief, description: args.question });
      logStart(logger, { ...entry, agentId, refusal: null });
      return {
        kind: 'done',
        outcome: 'success',
        text: `Workflow "${snapshot.name}" started in the background, run id ${agentId}. Confirmed brief: ${brief}\nIts answer will arrive as a message when it finishes. ${WAITING_RULE}`,
        childAgentId: agentId,
      };
    },
  };
}
