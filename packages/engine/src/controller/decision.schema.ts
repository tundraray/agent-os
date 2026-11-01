import { z } from 'zod';
import { DECISION_KINDS, type DecisionKind } from '../config/capabilities.js';

/** Longest `rationale` a decision may carry (design-engine.md, Decision). */
const RATIONALE_MAX_CHARS = 2_000;

const fetchRequest = {
  sourceId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  completeness: z.enum(['all', 'sample']),
};

const SubquestionSchema = z.object({ text: z.string().min(1), ...fetchRequest });

/**
 * What the controller model is asked to return: one object with `kind`, `rationale` and the optional fields of every
 * decision. `kind` is any string here on purpose: a kind outside the closed set must reach `DecisionGate`, which records
 * it as a refusal with its reason (DC-2), instead of being retried away by `ModelGateway` as an invalid output.
 */
export const ControllerOutputSchema = z.object({
  kind: z.string().describe(`One of: ${DECISION_KINDS.join(', ')}; only a kind listed as admissible in the input is accepted`),
  rationale: z.string(),
  evidenceIds: z.array(z.string()).optional(),
  await: z.boolean().optional(),
  sourceId: z.string().optional(),
  toolName: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  completeness: z.string().optional(),
  subquestions: z.array(z.object({ text: z.string(), ...fetchRequest, completeness: z.string() })).optional(),
  claimIds: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

const common = {
  rationale: z.string().max(RATIONALE_MAX_CHARS),
  evidenceIds: z.array(z.uuid()).default([]),
};
/** `await` of a decision that creates tasks: wait for them before the next step, true by default. */
const awaitTasks = { await: z.boolean().default(true) };

/** The decisions of design-engine.md, Decision, checked field by field after the kind is known. */
export const DecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('requestEvidence'), ...common, ...awaitTasks, ...fetchRequest }),
  z.object({ kind: z.literal('requestAnalysis'), ...common, ...awaitTasks, subquestions: z.array(SubquestionSchema).min(1) }),
  z.object({ kind: z.literal('requestVerification'), ...common, ...awaitTasks, claimIds: z.array(z.uuid()).min(1) }),
  z.object({ kind: z.literal('replan'), ...common, reason: z.string().min(1) }),
  z.object({ kind: z.literal('wait'), ...common }),
  z.object({ kind: z.literal('proposeAnswer'), ...common, ...awaitTasks }),
  z.object({ kind: z.literal('concludeInconclusive'), ...common }),
]);
export type Decision = z.infer<typeof DecisionSchema>;

/** Decisions that create tasks: admissible only while more than the runtime's minimal task deadline is left. */
export const TASK_CREATING_KINDS: ReadonlySet<DecisionKind> = new Set([
  'requestEvidence',
  'requestAnalysis',
  'requestVerification',
  'proposeAnswer',
]);

export function isDecisionKind(kind: string): kind is DecisionKind {
  return (DECISION_KINDS as readonly string[]).includes(kind);
}
