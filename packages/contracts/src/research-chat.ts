import { z } from "zod";
import { InvestigationSpecSchema, ProvenanceSchema } from "./research.js";

/**
 * Contracts of deep research started from a chat thread (design-chat-entry.md, Contract Definitions).
 * Confirm and decline travel as a `POST /api/chat` turn with message metadata (KD-2); a stop has its own route
 * (design-lifecycle.md, KD-4).
 */

/** Keys of the message metadata the part reads and writes; server and web use these, never string literals. */
export const RESEARCH_METADATA_KEYS = {
  /** On a user message: the user turned the deep research mode on for it. */
  deepResearch: "deepResearch",
  /** On a hidden user message: a decision of a launch card. */
  researchDecision: "researchDecision",
  /** On the hidden assistant reply of a decision turn. */
  researchDecisionReply: "researchDecisionReply",
  /** On the assistant message that carries a research answer. */
  researchAnswer: "researchAnswer",
} as const;

/** The key of a launch: the id of its card's `deepResearch` call (KD-1); also the `:launchKey` of the stop route. */
export const LaunchKeySchema = z.string().min(1).max(200);
const MessageIdSchema = z.string().min(1).max(255);

/** Where the investigation takes its facts from: the connected sources, or the model's own knowledge (KD-8). */
export const ResearchSourceModeSchema = z.enum(["sources", "model_knowledge"]);
export type ResearchSourceMode = z.infer<typeof ResearchSourceModeSchema>;

// ---------------------------------------------------------------------------
// Message metadata
// ---------------------------------------------------------------------------

/** Value of `deepResearch` on a user message. */
export const DeepResearchMetadataSchema = z.literal(true);

/** Value of `researchDecision` on a user message: the card's action on one launch. */
export const ResearchDecisionSchema = z.object({
  action: z.enum(["confirm", "decline", "stop"]),
  launchKey: LaunchKeySchema,
});
export type ResearchDecision = z.infer<typeof ResearchDecisionSchema>;

/** Value of `researchDecisionReply` on the assistant reply of a decision turn. */
export const ResearchDecisionReplySchema = z.object({
  launchKey: LaunchKeySchema,
});
export type ResearchDecisionReply = z.infer<typeof ResearchDecisionReplySchema>;

/** Confidence group of an accepted claim (design-engine.md, KD-5); with three groups `very_high` is unused. */
export const ResearchAnswerConfidenceSchema = z.enum(["very_high", "high", "medium", "low"]);
export type ResearchAnswerConfidence = z.infer<typeof ResearchAnswerConfidenceSchema>;

/**
 * A claim of the answer. `confidence` is the group of an established claim, `causal` marks a causal conclusion in
 * `assumed` (then `verified` is true). Messages written before agent-quality lack both and read as null and false.
 */
const ResearchAnswerClaimSchema = z.object({
  text: z.string().min(1),
  /** Numbers of the answer's `sources` this claim cites. */
  footnotes: z.array(z.number().int().min(1)),
  verified: z.boolean(),
  confidence: ResearchAnswerConfidenceSchema.nullable().default(null),
  causal: z.boolean().default(false),
});
export type ResearchAnswerClaim = z.infer<typeof ResearchAnswerClaimSchema>;

const ResearchAnswerSourceSchema = z.object({
  number: z.number().int().min(1),
  sourceId: ProvenanceSchema.shape.sourceId,
  toolName: ProvenanceSchema.shape.toolName,
  snapshot: ProvenanceSchema.shape.snapshot,
  /** `coverage.truncated` of the evidence. */
  truncated: z.boolean(),
});
export type ResearchAnswerSource = z.infer<typeof ResearchAnswerSourceSchema>;

/** Why the engine stopped the investigation by force (design-engine.md, InvestigationView `stopReason`). */
const ResearchStopReasonSchema = z.enum([
  "budget_exhausted",
  "step_limit",
  "controller_invalid",
  "model_unavailable",
  "deadline",
  "context_overflow",
  "plan_sources_rejected",
]);

const CLAIM_GROUPS = ["established", "assumed", "unknown"] as const;

/** Most items the summary of an answer holds (design-engine.md, Contract `ResearchAnswerMetadata`). */
const SUMMARY_ITEMS_MAX = 3;

/** An item of the answer's summary: the verbatim text of an accepted claim of this answer and its group. */
const ResearchAnswerSummaryItemSchema = z.object({
  claimId: z.string().min(1),
  text: z.string().min(1),
  confidence: ResearchAnswerConfidenceSchema,
});
export type ResearchAnswerSummaryItem = z.infer<typeof ResearchAnswerSummaryItemSchema>;

const researchAnswerFields = z.object({
  launchKey: LaunchKeySchema,
  goal: InvestigationSpecSchema.shape.query,
  /** Summary string of messages written before agent-quality; null in every message the engine builds. */
  summary: z.string().nullable(),
  /** Empty: no summary. Messages written before agent-quality lack the field and read as empty. */
  summaryItems: z.array(ResearchAnswerSummaryItemSchema).max(SUMMARY_ITEMS_MAX).default([]),
  outcome: z.enum(["answered", "partial", "inconclusive"]),
  stopReason: ResearchStopReasonSchema.nullable(),
  established: z.array(ResearchAnswerClaimSchema),
  assumed: z.array(ResearchAnswerClaimSchema),
  unknown: z.array(ResearchAnswerClaimSchema),
  sources: z.array(ResearchAnswerSourceSchema),
  sourceMode: ResearchSourceModeSchema,
});

/**
 * Without sources nothing is established, no claim cites a footnote or carries a group or a causal flag, there is no
 * summary and there are no sources (KD-8, DC-9; design-engine.md, Contract `ResearchAnswerMetadata`).
 */
function checkNoSourcesAnswer(answer: z.output<typeof researchAnswerFields>, ctx: z.RefinementCtx): void {
  if (answer.sourceMode !== "model_knowledge") {
    return;
  }
  if (answer.established.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["established"],
      message: "nothing is established without sources",
    });
  }
  if (answer.summaryItems.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["summaryItems"],
      message: "an answer without sources has no summary items",
    });
  }
  for (const group of CLAIM_GROUPS) {
    answer[group].forEach((claim, index) => {
      if (claim.footnotes.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: [group, index, "footnotes"],
          message: "a claim cites no source without sources",
        });
      }
      if (claim.confidence !== null) {
        ctx.addIssue({
          code: "custom",
          path: [group, index, "confidence"],
          message: "a claim has no group without sources",
        });
      }
      if (claim.causal) {
        ctx.addIssue({
          code: "custom",
          path: [group, index, "causal"],
          message: "a claim is not causal without sources",
        });
      }
    });
  }
  if (answer.sources.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["sources"],
      message: "an answer without sources lists none",
    });
  }
}

/**
 * The `researchAnswer` metadata without `launch`: what the engine builds for the answer message (design-engine.md,
 * `buildResearchAnswer`, `Engine.readAnswerMessage`). The chat server adds only `launch`.
 */
export const ResearchAnswerBodySchema = researchAnswerFields.superRefine(checkNoSourcesAnswer);
export type ResearchAnswerBody = z.infer<typeof ResearchAnswerBodySchema>;

/**
 * Value of `researchAnswer` on the answer message: the engine's body plus `launch`, which points at the user message
 * of an explicit launch or at the card's tool call of a proposal.
 */
export const ResearchAnswerMetadataSchema = researchAnswerFields
  .extend({
    launch: z.union([
      z.strictObject({ messageId: MessageIdSchema }),
      z.strictObject({ toolCallId: z.string().min(1).max(255) }),
    ]),
  })
  .superRefine(checkNoSourcesAnswer);
export type ResearchAnswerMetadata = z.infer<typeof ResearchAnswerMetadataSchema>;

// ---------------------------------------------------------------------------
// ResearchLaunchView, GET /api/threads/:threadId/research
// ---------------------------------------------------------------------------

/**
 * State of a launch as the card shows it. `launching` and `answer_pending` show as `running`, `answered` and
 * `answer_reappend` as `completed`, `declined` and `superseded` as `not_launched`.
 */
export const ResearchLaunchViewStateSchema = z.enum([
  "proposed",
  "not_launched",
  "running",
  "completed",
  "failed",
  "stopped",
]);
export type ResearchLaunchViewState = z.infer<typeof ResearchLaunchViewStateSchema>;

/** One launch of a thread as the card shows it. */
export const ResearchLaunchViewSchema = z
  .object({
    launchKey: LaunchKeySchema,
    mode: z.enum(["explicit", "proposal"]),
    state: ResearchLaunchViewStateSchema,
    /** Set exactly when `state` is `not_launched` (MC-13). */
    notLaunchedReason: z.enum(["declined", "superseded"]).nullable(),
    goal: InvestigationSpecSchema.shape.query,
    tokenBudget: z.number().int().min(1),
    createdAt: z.iso.datetime(),
    /** Only when `completed` and the answer message is stored: the target of «К ответу». */
    answerMessageId: MessageIdSchema.nullable(),
    /** `true` while a `completed` answer removed by a regeneration is not appended again (KD-6). */
    answerPending: z.boolean(),
    /** The investigation's mode; before it exists, the engine's current mode (KD-8, DC-8). */
    sourceMode: ResearchSourceModeSchema,
  })
  .superRefine((view, ctx) => {
    if ((view.state === "not_launched") !== (view.notLaunchedReason !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["notLaunchedReason"],
        message: "notLaunchedReason is set exactly when the launch is not_launched",
      });
    }
    if (view.answerMessageId !== null && view.state !== "completed") {
      ctx.addIssue({
        code: "custom",
        path: ["answerMessageId"],
        message: "answerMessageId is set only when the launch is completed",
      });
    }
  });
export type ResearchLaunchView = z.infer<typeof ResearchLaunchViewSchema>;

/** Body of `GET /api/threads/:threadId/research`: the thread's launches in creation order, without `discarded`. */
export const ThreadResearchResponseSchema = z.object({
  launches: z.array(ResearchLaunchViewSchema),
});
export type ThreadResearchResponse = z.infer<typeof ThreadResearchResponseSchema>;

/** Body of `POST /api/threads/:threadId/research/:launchKey/stop` (design-lifecycle.md, ResearchStopResponse). */
export const ResearchStopResponseSchema = z.object({
  launch: ResearchLaunchViewSchema,
});
export type ResearchStopResponse = z.infer<typeof ResearchStopResponseSchema>;

// ---------------------------------------------------------------------------
// Tool `deepResearch`
// ---------------------------------------------------------------------------

/**
 * Input of the `deepResearch` tool: the goal as the agent understood the question, and an optional token budget
 * (its bounds are the process configuration's `investigationTokens`, checked at the start).
 */
export const DeepResearchToolInputSchema = z.object({
  goal: InvestigationSpecSchema.shape.query,
  tokenBudget: z.number().int().min(1).optional(),
});
export type DeepResearchToolInput = z.infer<typeof DeepResearchToolInputSchema>;

/**
 * Result of the `deepResearch` tool: the launch's view, and on a decision turn the error of a start or a cancel that
 * failed. A launch absent from the owner's thread has no view: `not_found`, nothing changed.
 */
export const DeepResearchToolResultSchema = z.union([
  z.object({
    launch: ResearchLaunchViewSchema,
    decisionError: z.enum(["launch_failed", "stop_failed"]).optional(),
  }),
  z.object({
    launch: z.null(),
    decisionError: z.literal("not_found"),
  }),
]);
export type DeepResearchToolResult = z.infer<typeof DeepResearchToolResultSchema>;

// ---------------------------------------------------------------------------
// Tool `stopResearch` (design-lifecycle.md, KD-4)
// ---------------------------------------------------------------------------

/** Input of the `stopResearch` tool: the `launchKey` of the card the user means, when the model can name it. */
export const StopResearchToolInputSchema = z.object({
  launchKey: LaunchKeySchema.optional(),
});
export type StopResearchToolInput = z.infer<typeof StopResearchToolInputSchema>;

/** A running launch of the thread the agent asks the user about: its key and goal. */
const StopResearchCandidateSchema = z.object({
  launchKey: LaunchKeySchema,
  goal: InvestigationSpecSchema.shape.query,
});

/**
 * Result of the `stopResearch` tool. `launch` is the launch after the stop: `stopped`, or as it already was, without an
 * error; with `stop_failed` it is unchanged. Without a launch: `not_found` (no such launch in the thread),
 * `nothing_to_stop` (no key named and nothing running) or `ambiguous` with the running launches as `candidates`.
 */
export const StopResearchToolResultSchema = z.union([
  z.object({
    launch: ResearchLaunchViewSchema,
    error: z.literal("stop_failed").optional(),
  }),
  z.object({
    launch: z.null(),
    error: z.enum(["not_found", "nothing_to_stop"]),
  }),
  z.object({
    launch: z.null(),
    error: z.literal("ambiguous"),
    candidates: z.array(StopResearchCandidateSchema).min(2),
  }),
]);
export type StopResearchToolResult = z.infer<typeof StopResearchToolResultSchema>;
