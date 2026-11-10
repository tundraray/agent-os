import { ResearchAnswerConfidenceSchema } from '@agent-os/contracts';
import { z } from 'zod';
import { firstMessageFits } from '../../agents/process-code.js';
import type {
  ClosureDecision,
  ClosureInput,
  CollectStep,
  ForcedEndFunction,
  FormRunContext,
  PrologueDecision,
  ResultForm,
} from '../../agents/result-forms.js';
import { envelope } from '../../agents/session-window.js';
import { composeAnswer, screenDraft } from '../../answer/reference-gateway.js';
import { buildResearchAnswer } from '../../answer/research-answer.builder.js';
import { WorkerOutputSchema } from '../../claims/claim.schema.js';
import { CODE_ANSWER_FORCED_END, type CodeAnswer, collectCodeAnswer, derivedIdsOf, writeCodeAnswer } from './code-answer-end.js';

/**
 * The draft answer of the answer agent (design-research-flow.md, Contract
 * `answer_draft`, KD-7). With sources the agent runs as a child, and its draft goes to the root's closure. Without sources
 * it is the root: its closure turns the draft into the answer, and nothing is verified. The run's depth tells the two
 * apart: the root runs at depth 0.
 */

const MODEL_KNOWLEDGE = 'model_knowledge';
const FIRST_MESSAGE_MAX_BYTES = 32_000;

const isRoot = (context: FormRunContext): boolean => context.depth === 0;

/**
 * The draft answer: `summaryClaimIds` is its choice of claims for the summary, most important first — it writes no
 * summary text (KD-4). A claim names the input claim it states by `claimId`, or is new (`claimId` null) with its atoms
 * and pointer, so it can be verified like a worker claim (AC-09.3).
 */
export const SynthesisOutputSchema = z.object({
  outcome: z.enum(['answered', 'partial', 'inconclusive']),
  summaryClaimIds: z.array(z.string()).describe('The claimIds of input claims for the summary, most important first'),
  claims: z.array(
    WorkerOutputSchema.shape.claims.element.extend({
      claimId: z.string().nullable().describe('The claimId of an input claim; null for a claim the answer adds'),
    }),
  ),
});

/** The claims of the packet: their status, the group of a supported one and the pointer a new claim may rest on (C3). */
function synthesisAssignment(claims: z.infer<typeof PacketClaimsSchema>): string {
  return JSON.stringify({
    claims: claims.map(({ claimId, status, confidence, text, pointer }) => ({ claimId, status, confidence, text, pointer })),
  });
}

const PacketClaimsSchema = z.array(
  z.object({
    claimId: z.string(),
    status: z.string(),
    confidence: ResearchAnswerConfidenceSchema.nullable(),
    text: z.string(),
    pointer: z.unknown(),
  }),
);

const PacketInputSchema = z.strictObject({
  kind: z.literal('packet'),
  claims: PacketClaimsSchema,
  /** The task of the calling agent; null at the root, whose assignment is the question the system block already holds. */
  callerTask: z.string().nullable(),
});
const OverflowInputSchema = z.strictObject({ kind: z.literal('overflow'), claimCount: z.number() });
const PrologueInputSchema = z.discriminatedUnion('kind', [PacketInputSchema, OverflowInputSchema]);

/** The packet of the claims; the goal, the question, the mode and the sections are fields of the agent's system block. */
function firstMessageOf({ claims, callerTask }: z.infer<typeof PacketInputSchema>): string {
  const packet = `<assignment>\n${synthesisAssignment(claims)}\n</assignment>`;
  return callerTask === null ? packet : [packet, envelope('caller task', 'agent', callerTask)].join('\n');
}

/** The prologue's input; a packet over the limit leaves only the count and the sign, so the run row stays small (DC-19). */
const collectPacket: CollectStep = async (context, reader) => {
  const claims = PacketClaimsSchema.parse(await reader.claims());
  const packet = { kind: 'packet' as const, claims, callerTask: isRoot(context) ? null : context.assignment };
  return firstMessageFits(firstMessageOf(packet), FIRST_MESSAGE_MAX_BYTES) ? packet : { kind: 'overflow', claimCount: claims.length };
};

function buildPrologue(raw: unknown): PrologueDecision {
  const input = PrologueInputSchema.parse(raw);
  return input.kind === 'overflow' ? { kind: 'end', result: { overflow: true } } : { kind: 'start', firstMessage: firstMessageOf(input) };
}

/** What a step at the root needs; null for a child, which reads nothing. */
const collectAtRoot: CollectStep = (context, reader) => (isRoot(context) ? collectCodeAnswer(context, reader) : Promise.resolve(null));

const RootCollectedSchema = z.object({ answerId: z.uuid(), goal: z.string(), engineRun: z.object({ launchKey: z.string() }) });

type AnsweredDraft = Extract<ClosureDecision, { kind: 'accept' }> & CodeAnswer;

const isAnsweredDraft = (decision: ClosureDecision): decision is AnsweredDraft => decision.kind === 'accept' && 'message' in decision;

/** The gateway in the mode `model_knowledge` (KD-7): every claim is assumed, marked as the model's knowledge. */
function answerOfDraft(result: unknown, collected: unknown): ClosureDecision {
  const { answerId, goal, engineRun } = RootCollectedSchema.parse(collected);
  const draft = SynthesisOutputSchema.parse(result);
  const screened = screenDraft({ sourceMode: MODEL_KNOWLEDGE, claims: draft.claims, known: new Map(), references: new Map() });
  // Ids of the claims of this answer, derived from its id; no claim row is written in this mode.
  const nextClaimId = derivedIdsOf(answerId);
  const composed = composeAnswer({
    sourceMode: MODEL_KNOWLEDGE,
    answerId,
    draft,
    screened,
    freshClaimIds: screened.fresh.map(() => nextClaimId()),
    verifyRoundsLeft: 0,
    removedClaimId: nextClaimId,
  });
  if (composed.outcome !== 'answer') throw new Error('an answer without sources goes to no verification');
  // Without sources the answer cites no page, so the message reads no page details.
  const message = buildResearchAnswer({ answer: composed.answer, goal, launchKey: engineRun.launchKey, sourceMode: MODEL_KNOWLEDGE, pages: new Map() });
  const answered: AnsweredDraft = { kind: 'accept', result: composed.answer, message };
  return answered;
}

function evaluateResult({ result, collected }: ClosureInput): ClosureDecision {
  return collected === null ? { kind: 'accept', result } : answerOfDraft(result, collected);
}

/** The root ends with the answer built by code; a child ends with its failure code. */
const atRootOnly = (rootEnd: ForcedEndFunction): ForcedEndFunction => ({
  collect: collectAtRoot,
  decide: (collected, bindings) => (collected === null ? { kind: 'none' } : rootEnd.decide(collected, bindings)),
  write: rootEnd.write,
});

export const ANSWER_DRAFT_FORM: ResultForm = {
  name: 'answer_draft',
  version: 1,
  resultSchema: SynthesisOutputSchema,
  onlyOn: 'modelKnowledgeRoot',
  toolsAllowed: ['finish'],
  prologue: { collect: collectPacket, build: buildPrologue, firstMessageMaxBytes: FIRST_MESSAGE_MAX_BYTES },
  closure: {
    collect: collectAtRoot,
    evaluate: evaluateResult,
    write: async (tx, context, decision) => {
      if (isAnsweredDraft(decision)) await writeCodeAnswer(tx, context, decision);
    },
  },
  forcedEnd: Object.fromEntries(Object.entries(CODE_ANSWER_FORCED_END).map(([code, rootEnd]) => [code, atRootOnly(rootEnd)])),
};
