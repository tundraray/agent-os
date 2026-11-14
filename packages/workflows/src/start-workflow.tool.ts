import { type InCommitAgentTool, WAITING_RULE } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import { z } from 'zod';

import { toLimits, type WorkflowTemplate } from './template.js';

export const START_WORKFLOW_TOOL = 'start_workflow';
/** Decision kind of the brief confirmation (design-workflows.md, «Инструмент `start_workflow`»). */
export const BRIEF_CONFIRMATION_KIND = 'workflows.brief';

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

export interface StartWorkflowArgs extends WorkflowBrief {
  readonly template: string;
}

/** What the employee is shown in the brief card. */
export interface BriefConfirmationContent extends WorkflowBrief {
  readonly title: string;
}

export interface StartWorkflowToolOptions {
  readonly templates: readonly WorkflowTemplate[];
  readonly logger: Logger;
}

function argsSchemaOf(names: readonly string[]): z.ZodType<StartWorkflowArgs> {
  const [first, ...rest] = names;
  if (first === undefined) throw new Error('start_workflow needs at least one workflow template');
  return WorkflowBriefSchema.extend({
    template: z.enum([first, ...rest]).describe('Name of the workflow template to start'),
  });
}

function describeStartWorkflow(templates: readonly WorkflowTemplate[]): string {
  return [
    'Start a workflow on a brief. The call shows the employee the brief to confirm, edit or reject;',
    'the workflow starts only after the employee confirms it, and the result names its run id.',
    'Workflow templates:',
    ...templates.map((template) => `- ${template.name} — ${template.title}: ${template.description}`),
  ].join('\n');
}

/** The brief as the coordinator's task: always the three fields, in this order. */
function briefJson({ question, boundaries, result }: WorkflowBrief): string {
  return JSON.stringify({ question, boundaries, result });
}

/**
 * `start_workflow` (design-workflows.md, KD-3, Flow 1): `agents` asks the employee for a decision on the
 * brief and runs `execute` only after a confirmation, in the commit transaction of the step, with the
 * arguments of the decision. The coordinator starts as a child of the caller with the template's limits.
 */
export function createStartWorkflowTool(
  options: StartWorkflowToolOptions,
): InCommitAgentTool<StartWorkflowArgs> {
  const { templates, logger } = options;
  const byName = new Map(templates.map((template) => [template.name, template]));

  function templateOf(name: string): WorkflowTemplate {
    const template = byName.get(name);
    if (template === undefined) throw new Error(`Workflow template ${name} is not in the catalog`);
    return template;
  }

  return {
    name: START_WORKFLOW_TOOL,
    title: 'Запустить workflow',
    argLabels: { template: 'Шаблон', question: 'Вопрос', boundaries: 'Границы', result: 'Результат' },
    description: describeStartWorkflow(templates),
    argsSchema: argsSchemaOf(templates.map((template) => template.name)),
    mode: 'in_commit',
    confirmation: {
      kind: BRIEF_CONFIRMATION_KIND,
      editableArgs: true,
      content(args): BriefConfirmationContent {
        return {
          title: templateOf(args.template).title,
          question: args.question,
          boundaries: args.boundaries,
          result: args.result,
        };
      },
    },
    async execute({ args, caller, startChild }) {
      const template = templateOf(args.template);
      const brief = briefJson(args);
      const { agentId } = await startChild({
        definition: template.name,
        prompt: brief,
        description: args.question,
        limits: toLimits(template),
      });
      logger.info('workflow started', {
        ownerId: caller.ownerId,
        parentId: caller.agentId,
        runId: agentId,
        template: template.name,
        brief,
      });
      return {
        kind: 'done',
        outcome: 'success',
        text: `Workflow "${template.name}" started in the background, run id ${agentId}. Confirmed brief: ${brief}\nIts answer will arrive as a message when it finishes. ${WAITING_RULE}`,
        childAgentId: agentId,
      };
    },
  };
}
