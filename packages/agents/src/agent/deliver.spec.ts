import type { StepMessage } from '@agent-os/runtime';

import type { AgentDeps } from './agent-deps';
import { chatTurns, entriesOf } from './deliver';

// DC-1: in a chat every `user_message` of the employee starts a new turn; nothing else resets the counter
// here. Only `ChatAgent` counts so: every other agent keeps its counter.
const message = (kind: string, payload: Record<string, unknown>): StepMessage =>
  ({ messageId: 'm1', kind, payload }) as StepMessage;

describe('the turn counter after delivery', () => {
  it.each<[string, StepMessage[], number]>([
    [
      'a chat resets on a user message',
      [message('user_message', { text: 'hi' })],
      0,
    ],
    ['a chat keeps the counter on an interrupt', [message('interrupt', {})], 3],
    ['a chat keeps the counter without messages', [], 3],
  ])('%s', (_name, messages, expected) => {
    expect(chatTurns(3, messages)).toBe(expected);
  });
});

// data-model design-runtime.md, «Отчёты детей», KD-6, DC-44: a child's end becomes a `child_report` with the
// failure's text cut to 1 000 characters, except when this step closes the child's `task` call — the call's
// result already carries it, and a second report would tell the model twice — and except a question's end
// (KD-3, «Отчёты детей»): the tool step reads the answer, the model gets no report of it.
describe('the child reports of a step', () => {
  const FAILED = '00000000-0000-4000-8000-000000000001';
  const DONE = '00000000-0000-4000-8000-000000000002';
  const QUESTION = '00000000-0000-4000-8000-000000000003';
  const finished = (
    messageId: string,
    payload: Record<string, unknown>,
  ): StepMessage =>
    ({ messageId, kind: 'child_finished', payload }) as StepMessage;
  const messages = [
    finished('m1', {
      taskId: FAILED,
      status: 'failed',
      failure: { reason: 'model_error', message: 'y'.repeat(1_500) },
      durationMs: 7,
    }),
    finished('m2', {
      taskId: DONE,
      status: 'completed',
      result: { report: 'итог', document: null },
      durationMs: 9,
    }),
    finished('m3', {
      taskId: QUESTION,
      status: 'completed',
      result: { approve: true },
      durationMs: 5,
    }),
  ];
  // A question has no session; every agent child here has one.
  const deps = {
    sessions: {
      getMany: async (ids: readonly string[]) =>
        new Map(
          ids
            .filter((id) => id !== QUESTION)
            .map((id) => [id, { description: `about ${id}` }]),
        ),
    },
    messageRows: { toolCallCount: async () => 2 },
    tasks: {
      get: async (taskId: string) => ({
        taskId,
        type: taskId === QUESTION ? 'runtime.question' : 'agent',
      }),
    },
  } as unknown as Pick<AgentDeps, 'sessions' | 'messageRows' | 'tasks'>;
  const ctx = { taskId: 'parent', ownerId: 'owner', messages };

  it.each<[string, ReadonlySet<string>, unknown[]]>([
    [
      'every end is a report, a failure with its text cut',
      new Set(),
      [
        {
          kind: 'child_report',
          content: {
            agentId: FAILED,
            description: `about ${FAILED}`,
            status: 'failed',
            reason: 'model_error',
            message: 'y'.repeat(1_000),
            text: null,
            document: null,
            toolCalls: 2,
            durationMs: 7,
          },
        },
        {
          kind: 'child_report',
          content: {
            agentId: DONE,
            description: `about ${DONE}`,
            status: 'completed',
            reason: null,
            message: null,
            text: 'итог',
            document: null,
            toolCalls: 2,
            durationMs: 9,
          },
        },
      ],
    ],
    [
      'a child whose call the step closes gives no report',
      new Set([FAILED, DONE]),
      [],
    ],
  ])('%s', async (_name, closedChildren, expected) => {
    expect(await entriesOf(deps, ctx, closedChildren)).toEqual(expected);
  });
});
