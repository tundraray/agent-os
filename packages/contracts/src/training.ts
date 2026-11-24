import { z } from 'zod';
import { SessionTaskStatusSchema } from './chat';
import { ScriptSchema } from './library';

/** The trainer's own tools (design-training.md, «Инструменты тренера»); `try_script` is `TRY_SCRIPT_TOOL`. */
export const TRAINER_TOOLS = [
  'past_tasks',
  'read_past_task',
  'read_past_document',
  'agent_memory',
  'agent_definition',
  'propose_version',
] as const;

/** The judge's verdict on one comparison pair, in terms of the versions (design-training.md, KD-6). */
export const VerdictSchema = z.enum([
  'proposed_better',
  'base_better',
  'equal',
  'not_compared',
]);
export type Verdict = z.infer<typeof VerdictSchema>;

/** One element of `trainings.comparisons`: a past task, its two replays and the verdict on them. */
export const ComparisonSchema = z.object({
  pastConversationId: z.uuid(),
  baseReplayId: z.uuid().nullable(),
  proposedReplayId: z.uuid().nullable(),
  verdict: VerdictSchema.nullable(),
  reason: z.string().nullable(),
});
export type Comparison = z.infer<typeof ComparisonSchema>;

/** Error codes of the training routes (design-training.md, «Маршруты обучения»); also RECORD_NOT_FOUND and START_REFUSED. */
export const TrainingErrorCode = {
  TRAINING_FORBIDDEN: 'TRAINING_FORBIDDEN',
  SELF_LEARNING_OFF: 'SELF_LEARNING_OFF',
  TRAINING_RUNNING: 'TRAINING_RUNNING',
  TRAINING_NO_PAST_TASKS: 'TRAINING_NO_PAST_TASKS',
  TRAINING_NOT_FOUND: 'TRAINING_NOT_FOUND',
  TRAINING_NOT_ACTIVATABLE: 'TRAINING_NOT_ACTIVATABLE',
  TRAINING_BASE_CHANGED: 'TRAINING_BASE_CHANGED',
} as const;
export type TrainingErrorCode =
  (typeof TrainingErrorCode)[keyof typeof TrainingErrorCode];

/** A training's state, from its root task's status. */
export const TrainingStatusSchema = z.enum([
  'running',
  'done',
  'stopped',
  'failed',
]);
export type TrainingStatus = z.infer<typeof TrainingStatusSchema>;

/** Response of GET /api/library/:id/training: what the card needs. Without `canTrain` there is no training in it. */
export const TrainingStateSchema = z.object({
  canTrain: z.boolean(),
  /** The flag of the agent's active version. */
  selfLearning: z.boolean(),
  /** The cap a training started now gets. */
  capUsd: z.number(),
  running: z
    .object({
      id: z.uuid(),
      startedBy: z.string(),
      startedAt: z.iso.datetime(),
      spentUsd: z.number(),
      capUsd: z.number(),
      startedByMe: z.boolean(),
    })
    .nullable(),
  lastFinished: z
    .object({
      id: z.uuid(),
      finishedAt: z.iso.datetime(),
      status: TrainingStatusSchema,
      recommended: z.boolean().nullable(),
    })
    .nullable(),
});
export type TrainingState = z.infer<typeof TrainingStateSchema>;

/** The prompts and scripts of one version, side by side with the other on the result screen. */
const VersionTextsSchema = z.object({
  prompt: z.string(),
  subagents: z.array(z.object({ name: z.string(), prompt: z.string() })),
  scripts: z.array(ScriptSchema),
});

/** A replay's numbers, counted on read; `conversationId` — only for the person who started the training. */
const ReplayNumbersSchema = z.object({
  errors: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  costUsd: z.number(),
});
const ReplaySchema = ReplayNumbersSchema.extend({
  conversationId: z.uuid().nullable(),
});

/** Response of GET /api/library/:id/training/:trainingId (design-training.md, `TrainingView`). */
export const TrainingViewSchema = z.object({
  agent: z.object({ id: z.uuid(), name: z.string() }),
  startedBy: z.string(),
  startedAt: z.iso.datetime(),
  baseVersion: z.number().int().positive(),
  startedByMe: z.boolean(),
  status: TrainingStatusSchema,
  failureReason: z.string().nullable(),
  cappedAt: z.iso.datetime().nullable(),
  spentUsd: z.number(),
  capUsd: z.number(),
  pool: z.array(
    z.object({
      number: z.number().int().positive(),
      subject: z.string(),
      status: SessionTaskStatusSchema,
    }),
  ),
  /** The free texts (`proposal` texts, `changes`, `explanation`, a comparison's `task` and `reason`) only for the starter, else `null`. */
  proposal: z.object({
    version: z.number().int().positive().nullable(),
    base: VersionTextsSchema.nullable(),
    proposed: VersionTextsSchema.nullable(),
    changes: z.string().nullable(),
    /** The trainer's explanation from its task's result when it proposed no version. */
    explanation: z.string().nullable(),
  }),
  comparisons: z.array(
    z.object({
      /** `null` also for a past task its owner deleted. */
      task: z.string().nullable(),
      verdict: VerdictSchema.nullable(),
      reason: z.string().nullable(),
      /** `null` — the replay did not start. */
      base: ReplaySchema.nullable(),
      proposed: ReplaySchema.nullable(),
    }),
  ),
  totals: z.object({
    base: ReplayNumbersSchema,
    proposed: ReplayNumbersSchema,
  }),
  /** `done` with a proposed version: wins > losses; otherwise `null`. */
  recommended: z.boolean().nullable(),
  activatedAt: z.iso.datetime().nullable(),
  activeVersion: z.number().int().positive(),
  canActivate: z.boolean(),
});
export type TrainingView = z.infer<typeof TrainingViewSchema>;

/** Response of POST /api/library/:id/training (201): the training's id, also its conversation's. */
export const TrainingStartedSchema = z.object({ trainingId: z.uuid() });
export type TrainingStarted = z.infer<typeof TrainingStartedSchema>;

/** Response of POST /api/library/:id/training/:trainingId/activate. */
export const TrainingActivatedSchema = z.object({
  version: z.number().int().positive(),
  activatedAt: z.iso.datetime(),
});
export type TrainingActivated = z.infer<typeof TrainingActivatedSchema>;
