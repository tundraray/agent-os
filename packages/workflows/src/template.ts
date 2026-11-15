import type { AgentDefinition, SessionLimits } from '@agent-os/agents';
import { z } from 'zod';

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FORBIDDEN_EXECUTOR_TOOL = 'start_workflow';
/**
 * Built-in tools of the coordinator: it starts its executors and forwards the employee's messages to
 * them. No `list_agents`: reports arrive on their own, and a real model polled with it until `turn_limit`.
 */
const COORDINATOR_TOOLS = ['start_agent', 'message_agent'];

const kebabName = z.string().regex(KEBAB_CASE, 'expected a kebab-case name');
const maxTurns = z.number().int().min(1).max(200);

const CoordinatorSchema = z
  .object({
    prompt: z.string().min(1),
    model: z.string().min(1).optional(),
    maxTurns,
  })
  .strict();

const ExecutorSchema = z
  .object({
    name: kebabName,
    description: z.string().min(1),
    prompt: z.string().min(1),
    tools: z.array(z.string().min(1)),
    mcpServers: z.array(z.string().min(1)),
    model: z.string().min(1).optional(),
    maxTurns,
    /** How many times the coordinator may start this executor. */
    maxRuns: z.number().int().min(1).max(20),
  })
  .strict();

const WorkflowTemplateSchema = z
  .object({
    name: kebabName,
    title: z.string().min(1),
    description: z.string().min(1),
    coordinator: CoordinatorSchema,
    agents: z.array(ExecutorSchema).min(1).max(10),
    finalAgent: z.string().min(1),
  })
  .strict()
  .superRefine((template, ctx) => {
    const seen = new Set<string>([template.name]);
    template.agents.forEach((executor, index) => {
      if (seen.has(executor.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['agents', index, 'name'],
          message: `name "${executor.name}" is used twice in the template`,
        });
      }
      seen.add(executor.name);
      const toolIndex = executor.tools.indexOf(FORBIDDEN_EXECUTOR_TOOL);
      if (toolIndex !== -1) {
        ctx.addIssue({
          code: 'custom',
          path: ['agents', index, 'tools', toolIndex],
          message: `an executor may not use "${FORBIDDEN_EXECUTOR_TOOL}"`,
        });
      }
    });
    if (!template.agents.some((executor) => executor.name === template.finalAgent)) {
      ctx.addIssue({
        code: 'custom',
        path: ['finalAgent'],
        message: `"${template.finalAgent}" is not an executor of the template`,
      });
    }
  });

/** A validated workflow template (design-workflows.md, KD-1). */
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

/** What lists and cards show of a template. */
export interface WorkflowTemplateHeader {
  readonly name: string;
  readonly title: string;
  readonly description: string;
}

function templateLabel(raw: unknown, index: number): string {
  if (typeof raw === 'object' && raw !== null && 'name' in raw && typeof raw.name === 'string') {
    return raw.name;
  }
  return `#${index}`;
}

/**
 * Parses the templates at start (DC-1); any invalid template, or two templates with one name,
 * stops the start with an error naming the template and the field path.
 */
export function parseTemplates(raws: readonly unknown[]): WorkflowTemplate[] {
  const names = new Set<string>();
  return raws.map((raw, index) => {
    const label = templateLabel(raw, index);
    const parsed = WorkflowTemplateSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue && issue.path.length > 0 ? issue.path.join('.') : '<root>';
      throw new Error(
        `workflow template "${label}" is invalid at ${path}: ${issue?.message ?? 'invalid'}`,
      );
    }
    if (names.has(parsed.data.name)) {
      throw new Error(
        `workflow template "${label}" is invalid at name: another template has the same name`,
      );
    }
    names.add(parsed.data.name);
    return parsed.data;
  });
}

/** The coordinator definition first, then one definition per executor. */
export function toDefinitions(template: WorkflowTemplate): AgentDefinition[] {
  const coordinator: AgentDefinition = {
    name: template.name,
    description: template.description,
    prompt: template.coordinator.prompt,
    tools: [...COORDINATOR_TOOLS],
    mcpServers: [],
    agents: template.agents.map((executor) => executor.name),
    maxTurns: template.coordinator.maxTurns,
    ...(template.coordinator.model === undefined ? {} : { model: template.coordinator.model }),
  };
  const executors = template.agents.map(
    ({ maxRuns: _maxRuns, ...executor }): AgentDefinition => ({ ...executor, agents: [] }),
  );
  return [coordinator, ...executors];
}

/** Limits the coordinator session starts with (design-workflows.md, KD-2). */
export function toLimits(template: WorkflowTemplate): SessionLimits {
  return {
    agents: Object.fromEntries(
      template.agents.map((executor) => [executor.name, executor.maxRuns]),
    ),
    finalAgent: template.finalAgent,
  };
}
