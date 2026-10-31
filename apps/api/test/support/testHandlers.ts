import { randomUUID } from 'node:crypto';
import type {
  EvidenceInput,
  HandlerResult,
  TaskSpec,
} from '@agent-os/contracts';
import { z } from 'zod';
import type {
  TaskContext,
  TaskHandler,
} from '../../src/research/handler.registry.js';

/**
 * Test handlers of the runtime: plain objects without Nest decorators, so the in-process INT
 * tests and the child process of the kill matrix run the same code. Ordering is driven by
 * latches the test releases, never by sleeps.
 */

/** Version of every test workflow. */
const TEST_WORKFLOW_VERSION = 1;

/** A one-shot gate: `promise` resolves on the first `release()`. */
export interface Latch {
  readonly promise: Promise<void>;
  release(): void;
}

export function latch(): Latch {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * `promise`, or a failure naming `what` after `ms`: a latch that never opens fails the test
 * with a reason instead of hanging it. A guard, not a delay — nothing waits for it to elapse.
 */
export async function within<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms} ms waiting for ${what}`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A workflow type unique to one test: workers of other tests never claim its tasks. */
export function uniqueWorkflowType(label: string): string {
  return `test-${label}-${randomUUID()}`;
}

/** A handler of `workflowType` running `run`; `input` is any JSON object. */
export function testHandler(
  workflowType: string,
  run: (ctx: TaskContext) => Promise<HandlerResult>,
): TaskHandler {
  return {
    workflowType,
    workflowVersion: TEST_WORKFLOW_VERSION,
    inputSchema: z.record(z.string(), z.unknown()),
    run,
  };
}

/** A `completed` result; fields not given are empty. */
export function completed(
  fields: Partial<Omit<HandlerResult, 'kind'>> = {},
): HandlerResult {
  return {
    kind: 'completed',
    answerOrDelta: null,
    evidenceRefs: [],
    coverage: null,
    missingEvidence: [],
    warnings: [],
    proposedTasks: [],
    ...fields,
  };
}

/** Evidence of one fixture page with the given content. */
export function evidenceInput(
  evidenceKey: string,
  bytes: Uint8Array<ArrayBuffer>,
): EvidenceInput {
  return {
    evidenceKey,
    provenance: {
      sourceId: 'test-fixture',
      toolName: 'fixture.read',
      normalizedArgs: { key: evidenceKey },
      snapshot: 'snapshot-1',
    },
    coverage: {
      completeness: 'complete',
      totalMatched: 1,
      totalRelation: 'eq',
      returned: 1,
      truncated: false,
      continuation: null,
    },
    content: { mediaType: 'application/octet-stream', bytes },
  };
}

// ---------------------------------------------------------------------------------------------
// Kill-matrix scenario (E2E-1): shared by the child process and the harness that drives it
// ---------------------------------------------------------------------------------------------

/**
 * Tasks of the scenario: A; B depends on A; C independent. A also gets a second subscriber
 * ({@link SCENARIO_SUBSCRIBER}), so a delivered end of A notifies two subscribers.
 */
export const SCENARIO_STEPS = ['A', 'B', 'C'] as const;
export type ScenarioStep = (typeof SCENARIO_STEPS)[number];

/** Requester of the second proposal of A, which subscribes to A instead of creating a task. */
export const SCENARIO_SUBSCRIBER = 'scenario-subscriber';

/** Requester of the proposal that creates the step's task. */
export const scenarioRequester = (step: ScenarioStep): string =>
  `scenario-${step}`;

/** Evidence key the scenario handler stores for the step. */
const scenarioEvidenceKey = (step: ScenarioStep): string => `page-${step}`;

/** Environment variable carrying the {@link ChildScenario} JSON to the child process. */
export const CHILD_SCENARIO_ENV = 'RUNTIME_CHILD_SCENARIO';

/**
 * What one child process works on. The first start has no investigation and creates it (with a
 * thread of `resourceId`); a restart names the investigation and its thread.
 */
export interface ChildScenario {
  workflowType: string;
  resourceId: string;
  investigation?: { investigationId: string; threadId: string };
}

/** Messages of the child to the harness (IPC). */
export type ChildMessage =
  | { kind: 'investigation'; investigationId: string; threadId: string }
  /** Every step of the scenario is admitted; handlers run from now on. */
  | { kind: 'admitted' };

/** Messages of the harness to the child (IPC): close the app and exit 0. */
export interface StopMessage {
  kind: 'stop';
}

/** The spec of a scenario step; B depends on `dependsOn` (A's task). */
export function scenarioSpec(spec: {
  investigationId: string;
  workflowType: string;
  step: ScenarioStep;
  dependsOn?: string[];
}): TaskSpec {
  return taskSpec({
    investigationId: spec.investigationId,
    workflowType: spec.workflowType,
    input: { step: spec.step },
    dependsOn: spec.dependsOn,
  });
}

/**
 * Handler of the scenario: once `admitted` resolves — every step admitted, so an early task
 * never ends before the later proposals see it live — stores the evidence of its step and
 * completes with it. Idempotent by the evidence key, as a fetch handler.
 */
export function scenarioHandler(
  workflowType: string,
  admitted: Promise<void>,
): TaskHandler {
  return testHandler(workflowType, async (ctx) => {
    await admitted;
    const step = SCENARIO_STEPS.find((known) => known === ctx.input.step);
    if (!step) {
      throw new Error(
        `Unknown scenario step ${JSON.stringify(ctx.input.step)}`,
      );
    }
    const ref = await ctx.putEvidence(
      evidenceInput(
        scenarioEvidenceKey(step),
        new TextEncoder().encode(`page ${step}`),
      ),
    );
    return completed({ evidenceRefs: [ref.evidenceId] });
  });
}

/** A spec of a test workflow task: budget of 2 tool calls, no retries, a 60 s deadline. */
export function taskSpec(spec: {
  investigationId: string;
  workflowType: string;
  input: Record<string, string>;
  dependsOn?: string[];
}): TaskSpec {
  return {
    investigationId: spec.investigationId,
    workflowType: spec.workflowType,
    workflowVersion: TEST_WORKFLOW_VERSION,
    input: spec.input,
    inputRefs: [],
    expectedOutput: { description: 'test output', completeness: 'all' },
    dependsOn: spec.dependsOn ?? [],
    budget: {
      maxToolCalls: 2,
      maxRetries: 0,
      deadlineMs: 60_000,
      maxTokens: 0,
    },
  };
}
