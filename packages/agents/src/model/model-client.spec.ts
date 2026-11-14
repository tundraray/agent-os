// KD-3 (offset), Flow 1 Failure handling (a retry starts the parts again at offset 0), Invariant 4 (a
// `completeText` call is a ledger row without `taskId`), Contract «Расширения нижних пакетов» (a failing
// hook is logged and does not break the step). The port and the ledger are doubles; the clock fires the
// retry pause at once.
import type { Logger } from '@agent-os/common';
import type { Clock, ModelCallRecord } from '@agent-os/runtime';
import type { AgentTurnModelClient } from './mastra-turn.js';
import { createModelClient, type TextDelta } from './model-client.js';

/** One attempt of the port: its text parts, then the provider status it fails with, if any. */
interface PortAttempt {
  readonly parts: readonly string[];
  readonly failWith?: number;
}

const USAGE = { inputTokens: 10, outputTokens: 2, cachedInputTokens: null, cacheCreationInputTokens: null };
const LEDGER_USAGE = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

function portDouble(attempts: readonly PortAttempt[]): AgentTurnModelClient {
  let calls = 0;
  return {
    async streamTurn(_call, { onText }) {
      const attempt = attempts[calls];
      calls += 1;
      if (attempt === undefined) throw new Error(`No attempt ${calls} in the port double`);
      for (const part of attempt.parts) onText(part);
      if (attempt.failWith !== undefined) {
        const error = new Error(`provider status ${attempt.failWith}`);
        error.name = 'AI_APICallError';
        throw Object.assign(error, { statusCode: attempt.failWith });
      }
      return { finishReason: 'stop', text: attempt.parts.join(''), toolCalls: [], usage: USAGE };
    },
  };
}

function loggerDouble(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

interface Row {
  readonly act: 'call' | 'completeText';
  readonly attempts: readonly PortAttempt[];
  readonly hookFails: boolean;
  readonly text: string;
  readonly deltas: readonly Pick<TextDelta, 'offset' | 'text'>[];
  readonly pauses: readonly number[];
  readonly ledgerRow: ModelCallRecord;
  readonly hookWarnings: number;
}

describe('ModelClient streams text parts with running offsets, restarts them on a retry, and survives a failing hook', () => {
  it.each<[string, Row]>([
    [
      'three parts of an answer carry offsets 0, len(p1), len(p1)+len(p2) and give one ledger row',
      {
        act: 'call',
        attempts: [{ parts: ['Hel', 'lo, ', 'world'] }],
        hookFails: false,
        text: 'Hello, world',
        deltas: [
          { offset: 0, text: 'Hel' },
          { offset: 3, text: 'lo, ' },
          { offset: 7, text: 'world' },
        ],
        pauses: [],
        ledgerRow: { ownerId: 'owner-1', taskId: 'agent-1', model: 'anthropic/claude-turn', usage: LEDGER_USAGE },
        hookWarnings: 0,
      },
    ],
    [
      'an attempt that streamed a part and failed is retried after the pause from offset 0',
      {
        act: 'call',
        attempts: [{ parts: ['Stale'], failWith: 503 }, { parts: ['Fresh', ' answer'] }],
        hookFails: false,
        text: 'Fresh answer',
        deltas: [
          { offset: 0, text: 'Stale' },
          { offset: 0, text: 'Fresh' },
          { offset: 5, text: ' answer' },
        ],
        pauses: [1000],
        ledgerRow: { ownerId: 'owner-1', taskId: 'agent-1', model: 'anthropic/claude-turn', usage: LEDGER_USAGE },
        hookWarnings: 0,
      },
    ],
    [
      'a hook that throws is a warning and the call still answers',
      {
        act: 'call',
        attempts: [{ parts: ['a', 'b'] }],
        hookFails: true,
        text: 'ab',
        deltas: [
          { offset: 0, text: 'a' },
          { offset: 1, text: 'b' },
        ],
        pauses: [],
        ledgerRow: { ownerId: 'owner-1', taskId: 'agent-1', model: 'anthropic/claude-turn', usage: LEDGER_USAGE },
        hookWarnings: 2,
      },
    ],
    [
      'completeText writes a ledger row without taskId and gives no parts to the hook',
      {
        act: 'completeText',
        attempts: [{ parts: ['Ti', 'tle'] }],
        hookFails: false,
        text: 'Title',
        deltas: [],
        pauses: [],
        ledgerRow: { ownerId: 'owner-1', model: 'anthropic/claude-default', usage: LEDGER_USAGE },
        hookWarnings: 0,
      },
    ],
  ])('%s', async (_, row) => {
    const deltas: TextDelta[] = [];
    const ledgerRows: ModelCallRecord[] = [];
    const pauses: number[] = [];
    const logger = loggerDouble();
    const clock: Clock = {
      now: () => new Date(0),
      random: () => 0,
      setTimer: (ms, callback) => {
        pauses.push(ms);
        queueMicrotask(callback);
        return () => {};
      },
    };
    const client = createModelClient({
      turnClient: portDouble(row.attempts),
      ledger: {
        record: async (call) => {
          ledgerRows.push(call);
          return { callId: 'model-call-1', costUsd: 0 };
        },
      },
      config: { maxOutputTokens: 100, defaultModel: 'anthropic/claude-default' },
      logger,
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (row.hookFails) throw new Error('notify is down');
      },
      clock,
    });

    const text =
      row.act === 'call'
        ? await client
            .call({
              ownerId: 'owner-1',
              rootId: 'root-1',
              taskId: 'agent-1',
              agentName: 'chat',
              model: 'anthropic/claude-turn',
              instructions: 'You are a chat.',
              messages: [{ role: 'user', content: 'Hi' }],
              tools: [],
              streamsText: true,
              signal: new AbortController().signal,
              logger,
            })
            .then((result) => (result.kind === 'answer' ? result.text : `model_error ${result.error.statusCode}`))
        : await client.completeText({
            ownerId: 'owner-1',
            system: 'Write a title.',
            prompt: 'Hi',
            maxOutputTokens: 64,
            signal: new AbortController().signal,
          });

    expect(text).toBe(row.text);
    expect(deltas.map(({ offset, text: part }) => ({ offset, text: part }))).toEqual(row.deltas);
    for (const delta of deltas) {
      expect(delta).toMatchObject({ ownerId: 'owner-1', rootId: 'root-1', agentId: 'agent-1' });
    }
    expect(pauses).toEqual(row.pauses);
    expect(ledgerRows).toStrictEqual([row.ledgerRow]);
    const hookWarnings = logger.warn.mock.calls.filter(([message]) => message === 'text delta hook failed');
    expect(hookWarnings).toHaveLength(row.hookWarnings);
    for (const [, fields] of hookWarnings) {
      expect(fields).toEqual({ agentId: 'agent-1', error: 'notify is down' });
    }
  });
});
