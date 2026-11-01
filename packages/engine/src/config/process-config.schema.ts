import { z } from 'zod';
import { CAPABILITIES } from './capabilities.js';
import type { ModelCatalog } from './model-catalog.js';
import { findPromptTemplateFault } from './prompt-template.js';

/** A configuration the loader or an engine-creation check refuses (AC-12.2); `path` points at the faulty field. */
export interface ProcessConfigRejection {
  readonly code: 'process_config_rejected';
  readonly path: readonly (string | number)[];
  readonly message: string;
}

const count = z.number().int().nonnegative();
const positive = z.number().int().positive();

const uniqueItems = (items: readonly string[], context: z.RefinementCtx): void => {
  items.forEach((item, index) => {
    if (items.indexOf(item) !== index) {
      context.addIssue({ code: 'custom', message: `${item} is repeated`, path: [index] });
    }
  });
};

const promptTemplate = z
  .string()
  .min(1)
  .superRefine((template, context) => {
    const fault = findPromptTemplateFault(template);
    if (fault !== null) {
      context.addIssue({ code: 'custom', message: fault });
    }
  });

const RoleSchema = z.strictObject({
  /** `provider/model`, a key of the model catalog. */
  model: z.string().regex(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  maxOutputTokens: positive,
  /** Input token budget of the role's packet (AC-06.1, AC-06.3). */
  windowTokens: positive,
  /** Margin for the provider's count drift; the call reserves counted input + margin + maxOutputTokens. */
  marginTokens: count,
  prompt: promptTemplate,
});

const LimitsSchema = z.strictObject({
  maxSteps: positive,
  maxPlanRevisions: count,
  /** K of AC-03.1. */
  noveltyWindow: positive,
  maxDecisionRetries: count,
  maxFanOut: positive,
  maxVerifyRounds: count,
  deadlineMarginMs: positive,
  investigationTokens: z
    .strictObject({ default: positive, max: positive })
    .refine((tokens) => tokens.default <= tokens.max, { message: 'default exceeds max', path: ['default'] }),
  maxTasks: positive,
  maxToolCalls: positive,
  /** The configurable part of the budgets of the tasks the engine proposes; the rest is derived by the engine. */
  taskBudgets: z.strictObject({
    'research.controller': z.strictObject({ deadlineMs: z.number().int().min(1_000).max(3_600_000) }),
    'source.fetch': z.strictObject({ maxToolCalls: positive, maxRetries: count }),
  }),
});

/** The single definition of a research process (KD-1, ADR-0005): data only, unknown keys are refused. */
export const ProcessConfigSchema = z.strictObject({
  processId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  version: positive,
  goal: z.string().min(1),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1).superRefine(uniqueItems),
  sources: z.array(z.strictObject({ sourceId: z.string().min(1), toolName: z.string().min(1) })),
  roles: z.strictObject({
    plan: RoleSchema,
    controller: RoleSchema,
    worker: RoleSchema,
    verifier: RoleSchema,
    synthesis: RoleSchema,
  }),
  limits: LimitsSchema,
  answer: z.strictObject({
    /** Sections of the answer in their order. */
    sections: z
      .array(z.enum(['summary', 'established', 'assumed', 'unknown', 'removed']))
      .min(1)
      .superRefine(uniqueItems),
  }),
});

export type ProcessConfig = z.infer<typeof ProcessConfigSchema>;

/** Every role model must have a catalog entry, or its calls could not be priced (createEngine contract). */
export function checkRoleModels(config: ProcessConfig, catalog: ModelCatalog): ProcessConfigRejection | null {
  for (const [roleName, roleConfig] of Object.entries(config.roles)) {
    if (!Object.hasOwn(catalog, roleConfig.model)) {
      return {
        code: 'process_config_rejected',
        path: ['roles', roleName, 'model'],
        message: `${roleConfig.model} is not in the model catalog`,
      };
    }
  }
  return null;
}
