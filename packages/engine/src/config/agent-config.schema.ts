import { z } from 'zod';
import { findPromptTemplateFault } from './prompt-template.js';

/** A configuration the loader or an engine-creation check refuses (AC-12.2); `path` points at the faulty field. */
export interface ProcessConfigRejection {
  readonly code: 'process_config_rejected';
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** The tool every definition has without naming it: it returns the run's result (design-agent-core.md). */
const FINISH_TOOL = 'finish';
/** The tool a definition must name to call the agents of its `calls`. */
const CALL_AGENT_TOOL = 'call_agent';

const count = z.number().int().nonnegative();
const positive = z.number().int().positive();
/** An agent or tool name: 1–40 Latin letters, digits, `-` and `_`. */
const name = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

const uniqueNames = z.array(name).superRefine((items, context) => {
  items.forEach((item, index) => {
    if (items.indexOf(item) !== index) {
      context.addIssue({ code: 'custom', message: `${item} is repeated`, path: [index] });
    }
  });
});

/** The closed field list of a definition's prompt (ADR-0009, KD-9). */
const promptTemplate = z
  .string()
  .min(1)
  .superRefine((template, context) => {
    const fault = findPromptTemplateFault(template);
    if (fault !== null) {
      context.addIssue({ code: 'custom', message: fault });
    }
  });

const DefinitionLimitsSchema = z
  .strictObject({
    maxTurns: z.number().int().min(1).max(64),
    maxCallsPerTurn: z.number().int().min(1).max(16),
    maxChildren: z.number().int().min(0).max(32),
    /** The share the run asks of its parent (KD-4); at least one turn of its own. */
    runTokens: positive,
    deadlineMs: z.number().int().min(1_000).max(3_600_000),
    windowTokens: positive,
    marginTokens: count,
    maxOutputTokens: positive,
  })
  .refine((limits) => limits.runTokens >= limits.windowTokens + limits.maxOutputTokens, {
    message: 'runTokens is less than one turn (windowTokens + maxOutputTokens)',
    path: ['runTokens'],
  });

const AgentDefinitionSchema = z.strictObject({
  /** `provider/model`, a key of the model catalog. */
  model: z.string().regex(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  prompt: promptTemplate,
  /** Names from the engine's tool registry; `finish` is every definition's and is not listed. */
  tools: uniqueNames.refine((tools) => !tools.includes(FINISH_TOOL), {
    message: `${FINISH_TOOL} is given to every definition and is not listed`,
  }),
  /** Definitions this agent may call; a non-empty list requires `call_agent` in `tools`. */
  calls: uniqueNames.default([]),
  /** A subset of the process's `sourceId`s; without it the run inherits its parent's sources. */
  sources: z.array(z.string().min(1)).optional(),
  /** A form of the engine's result-form registry; the base form is `text`. */
  result: name,
  limits: DefinitionLimitsSchema,
});

/**
 * A source id or a source tool name: what `gather` accepts, nothing a path or a query could hide in. The load refuses
 * any other, so no source stands in `{{sources}}` that every `gather` would refuse.
 */
export const SourceNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

/**
 * A process configuration (KD-7, ADR-0009): data only, unknown keys are refused, and a file without `agents` does not
 * load.
 */
export const AgentProcessConfigSchema = z.strictObject({
  processId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  version: positive,
  goal: z.string().min(1),
  sources: z.array(z.strictObject({ sourceId: SourceNameSchema, toolName: SourceNameSchema })),
  agents: z
    .record(name, AgentDefinitionSchema)
    .refine((agents) => Object.keys(agents).length >= 1 && Object.keys(agents).length <= 16, {
      message: 'agents holds 1 to 16 definitions',
    }),
  rootAgent: name,
  /** The root in the mode without sources (DC-22). */
  modelKnowledgeRoot: name.optional(),
  agentLimits: z.strictObject({ maxDepth: z.number().int().min(1).max(5) }),
  limits: z.strictObject({
    investigationTokens: z
      .strictObject({ default: positive, max: positive })
      .refine((tokens) => tokens.default <= tokens.max, { message: 'default exceeds max', path: ['default'] }),
    maxTasks: positive,
    maxToolCalls: positive,
  }),
  answer: z.strictObject({
    sections: z
      .array(z.enum(['summary', 'established', 'assumed', 'unknown', 'removed']))
      .min(1)
      .superRefine((sections, context) => {
        sections.forEach((section, index) => {
          if (sections.indexOf(section) !== index) {
            context.addIssue({ code: 'custom', message: `${section} is repeated`, path: [index] });
          }
        });
      }),
  }),
});

export type AgentProcessConfig = z.infer<typeof AgentProcessConfigSchema>;
export type AgentDefinition = AgentProcessConfig['agents'][string];

/** Timings the load checks a definition's `deadlineMs` against (DC-1, DC-27); they come from `createEngine`. */
export interface AgentTimings {
  /** `AGENT_TURN_MS`. */
  readonly turnMs: number;
  /** `AGENT_DEADLINE_MARGIN_MS`. */
  readonly deadlineMarginMs: number;
}

function rejectAgent(agentName: string, field: readonly (string | number)[], message: string): ProcessConfigRejection {
  return {
    code: 'process_config_rejected',
    path: ['agents', agentName, ...field],
    message: `agent ${agentName}: ${message}`,
  };
}

function checkDefinition(
  agentName: string,
  definition: AgentDefinition,
  context: { readonly config: AgentProcessConfig; readonly timings: AgentTimings },
): ProcessConfigRejection | null {
  const { config, timings } = context;
  for (const [index, callee] of definition.calls.entries()) {
    if (!Object.hasOwn(config.agents, callee)) {
      return rejectAgent(agentName, ['calls', index], `calls ${callee}, which is not among agents`);
    }
  }
  if (definition.calls.length > 0 && !definition.tools.includes(CALL_AGENT_TOOL)) {
    return rejectAgent(agentName, ['tools'], `calls agents without ${CALL_AGENT_TOOL} in tools`);
  }
  const processSources = new Set(config.sources.map((source) => source.sourceId));
  for (const [index, sourceId] of (definition.sources ?? []).entries()) {
    if (!processSources.has(sourceId)) {
      return rejectAgent(agentName, ['sources', index], `source ${sourceId} is not a source of the process`);
    }
  }
  const leastDeadlineMs = timings.deadlineMarginMs + timings.turnMs;
  if (definition.limits.deadlineMs <= leastDeadlineMs) {
    return rejectAgent(
      agentName,
      ['limits', 'deadlineMs'],
      `deadlineMs ${definition.limits.deadlineMs} leaves no turn: ` +
        `it must exceed AGENT_DEADLINE_MARGIN_MS + AGENT_TURN_MS = ${leastDeadlineMs}`,
    );
  }
  return null;
}

/**
 * The checks of a parsed agents form that cross definitions (DC-1 without the registries): callees, `rootAgent` and
 * `modelKnowledgeRoot` exist among `agents`, a definition's sources are the process's, `calls` needs `call_agent`, and
 * `deadlineMs` leaves room for a turn. The first fault names the agent and the field.
 */
export function checkAgentReferences(config: AgentProcessConfig, timings: AgentTimings): ProcessConfigRejection | null {
  for (const key of ['rootAgent', 'modelKnowledgeRoot'] as const) {
    const agentName = config[key];
    if (agentName !== undefined && !Object.hasOwn(config.agents, agentName)) {
      return { code: 'process_config_rejected', path: [key], message: `${key} ${agentName} is not among agents` };
    }
  }
  for (const [agentName, definition] of Object.entries(config.agents)) {
    const fault = checkDefinition(agentName, definition, { config, timings });
    if (fault !== null) {
      return fault;
    }
  }
  return null;
}
