import { z } from 'zod';
import { DECISION_KINDS, type DecisionKind } from '../config/capabilities.js';
import { ModelArgsSchema } from '../model/model-args.js';

/** Longest `rationale` a decision may carry (design-engine.md, Decision). */
const RATIONALE_MAX_CHARS = 2_000;

/** How much of the matches a source request needs: every page (`all`) or the first ones (`sample`). */
const COMPLETENESS = ['all', 'sample'] as const;

const fetchRequest = {
  sourceId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  completeness: z.enum(COMPLETENESS),
};

const SubquestionSchema = z.object({ text: z.string().min(1), ...fetchRequest });

/**
 * What the controller model is asked to return: one object with `kind`, `rationale` and the optional fields of every
 * decision. `kind` is any string here on purpose: a kind outside the closed set must reach `DecisionGate`, which records
 * it as a refusal with its reason (DC-2), instead of being retried away by `ModelGateway` as an invalid output. `args`
 * is JSON text ({@link ModelArgsSchema}): `DecisionGate` parses it, and the recorded decision keeps the object.
 */
/** Where a field of the flat controller output belongs: the model reads it in the schema it answers to. */
const FIELD_GUIDE = {
  kind: `One of: ${DECISION_KINDS.join(', ')}; only a kind listed as admissible in the input is accepted. The kind decides which other fields are filled; leave the fields of other kinds out`,
  rationale: 'Every kind: why this decision, briefly',
  evidenceIds: 'Any kind, optional: evidence ids from the input the decision rests on',
  await: 'requestEvidence, requestAnalysis, requestVerification only, optional: wait for the created tasks before the next step (true by default)',
  sourceId: 'requestEvidence only (top level): sourceId of one pair from tools in the input. For requestAnalysis put it inside each subquestion instead',
  toolName: 'requestEvidence only (top level): toolName of the same pair from tools in the input',
  args: "requestEvidence only (top level): the tool arguments as one JSON object written as a string, matching that tool's argsSchema in tools",
  completeness: 'requestEvidence only (top level): all — every matching record, sample — the first page is enough',
  subquestions:
    'requestAnalysis only: the sub-questions, each with its own text and one source request (sourceId, toolName, args, completeness). Never use it for requestEvidence',
  subquestionText: 'The sub-question one worker answers from the records of its request',
  subquestionSourceId: 'sourceId of one pair from tools in the input',
  subquestionToolName: 'toolName of the same pair from tools in the input',
  subquestionArgs: "The tool arguments as one JSON object written as a string, matching that tool's argsSchema in tools",
  subquestionCompleteness: 'all — every matching record, sample — the first page is enough',
  claimIds: 'requestVerification only: claimIds from the input to verify',
  reason: 'replan only: what in the observations makes the current plan wrong',
} as const;

export const ControllerOutputSchema = z.object({
  kind: z.string().describe(FIELD_GUIDE.kind),
  rationale: z.string().describe(FIELD_GUIDE.rationale),
  evidenceIds: z.array(z.string()).optional().describe(FIELD_GUIDE.evidenceIds),
  await: z.boolean().optional().describe(FIELD_GUIDE.await),
  sourceId: z.string().optional().describe(FIELD_GUIDE.sourceId),
  toolName: z.string().optional().describe(FIELD_GUIDE.toolName),
  args: ModelArgsSchema.describe(FIELD_GUIDE.args).optional(),
  completeness: z.enum(COMPLETENESS).optional().describe(FIELD_GUIDE.completeness),
  subquestions: z
    .array(
      z.object({
        text: z.string().describe(FIELD_GUIDE.subquestionText),
        sourceId: z.string().describe(FIELD_GUIDE.subquestionSourceId),
        toolName: z.string().describe(FIELD_GUIDE.subquestionToolName),
        args: ModelArgsSchema.describe(FIELD_GUIDE.subquestionArgs),
        completeness: z.enum(COMPLETENESS).describe(FIELD_GUIDE.subquestionCompleteness),
      }),
    )
    .optional()
    .describe(FIELD_GUIDE.subquestions),
  claimIds: z.array(z.string()).optional().describe(FIELD_GUIDE.claimIds),
  reason: z.string().optional().describe(FIELD_GUIDE.reason),
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
