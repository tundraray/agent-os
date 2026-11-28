// design-steps.md KD-2, AC-01.6 (rule), AC-01.7 (the release half). `ModelClient` over the scripted seam with the ledger and gate doubles, as model-client.spec.ts.
import type { Logger } from '@agent-os/common';
import { systemClock } from '@agent-os/runtime';
import { describe, expect, it, vi } from 'vitest';

import {
  createLatch,
  createProviderRegistryDouble,
  type Latch,
} from '../testing';
import type { AgentTurnModelClient } from './mastra-turn';
import { ModelClient, type ModelCallResult } from './model-client';

/** How a held call ends once the test lets it go. */
type CallEnd = 'answer' | 'model_error' | 'abort';

/** One call of the port: its text parts, the tool call its generation carries, then a hold until the test ends it. */
interface HeldCall {
  readonly parts: readonly string[];
  readonly toolCall: boolean;
  readonly end: CallEnd;
  readonly held: Latch;
}

const USAGE = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** The port: each task's call streams its parts, holds at its latch, then answers or fails as its row says. */
function heldPort(
  callsByTask: ReadonlyMap<string, HeldCall>,
): AgentTurnModelClient {
  return {
    async streamTurn(call, { onText, signal }) {
      const task = call.messages[0];
      const held =
        task?.role === 'user' ? callsByTask.get(task.content) : undefined;
      if (held === undefined) throw new Error('No held call for this task');
      for (const part of held.parts) onText(part);
      await held.held.pass(signal);
      if (held.end === 'model_error') {
        const error = new Error('provider status 503');
        error.name = 'AI_APICallError';
        throw Object.assign(error, { statusCode: 503 });
      }
      return {
        finishReason: held.toolCall ? 'tool-calls' : 'stop',
        text: held.parts.join(''),
        toolCalls: held.toolCall
          ? [{ toolCallId: 'call-1', toolName: 'get_trace', args: { id: 7 } }]
          : [],
        usage: USAGE,
      };
    },
  };
}

function loggerDouble(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function modelClientOver(turnClient: AgentTurnModelClient): ModelClient {
  const logger = loggerDouble();
  return new ModelClient(
    turnClient,
    { record: async () => ({ callId: 'model-call-1', costUsd: 0 }) },
    { maxOutputTokens: 100 },
    logger,
    {
      model: async () => ({
        kind: 'allowed',
        price: {
          inputUsdPerMTok: 3,
          outputUsdPerMTok: 15,
          cacheReadUsdPerMTok: 0.3,
          cacheWriteUsdPerMTok: 3.75,
        },
      }),
      defaultChatModel: async () => 'anthropic/claude-default',
    },
    createProviderRegistryDouble({ anthropic: 'ready' }),
    async () => {},
    systemClock,
    { check: async () => 'allowed' as const },
  );
}

/** Starts the agent call of `taskId`, whose task message keys its held call in the port. */
function startCall(
  client: ModelClient,
  taskId: string,
  options: { readonly streamsText: boolean; readonly signal: AbortSignal },
): Promise<ModelCallResult> {
  return client.call({
    ownerId: 'owner-1',
    rootId: 'root-1',
    taskId,
    agentName: 'chat',
    model: 'anthropic/claude-turn',
    instructions: 'You are a chat.',
    messages: [{ role: 'user', content: taskId }],
    tools: [],
    streamsText: options.streamsText,
    training: false,
    signal: options.signal,
    logger: loggerDouble(),
  });
}

interface Row {
  readonly parts: readonly string[];
  readonly toolCall: boolean;
  readonly streamsText: boolean;
  readonly end: CallEnd;
  /** What `textOf` answers while the call is held. */
  readonly whileRunning: string;
  /** What the call gives once it ends. */
  readonly result: ModelCallResult['kind'] | 'aborted';
}

describe('ModelClient holds the text of a running agent call until the call ends', () => {
  // Rows (what the seam streams / how the call ends -> what `textOf(task)` answers before and after).
  // Catches: a stale text of a finished call that a later interrupt would write as a partial answer (a duplicate of the full one); a tool call leaking into the text (AC-01.6);
  //   the compaction summary written as an answer.
  // @category: edge-case  @dependency: ModelClient  @complexity: low
  it.each<[string, Row]>([
    [
      'two text parts, then an answer: the text so far while it runs, nothing after',
      {
        parts: ['Hel', 'lo'],
        toolCall: false,
        streamsText: true,
        end: 'answer',
        whileRunning: 'Hello',
        result: 'answer',
      },
    ],
    [
      'text parts, then a tool call in the answer: the text only, never the call',
      {
        parts: ['Checking ', 'the trace'],
        toolCall: true,
        streamsText: true,
        end: 'answer',
        whileRunning: 'Checking the trace',
        result: 'answer',
      },
    ],
    [
      'the call fails with model_error 503: nothing held afterwards',
      {
        parts: ['Старт'],
        toolCall: false,
        streamsText: true,
        end: 'model_error',
        whileRunning: 'Старт',
        result: 'model_error',
      },
    ],
    [
      'the step is aborted: nothing held from the abort on',
      {
        parts: ['Cut ', 'here'],
        toolCall: false,
        streamsText: true,
        end: 'abort',
        whileRunning: 'Cut here',
        result: 'aborted',
      },
    ],
    [
      'a compaction call (no parts to the feed): nothing held at all',
      {
        parts: ['Summary'],
        toolCall: false,
        streamsText: false,
        end: 'answer',
        whileRunning: '',
        result: 'answer',
      },
    ],
  ])('%s', async (_, row) => {
    const held = createLatch();
    const client = modelClientOver(
      heldPort(
        new Map([
          [
            'agent-1',
            { parts: row.parts, toolCall: row.toolCall, end: row.end, held },
          ],
        ]),
      ),
    );
    const controller = new AbortController();

    const running = startCall(client, 'agent-1', {
      streamsText: row.streamsText,
      signal: controller.signal,
    });
    await held.reached();
    expect(client.textOf('agent-1')).toBe(row.whileRunning);

    if (row.end === 'abort') {
      controller.abort(new Error('interrupted'));
      expect(client.textOf('agent-1')).toBe('');
    } else {
      held.open();
    }
    const outcome = await running.then(
      (result) => result.kind,
      () => 'aborted' as const,
    );
    expect(outcome).toBe(row.result);
    expect(client.textOf('agent-1')).toBe('');
  });

  it('keeps the text of each of two running calls by its own task', async () => {
    const heldA = createLatch();
    const heldB = createLatch();
    const client = modelClientOver(
      heldPort(
        new Map([
          [
            'agent-a',
            {
              parts: ['Answer ', 'A'],
              toolCall: false,
              end: 'answer',
              held: heldA,
            },
          ],
          [
            'agent-b',
            {
              parts: ['Answer B'],
              toolCall: false,
              end: 'answer',
              held: heldB,
            },
          ],
        ]),
      ),
    );
    const signal = new AbortController().signal;

    const callA = startCall(client, 'agent-a', { streamsText: true, signal });
    const callB = startCall(client, 'agent-b', { streamsText: true, signal });
    await Promise.all([heldA.reached(), heldB.reached()]);

    expect([client.textOf('agent-a'), client.textOf('agent-b')]).toEqual([
      'Answer A',
      'Answer B',
    ]);
    heldA.open();
    await callA;
    expect([client.textOf('agent-a'), client.textOf('agent-b')]).toEqual([
      '',
      'Answer B',
    ]);
    heldB.open();
    await callB;
  });
});
