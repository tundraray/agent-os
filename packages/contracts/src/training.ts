import { z } from 'zod';
import {
  ChipRecordSchema,
  DeepAgentContentSchema,
  IdSchema,
  ScriptSchema,
} from './library';
import { SessionTaskStatusSchema, type TaskStatus } from './runtime';
import { ApiErrorSchema } from './threads';

/** The trainer's own tools (design-training.md, «Инструменты тренера»); `try_script` is `TRY_SCRIPT_TOOL`. */
export const TRAINER_TOOLS = [
  'past_tasks',
  'read_past_task',
  'read_past_document',
  'agent_memory',
  'agent_definition',
  'propose_version',
] as const;

/** The tools only the test-run mode of the trainer has (design-trainer-dialog.md, «Инструменты режима прогона»). */
export const TEST_RUN_TOOLS = [
  'library_overview',
  'offer_agent',
  'take_agent',
  'propose_plan',
  'create_agent',
  'test_results',
] as const;

/** Limits of a test run: the employee's description (UXRD MC-3), the number of tests and each test text. */
export const TEST_RUN_DESCRIPTION_MAX = 4000;
export const TEST_RUN_TESTS_MAX = 5;
export const TEST_TEXT_MAX_CHARS = 2000;

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
  TEST_RUN_RUNNING: 'TEST_RUN_RUNNING',
  TEST_RUN_NO_OFFER: 'TEST_RUN_NO_OFFER',
  TEST_RUN_NOT_ACCEPTING: 'TEST_RUN_NOT_ACCEPTING',
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

/** A replay's numbers, counted on read; `conversationId` — `null` once the run's agent is deleted. */
const ReplayNumbersSchema = z.object({
  errors: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  costUsd: z.number(),
});
const ReplaySchema = ReplayNumbersSchema.extend({
  conversationId: z.uuid().nullable(),
});

const PoolSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    subject: z.string(),
    status: SessionTaskStatusSchema,
    /** A test run's fix task closed without a round because every test passed: it reads «Не потребовалась», not done. */
    skipped: z.boolean().optional(),
  }),
);

/** Response of GET /api/library/:id/training/:trainingId (design-training.md, `TrainingView`), for its starter only (FR-15). */
export const TrainingViewSchema = z.object({
  agent: z.object({ id: z.uuid(), name: z.string() }),
  startedBy: z.string(),
  startedAt: z.iso.datetime(),
  baseVersion: z.number().int().positive(),
  status: TrainingStatusSchema,
  failureReason: z.string().nullable(),
  cappedAt: z.iso.datetime().nullable(),
  spentUsd: z.number(),
  capUsd: z.number(),
  pool: PoolSchema,
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

/**
 * Body of POST /api/test-runs (design-trainer-dialog.md, «Маршруты прогона»): the description may be empty only
 * with the employee's conversation the run forks.
 */
export const StartTestRunBodySchema = z
  .object({
    description: z.string().trim().max(TEST_RUN_DESCRIPTION_MAX),
    originThreadId: IdSchema.optional(),
  })
  .refine(
    (body) => body.description !== '' || body.originThreadId !== undefined,
    { path: ['description'], message: 'A description is required' },
  );
export type StartTestRunBody = z.infer<typeof StartTestRunBodySchema>;

/** Response of POST /api/test-runs (201): the test run's id, also its conversation's. */
export const TestRunStartedSchema = z.object({ testRunId: z.uuid() });
export type TestRunStarted = z.infer<typeof TestRunStartedSchema>;

/** 409 TEST_RUN_RUNNING: the employee's running test run, its id and its conversation's title (KD-8). */
export const TestRunRunningErrorSchema = ApiErrorSchema.extend({
  errorCode: z.literal(TrainingErrorCode.TEST_RUN_RUNNING),
  testRunId: IdSchema,
  testRunTitle: z.string(),
});
export type TestRunRunningError = z.infer<typeof TestRunRunningErrorSchema>;

/** Response of POST /api/test-runs/:testRunId/take: the fork with the taken agent (`null` without a fork) and its chip. */
export const TestRunTakenSchema = z.object({
  threadId: IdSchema.nullable(),
  record: ChipRecordSchema,
});
export type TestRunTaken = z.infer<typeof TestRunTakenSchema>;

/** Body of POST /api/test-runs/:testRunId/activate: the number of a version of the test run. */
export const ActivateTestRunBodySchema = z.object({
  version: z.number().int().positive(),
});
export type ActivateTestRunBody = z.infer<typeof ActivateTestRunBodySchema>;

/** The judge's verdict on one test answer (design-test-run.md, KD-5). */
export const TestVerdictSchema = z.enum(['passed', 'failed', 'unchecked']);
export type TestVerdict = z.infer<typeof TestVerdictSchema>;

/** One test's round in `trainings.tests`; `runId` — the run's conversation, empty until it starts. */
const TestRunRoundSchema = z.object({
  runId: z.uuid().nullable(),
  verdict: TestVerdictSchema.nullable(),
  reason: z.string().nullable(),
});

/** One element of `trainings.tests` (design-trainer-dialog.md, KD-7): round k is position k − 1; none — not started. */
export const TestRunTestSchema = z.object({
  task: z.string(),
  expected: z.string(),
  rounds: z.array(TestRunRoundSchema),
});
export type TestRunTest = z.infer<typeof TestRunTestSchema>;

/** Every test has its verdict in round k (from 1); no tests — not judged. */
export function roundJudged(tests: readonly TestRunTest[], k: number): boolean {
  return (
    tests.length > 0 &&
    tests.every((test) => test.rounds[k - 1]?.verdict != null)
  );
}

/** A test did not pass round k (from 1). */
export function roundFailed(tests: readonly TestRunTest[], k: number): boolean {
  return tests.some((test) => test.rounds[k - 1]?.verdict !== 'passed');
}

/** The most plan revisions of a test run: the plan, the corrected plan, the final one (KD-3). */
export const TEST_RUN_PLAN_REVISIONS_MAX = 3;

/** `trainings.plan`: the trainer's latest plan of the agent (design-trainer-dialog.md, KD-3). */
export const TestRunPlanSchema = z.object({
  revision: z.number().int().min(1).max(TEST_RUN_PLAN_REVISIONS_MAX),
  name: z.string(),
  description: z.string(),
  servers: z.array(z.string()),
});
export type TestRunPlan = z.infer<typeof TestRunPlanSchema>;

/** Where a test run is (design-trainer-dialog.md, «Фазы и передача хода»). */
export const TestRunPhaseSchema = z.enum([
  'dialog',
  'working',
  'result',
  'ended',
  'taken',
]);
export type TestRunPhase = z.infer<typeof TestRunPhaseSchema>;

/**
 * The phase of a test run from stored facts, by rules 1–5 in their order (KD-1). `versions` — the run's versions,
 * version 1 included; `fixTaskInProgress` — task 3 of the pool is in progress.
 */
export function testRunPhase(state: {
  readonly rootStatus: TaskStatus;
  readonly capped: boolean;
  readonly agentId: string | null;
  readonly takenAgentId: string | null;
  readonly versions: number;
  readonly tests: readonly TestRunTest[];
  readonly fixTaskInProgress: boolean;
}):
  | { readonly phase: Exclude<TestRunPhase, 'ended'> }
  | {
      readonly phase: 'ended';
      readonly reason: 'capped' | 'stopped' | 'failed';
    } {
  const { rootStatus, tests } = state;
  if (state.takenAgentId !== null) return { phase: 'taken' };
  if (rootStatus === 'stopped' || rootStatus === 'failed')
    return { phase: 'ended', reason: state.capped ? 'capped' : rootStatus };
  if (state.agentId === null) return { phase: 'dialog' };
  const rounds = Math.max(0, ...tests.map((test) => test.rounds.length));
  if (
    (rounds > 0 && !roundJudged(tests, rounds)) ||
    rounds < state.versions ||
    state.fixTaskInProgress
  )
    return { phase: 'working' };
  return { phase: 'result' };
}

/**
 * Why a test run's conversation takes no message now (design-trainer-dialog.md, «Сообщения»): the reason of 409
 * `TEST_RUN_NOT_ACCEPTING`; the last two only in the result phase.
 */
export const TestRunClosedReasonSchema = z.enum([
  'working',
  'capped',
  'stopped',
  'failed',
  'taken',
  'training_running',
  'agent_deleted',
]);
export type TestRunClosedReason = z.infer<typeof TestRunClosedReasonSchema>;

/** A test's result in one round of the view: the verdict and the run's numbers. */
const TestResultSchema = ReplaySchema.extend({
  verdict: TestVerdictSchema.nullable(),
  reason: z.string().nullable(),
});

/** Response of GET /api/test-runs/:testRunId (design-trainer-dialog.md, `TestRunView`). */
export const TestRunViewSchema = z.object({
  id: z.uuid(),
  /** Empty for a forked test run started without one. */
  description: z.string(),
  startedAt: z.iso.datetime(),
  status: TrainingStatusSchema,
  failureReason: z.string().nullable(),
  cappedAt: z.iso.datetime().nullable(),
  spentUsd: z.number(),
  capUsd: z.number(),
  pool: PoolSchema,
  phase: TestRunPhaseSchema,
  /** The conversation takes a message now. */
  canSend: z.boolean(),
  /** `null` until the first plan; `agreed` — the agent is created by it. */
  plan: TestRunPlanSchema.extend({ agreed: z.boolean() }).nullable(),
  offered: z
    .object({ id: IdSchema, name: z.string(), description: z.string() })
    .nullable(),
  taken: z.object({ id: IdSchema, name: z.string() }).nullable(),
  /** `null` until the trainer creates the agent; `content` is version 1. */
  agent: z
    .object({
      id: z.uuid(),
      name: z.string(),
      description: z.string(),
      deleted: z.boolean(),
      content: DeepAgentContentSchema,
    })
    .nullable(),
  /** Each test's results by round: round k is position k − 1, a round not started has none. */
  tests: z.array(
    z.object({
      task: z.string(),
      expected: z.string(),
      rounds: z.array(TestResultSchema),
    }),
  ),
  /** One round per version of the run, in order: round k is on version k. */
  rounds: z.array(
    ReplayNumbersSchema.extend({
      versionId: IdSchema,
      version: z.number().int().positive(),
      /** A round the employee asked for after the summary. */
      requested: z.boolean(),
      passed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      /** The trainer's explanation of the version; `null` in round 1. */
      changes: z.string().nullable(),
      texts: VersionTextsSchema,
      canActivate: z.boolean(),
    }),
  ),
  /** What became of the automatic fix: not needed, nothing to fix, or `null` — done, pending or never reached. */
  fixSkipped: z.enum(['not_needed', 'nothing_to_fix']).nullable(),
  /** The trainer's explanation when it closed the fix without a version (`nothing_to_fix`). */
  fixExplanation: z.string().nullable(),
  activatedAt: z.iso.datetime().nullable(),
  activeVersion: z.number().int().positive().nullable(),
  canDelete: z.boolean(),
});
export type TestRunView = z.infer<typeof TestRunViewSchema>;

/**
 * The summary of a test run in its conversation's view (design-trainer-dialog.md, KD-9, «Сводка прогона в ленте»):
 * the feed's cards and the composer read it; every state is derived from the row, the pool and the trainer's history.
 */
export const TestRunSummarySchema = z.object({
  phase: TestRunPhaseSchema,
  status: TrainingStatusSchema,
  capped: z.boolean(),
  canSend: z.boolean(),
  /** Why the composer is closed; `null` while `canSend`. */
  closedReason: TestRunClosedReasonSchema.exclude([
    'training_running',
    'agent_deleted',
  ]).nullable(),
  /** The subject of the pool's task in progress. */
  step: z.string().nullable(),
  agent: z
    .object({ id: IdSchema, name: z.string(), deleted: z.boolean() })
    .nullable(),
  /** One round per version of the run, in order; `passed` and `total` are `null` until the round is judged. */
  rounds: z.array(
    z.object({
      /** The call that started the round: `create_agent` for round 1, `propose_version` for the others. */
      startCallId: z.string(),
      requested: z.boolean(),
      passed: z.number().int().nonnegative().nullable(),
      total: z.number().int().nonnegative().nullable(),
    }),
  ),
  offer: z
    .object({
      callId: z.string(),
      agentId: IdSchema,
      state: z.enum(['waiting', 'answered', 'taken', 'declined']),
      /** When the state became what it is; `null` while waiting. */
      at: z.iso.datetime().nullable(),
    })
    .nullable(),
  /** The successful `propose_plan` calls in order: revision k is position k − 1. */
  plans: z.array(
    z.object({
      callId: z.string(),
      revision: z.number().int().positive(),
      state: z.enum(['waiting', 'answered', 'replaced', 'confirmed']),
      at: z.iso.datetime().nullable(),
    }),
  ),
  taken: z
    .object({
      agentId: IdSchema,
      name: z.string(),
      /** The conversation with the taken agent, once «взять» created it. */
      threadId: IdSchema.nullable(),
    })
    .nullable(),
});
export type TestRunSummary = z.infer<typeof TestRunSummarySchema>;
