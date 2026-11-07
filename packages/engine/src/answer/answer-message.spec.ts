import type { Database } from '@agent-os/db';
import type { EvidenceReader, StoredEvidence, TaskContext } from '@agent-os/runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextBuilder } from '../context/context-builder.js';
import { createControllerHandler } from '../controller/controller.handler.js';
import type { ModelGateway } from '../model/model-gateway.js';
import { deepResearchProcessV2 } from '../processes/shipped-processes.js';
import { createSynthesizeHandler } from './synthesize.handler.js';

// design-engine.md, Flow 2 «Failure handling»: «Сведения о странице ответа не прочитаны при сборке сообщения → задача
// `research.synthesize` кончается ошибкой до записи ответа … У ответа, который собирает код, та же ошибка роняет задачу
// controller». Defect caught: a page whose details cannot be read is skipped, or the answer is written without its
// message, so an answer without footnote details reaches the chat. The database stays out: the repositories are doubles,
// the attempt guard records whether anything was written.

const repositories = vi.hoisted(() => ({
  readRun: vi.fn(),
  latestClaims: vi.fn(),
  latestPlanRevision: vi.fn(),
  decisionsOf: vi.fn(),
  verifyRoundsUsed: vi.fn(),
  writeAnswer: vi.fn(),
}));
vi.mock('../controller/decisions.repository.js', () => ({
  controllerRepository: {
    readRun: repositories.readRun,
    latestClaims: repositories.latestClaims,
    latestPlanRevision: repositories.latestPlanRevision,
    decisionsOf: repositories.decisionsOf,
  },
}));
vi.mock('./answer.repository.js', () => ({
  answerRepository: { verifyRoundsUsed: repositories.verifyRoundsUsed, writeAnswer: repositories.writeAnswer },
}));

const INVESTIGATION_ID = '0b6c1a52-3e1f-4a8b-9d7e-5f2c4b3a2910';
const TASK_ID = '7d2e9f10-6a4b-4c3d-8e5f-102938475610';
const DRAFT_PAGE = '3a4b5c6d-7e8f-4091-a2b3-c4d5e6f70811';
const BASIS_PAGE = '9e8d7c6b-5a49-4382-b1c0-d9e8f7a6b512';
const CLAIM_ID = '5c6d7e8f-9a0b-4c1d-8e2f-334455667713';
const NOT_AFTER = '2099-01-01T00:00:00.000Z';
const READ_FAILURE = new Error('evidence store unavailable');

/** The engine row as `readRun` returns it: mode `sources`, the shipped configuration, no answer yet. */
const RUN = {
  run: {
    investigationId: INVESTIGATION_ID,
    resourceId: 'user-1',
    launchKey: 'launch-1',
    sourceMode: 'sources',
    processConfig: deepResearchProcessV2,
    answer: null,
  },
  threadId: 'thread-1',
  query: 'Why did the payments time out?',
};

/** The supported claim of the answer: its basis page is not among the pages the draft names. */
const SUPPORTED = {
  claimId: CLAIM_ID,
  text: 'payment-api logged 412 timeouts',
  evidenceIds: [BASIS_PAGE],
  status: 'supported',
  pointer: [{ pageId: BASIS_PAGE, records: [0] }],
  confidence: 'high' as const,
  createdAt: new Date('2026-11-07T00:00:00.000Z'),
};

/** Reads the draft's page for the reference check; the basis page, read only for the message, cannot be read. */
const readPage = vi.fn((evidenceId: string): Promise<StoredEvidence> => {
  if (evidenceId !== DRAFT_PAGE) return Promise.reject(READ_FAILURE);
  return Promise.resolve({ record: { taskId: TASK_ID } } as unknown as StoredEvidence);
});
const evidence: Pick<EvidenceReader, 'get'> = { get: (evidenceId) => readPage(evidenceId) };
const pagesRead = () => readPage.mock.calls.map(([evidenceId]) => evidenceId);

const unused = <T>(name: string): T =>
  new Proxy({}, { get: () => () => Promise.reject(new Error(`${name} is not used here`)) }) as T;

/** The first attempt of a task: no earlier attempt to close, so a call of the guard is a write. */
function attempt(input: unknown, checkpoint: unknown = null) {
  const withAttemptGuard = vi.fn();
  const ctx = {
    taskId: TASK_ID,
    investigationId: INVESTIGATION_ID,
    attempt: 1,
    input,
    checkpoint,
    signal: new AbortController().signal,
    deadlineAt: new Date(NOT_AFTER),
    withAttemptGuard,
  } as unknown as TaskContext;
  return { ctx, withAttemptGuard };
}

const shared = {
  database: {} as Database,
  // The investigation's tasks: the draft's page was written by one of them.
  investigations: { listForThread: async () => [{ investigationId: INVESTIGATION_ID, tasks: [{ taskId: TASK_ID }] }] as never },
  evidence,
  gateway: unused<ModelGateway>('the model gateway'),
  contextBuilder: unused<ContextBuilder>('the context builder'),
  clock: { now: () => new Date('2026-11-07T12:00:00.000Z'), random: () => 0, setTimer: () => () => undefined },
};

describe('the answer message step before the answer write (Flow 2 failure handling)', () => {
  beforeEach(() => {
    repositories.readRun.mockResolvedValue(RUN);
    repositories.latestClaims.mockResolvedValue([SUPPORTED]);
    repositories.verifyRoundsUsed.mockResolvedValue(0);
    repositories.writeAnswer.mockClear();
    readPage.mockClear();
  });

  it('fails the synthesis task before any write when a page of the answer cannot be read', async () => {
    const handler = createSynthesizeHandler(shared);
    // The draft is the checkpointed answer of the synthesis call: it states the supported claim over another page.
    const draft = {
      outcome: 'answered',
      summaryClaimIds: [CLAIM_ID],
      claims: [{ claimId: CLAIM_ID, text: SUPPORTED.text, atoms: [], pointer: [{ pageId: DRAFT_PAGE, records: [0] }] }],
    };
    const { ctx, withAttemptGuard } = attempt(
      { decisionId: '1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a14', notAfter: NOT_AFTER },
      { call: 'synthesize', output: draft },
    );

    await expect(handler.run(ctx)).rejects.toBe(READ_FAILURE);
    expect(pagesRead()).toContain(BASIS_PAGE);
    // Neither the new claims nor the answer and its message were written.
    expect(withAttemptGuard).not.toHaveBeenCalled();
    expect(repositories.writeAnswer).not.toHaveBeenCalled();
  });

  it('fails the controller task before any write when a page of the code-built answer cannot be read', async () => {
    // A plan and the accepted `concludeInconclusive`: the attempt goes straight to the code-built answer.
    repositories.latestPlanRevision.mockResolvedValue({ revision: 1 });
    repositories.decisionsOf.mockResolvedValue([{ status: 'accepted', kind: 'concludeInconclusive' }]);
    const handler = createControllerHandler({
      ...shared,
      scheduler: unused('the scheduler'),
      sourceRegistry: unused('the source registry'),
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const { ctx, withAttemptGuard } = attempt({ investigationId: INVESTIGATION_ID });

    await expect(handler.run(ctx)).rejects.toBe(READ_FAILURE);
    expect(pagesRead()).toContain(BASIS_PAGE);
    expect(withAttemptGuard).not.toHaveBeenCalled();
    expect(repositories.writeAnswer).not.toHaveBeenCalled();
  });
});
