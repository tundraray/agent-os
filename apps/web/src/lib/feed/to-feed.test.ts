import type { HistoryEntry } from '@agent-os/contracts';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { describe, expect, it } from 'vitest';

import {
  agentNode,
  confirmation,
  conversationView,
  fixtureTime,
  historyEntry,
  pendingMessage,
} from '@/test/fixtures';

import {
  applyDraftPart,
  draftAfterRead,
  feedViewOf,
  toFeed,
  trayEntries,
  type DraftPart,
  type OptimisticEntry,
} from './to-feed';

/** `id` and the non-text parts of each message: `tool:<name>#<callId>` or the `data-*` part type. */
function summary(messages: readonly ThreadMessageLike[]): string[] {
  return messages.map((message) => {
    const parts = typeof message.content === 'string' ? [] : message.content;
    const marks = parts.flatMap((part) => {
      if (part.type === 'text') return [];
      if (part.type === 'tool-call') return [`tool:${part.toolName}#${part.toolCallId}`];
      return [part.type];
    });
    return [message.id, ...marks].join(' ');
  });
}

const task = historyEntry({ kind: 'task', seq: 1 });

/** A model answer at `seq` with text and finished calls `calls` (callId, tool). */
function answer(seq: number, calls: ReadonlyArray<[callId: string, tool: string]> = []): HistoryEntry {
  return historyEntry({
    kind: 'model_answer',
    seq,
    content: {
      text: 'Ответ',
      toolCalls: calls.map(([callId, tool]) => ({
        callId,
        tool,
        server: null,
        args: {},
        state: 'done' as const,
      })),
    },
  });
}

function result(seq: number, callId: string, tool: string, outcome: 'success' | 'refused'): HistoryEntry {
  return historyEntry({
    kind: 'tool_result',
    seq,
    content: {
      callId,
      tool,
      server: null,
      outcome,
      refusalReason: outcome === 'refused' ? 'depth_limit' : null,
    },
  });
}

const notice: HistoryEntry = {
  seq: 2,
  kind: 'notice',
  createdAt: fixtureTime(2),
  content: { text: 'Заметка для модели' },
};
const compaction: HistoryEntry = {
  seq: 3,
  kind: 'compaction',
  createdAt: fixtureTime(3),
  content: { summary: 'Сводка', throughSeq: 2 },
};

const sentLocally: OptimisticEntry = {
  localId: 'o1',
  text: 'И приложи ссылки',
  place: 'feed',
  messageId: 'm1',
  first: false,
  interrupt: false,
  createdAt: fixtureTime(9),
};

describe('toFeed', () => {
  // KD-3, KD-4, Invariants 2 and 3 (the rule): order and content of the feed and the tray.
  it.each([
    {
      name: 'a chat request sits right under the answer with its call',
      view: conversationView({
        entries: [
          task,
          answer(2, [['c1', 'create_ticket']]),
          result(3, 'c1', 'create_ticket', 'success'),
          answer(4),
        ],
        decisions: [confirmation({ decisionId: 'd1', agentId: 'root', createdAt: fixtureTime(2.5) })],
      }),
      draft: null,
      optimistic: [],
      feed: ['seq-1', 'seq-2 tool:create_ticket#c1', 'decision-d1 data-decision', 'seq-4'],
      tray: [],
    },
    {
      name: 'a background agent request sits where it arrived',
      view: conversationView({
        entries: [task, answer(2), answer(3)],
        decisions: [confirmation({ decisionId: 'd2', agentId: 'a1', createdAt: fixtureTime(2.5) })],
      }),
      draft: null,
      optimistic: [],
      feed: ['seq-1', 'seq-2', 'decision-d2 data-decision', 'seq-3'],
      tray: [],
    },
    {
      name: 'the coordinator run card sits right under the brief card',
      view: conversationView({
        entries: [
          task,
          answer(2, [['c2', 'start_workflow']]),
          result(3, 'c2', 'start_workflow', 'success'),
          answer(4),
        ],
        decisions: [
          confirmation({
            decisionId: 'brief',
            agentId: 'root',
            kind: 'workflows.brief',
            tool: 'start_workflow',
            server: null,
            status: 'resolved',
            resolution: { approve: true, args: {} },
            createdAt: fixtureTime(2.2),
            resolvedAt: fixtureTime(2.4),
          }),
        ],
        agents: [
          agentNode({
            agentId: 'w1',
            definition: 'research',
            template: { name: 'research', title: 'Исследование' },
            createdAt: fixtureTime(2.5),
          }),
        ],
      }),
      draft: null,
      optimistic: [],
      feed: ['seq-1', 'seq-2', 'decision-brief data-decision', 'agent-w1 data-run-card', 'seq-4'],
      tray: [],
    },
    {
      name: 'equal times keep the order of the API list',
      view: conversationView({
        entries: [task, answer(2)],
        decisions: [
          confirmation({ decisionId: 'd2', createdAt: fixtureTime(2) }),
          confirmation({ decisionId: 'd1', createdAt: fixtureTime(2) }),
        ],
      }),
      draft: null,
      optimistic: [],
      feed: ['seq-1', 'seq-2', 'decision-d2 data-decision', 'decision-d1 data-decision'],
      tray: [],
    },
    {
      name: 'a successful start_agent is not drawn, a refused one is',
      view: conversationView({
        entries: [
          task,
          answer(2, [
            ['c1', 'start_agent'],
            ['c2', 'start_agent'],
          ]),
          result(3, 'c1', 'start_agent', 'success'),
          result(4, 'c2', 'start_agent', 'refused'),
        ],
        agents: [agentNode({ agentId: 'a1', createdAt: fixtureTime(2.5) })],
      }),
      draft: null,
      optimistic: [],
      feed: ['seq-1', 'seq-2 tool:start_agent#c2', 'agent-a1 data-run-card'],
      tray: [],
    },
    {
      name: 'notice and compaction stay out of the feed',
      view: conversationView({ entries: [task, notice, compaction, answer(4)] }),
      draft: null,
      optimistic: [],
      feed: ['seq-1', 'seq-4'],
      tray: [],
    },
    {
      name: 'a feed entry whose messageId is queued stays at the end and out of the tray; the draft is last',
      view: conversationView({
        chat: { status: 'working', failureReason: null, rootAgentId: 'root', model: 'claude-haiku-4-5' },
        entries: [task, answer(2)],
        pending: [
          pendingMessage({ messageId: 'm1', text: 'И приложи ссылки' }),
          pendingMessage({ messageId: 'm2', text: 'Ещё одно' }),
        ],
      }),
      draft: 'Пишу ответ',
      optimistic: [sentLocally],
      feed: ['seq-1', 'seq-2', 'local-o1', 'draft'],
      tray: ['m2'],
    },
  ])('toFeed places entries by seq and decisions and run cards after the last entry created not later than them: $name', ({ view, draft, optimistic, feed, tray }) => {
    const feedView = feedViewOf(view);

    expect(summary(toFeed(feedView, draft, optimistic))).toEqual(feed);
    expect(trayEntries(feedView, optimistic).entries.map((entry) => entry.id)).toEqual(tray);
  });

  // UXRD run card part 4: the workflow card shows the question of the brief that started it.
  it('the workflow run card carries the question the brief ran with', () => {
    const view = conversationView({
      decisions: [
        confirmation({
          decisionId: 'brief',
          agentId: 'root',
          kind: 'workflows.brief',
          args: { template: 'research', question: 'Исходный', boundaries: '', result: '' },
          content: { title: 'Исследование', question: 'Исходный', boundaries: '', result: '' },
          status: 'resolved',
          resolution: { approve: true, args: { template: 'research', question: 'Исправленный', boundaries: '', result: '' } },
          createdAt: fixtureTime(2.2),
          resolvedAt: fixtureTime(2.4),
        }),
      ],
      agents: [
        agentNode({
          agentId: 'w1',
          definition: 'research',
          template: { name: 'research', title: 'Исследование' },
          createdAt: fixtureTime(2.5),
        }),
      ],
    });

    const card = toFeed(feedViewOf(view), null, [])
      .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
      .find((part) => part.type === 'data-run-card');

    expect(card).toMatchObject({ data: { agentId: 'w1', briefQuestion: 'Исправленный' } });
  });

  // The `delta` rule: a part delivered twice or after a gap neither doubles nor loses text.
  it.each<{ name: string; draft: string | null; part: DraftPart; expected: string | null }>([
    { name: 'offset 0 in the middle of a draft starts it anew', draft: 'Привет', part: { offset: 0, text: 'Заново' }, expected: 'Заново' },
    { name: 'offset equal to the length appends', draft: 'Привет', part: { offset: 6, text: ', мир' }, expected: 'Привет, мир' },
    { name: 'a repeated part is dropped', draft: 'Привет', part: { offset: 3, text: 'вет' }, expected: 'Привет' },
    { name: 'a part after a gap is dropped', draft: 'Привет', part: { offset: 9, text: 'дела' }, expected: 'Привет' },
    { name: 'a part without a start is dropped', draft: null, part: { offset: 4, text: 'мир' }, expected: null },
  ])('draft parts follow the offset rule: $name', ({ draft, part, expected }) => {
    expect(applyDraftPart(draft, part)).toBe(expected);
  });

  // KD-2: a `delta` that arrives after its stored answer was read leaves no draft behind the answer.
  it('a late delta after the stored answer is dropped by the next read that finds the chat idle', () => {
    const view = feedViewOf(
      conversationView({
        chat: { status: 'idle', failureReason: null, rootAgentId: 'root', model: 'claude-haiku-4-5' },
        entries: [task, answer(2)],
      }),
    );
    const late = applyDraftPart(null, { offset: 0, text: 'Заметка ' });

    const draft = draftAfterRead({ draftAtStart: late, draft: late, added: 0, view });

    expect(summary(toFeed(view, draft, []))).toEqual(['seq-1', 'seq-2']);
  });
});
