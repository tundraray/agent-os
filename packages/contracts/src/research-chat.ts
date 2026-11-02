import { z } from "zod";
import { InvestigationSpecSchema, ProvenanceSchema } from "./research.js";

/**
 * Contracts of deep research started from a chat thread (design-chat-entry.md, Contract Definitions).
 * Actions on a launch have no HTTP endpoint: they travel as a `POST /api/chat` turn with message metadata (KD-2).
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

const LaunchKeySchema = z.string().min(1).max(200);
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

const ResearchAnswerClaimSchema = z.object({
  text: z.string().min(1),
  /** Numbers of the answer's `sources` this claim cites. */
  footnotes: z.array(z.number().int().min(1)),
  verified: z.boolean(),
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
]);

const CLAIM_GROUPS = ["established", "assumed", "unknown"] as const;

/**
 * Value of `researchAnswer` on the answer message. `launch` points at the user message of an explicit launch or at
 * the card's tool call of a proposal. Without sources nothing is established, no claim cites a footnote and there are
 * no sources (KD-8, DC-9).
 */
export const ResearchAnswerMetadataSchema = z
  .object({
    launchKey: LaunchKeySchema,
    goal: InvestigationSpecSchema.shape.query,
    outcome: z.enum(["answered", "partial", "inconclusive"]),
    stopReason: ResearchStopReasonSchema.nullable(),
    launch: z.union([
      z.strictObject({ messageId: MessageIdSchema }),
      z.strictObject({ toolCallId: z.string().min(1).max(255) }),
    ]),
    established: z.array(ResearchAnswerClaimSchema),
    assumed: z.array(ResearchAnswerClaimSchema),
    unknown: z.array(ResearchAnswerClaimSchema),
    sources: z.array(ResearchAnswerSourceSchema),
    sourceMode: ResearchSourceModeSchema,
  })
  .superRefine((answer, ctx) => {
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
    for (const group of CLAIM_GROUPS) {
      answer[group].forEach((claim, index) => {
        if (claim.footnotes.length > 0) {
          ctx.addIssue({
            code: "custom",
            path: [group, index, "footnotes"],
            message: "a claim cites no source without sources",
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
  });
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
