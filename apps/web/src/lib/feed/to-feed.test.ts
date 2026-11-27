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
  threadSummary,
  DEEP_AGENT_NAME,
  deepAgentOrigin,
} from '@/test/fixtures';

import {
  applyDraftPart,
  canFork,
  draftAfterRead,
  feedViewOf,
  newDividerSeq,
  stripAgents,
  toFeed,
  trayEntries,
  type DraftPart,
  type OptimisticEntry,
  type AnswerRefusedPartData,
} from './to-feed';

/** `id` and the non-text parts of each message: `tool:<name>#<callId>` or the `data-*` part type. */
function summary(messages: readonly ThreadMessageLike[]): string[] {
  return messages.map((message) => {
    const parts = typeof message.content === 'string' ? [] : message.content;
    const marks = parts.flatMap((part) => {
      if (part.type === 'text') return [];
      if (part.type === 'tool-call')
        return [`tool:${part.toolName}#${part.toolCallId}`];
      if (part.type === 'data-answer-refused') {
        const data = part.data as AnswerRefusedPartData;
        return [
          `${part.type}:${'missingReport' in data ? data.missingReport : data.openTasks.join(',')}`,
        ];
      }
      return [part.type];
    });
    return [message.id, ...marks].join(' ');
  });
}

const task = historyEntry({ kind: 'task', seq: 1 });

/** A model answer at `seq` with text and finished calls `calls` (callId, tool). */
function answer(
  seq: number,
  calls: ReadonlyArray<[callId: string, tool: string]> = [],
): HistoryEntry {
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

function result(
  seq: number,
  callId: string,
  tool: string,
  outcome: 'success' | 'refused',
): HistoryEntry {
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
/** A refusal over open tasks: the model's text names other numbers, so the line must come from `openTasks`. */
const answerRefused: HistoryEntry = {
  seq: 5,
  kind: 'notice',
  createdAt: fixtureTime(5),
  content: {
    text: 'You cannot finish yet: 9. [in_progress] x',
    openTasks: [2, 3],
  },
};
/** A refusal for want of the final subagent's completed report: the line names it from `missingReport`. */
const reportNotice: HistoryEntry = {
  seq: 6,
  kind: 'notice',
  createdAt: fixtureTime(6),
  content: {
    text: 'You cannot finish: there is no report of subagent "other" yet.',
    missingReport: 'answer',
  },
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
  createdAt: fixtureTime(9),
};

describe('toFeed', () => {
  // KD-3, KD-4, Invariants 2 and 3 (the rule): order and content of the feed and the tray. `toolFree` — the answers
  // «Спросить в стороне» may cut after (improvements KD-3), checked where the row names them.
  it.each<{
    name: string;
    view: ReturnType<typeof conversationView>;
    draft: string | null;
    optimistic: OptimisticEntry[];
    feed: string[];
    tray: string[];
    toolFree?: string[];
  }>([
    {
      name: 'a chat request sits right under the answer with its call',
      view: conversationView({
        entries: [
          task,
          answer(2, [['c1', 'create_ticket']]),
          result(3, 'c1', 'create_ticket', 'success'),
          answer(4),
        ],
        decisions: [
          confirmation({
            decisionId: 'd1',
            agentId: 'root',
            createdAt: fixtureTime(2.5),
          }),
        ],
      }),
      draft: null,
      optimistic: [],
      feed: [
        'seq-1',
        'seq-2 tool:create_ticket#c1',
        'decision-d1 data-decision',
        'seq-4',
      ],
      tray: [],
    },
    {
      // improvements KD-3, AC-09.1: a fork the server refuses must not be offered after an answer with calls.
      name: 'only an answer without tool calls is tool-free',
      view: conversationView({
        entries: [
          task,
          answer(2, [['c1', 'create_ticket']]),
          result(3, 'c1', 'create_ticket', 'success'),
          answer(4),
        ],
      }),
      draft: null,
      optimistic: [],
      feed: ['seq-1', 'seq-2 tool:create_ticket#c1', 'seq-4'],
      tray: [],
      toolFree: ['seq-4'],
    },
    {
      name: 'a background agent request sits where it arrived',
      view: conversationView({
        entries: [task, answer(2), answer(3)],
        decisions: [
          confirmation({
            decisionId: 'd2',
            agentId: 'a1',
            createdAt: fixtureTime(2.5),
          }),
        ],
      }),
      draft: null,
      optimistic: [],
      feed: ['seq-1', 'seq-2', 'decision-d2 data-decision', 'seq-3'],
      tray: [],
    },
    {
      name: 'the deep agent run card sits right under the brief card',
      view: conversationView({
        entries: [
          task,
          answer(2, [['c2', 'start_deep_agent']]),
          result(3, 'c2', 'start_deep_agent', 'success'),
          answer(4),
        ],
        decisions: [
          confirmation({
            decisionId: 'brief',
            agentId: 'root',
            kind: 'agents.brief',
            tool: 'start_deep_agent',
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
            name: 'Исследование',
            origin: deepAgentOrigin(),
            createdAt: fixtureTime(2.5),
          }),
        ],
      }),
      draft: null,
      optimistic: [],
      feed: [
        'seq-1',
        'seq-2',
        'decision-brief data-decision',
        'agent-w1 data-run-card',
        'seq-4',
      ],
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
      feed: [
        'seq-1',
        'seq-2',
        'decision-d2 data-decision',
        'decision-d1 data-decision',
      ],
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
      view: conversationView({
        entries: [task, notice, compaction, answer(4)],
      }),
      draft: null,
      optimistic: [],
      feed: ['seq-1', 'seq-4'],
      tray: [],
    },
    {
      // uxrd.md MC-15, deep-agents KD-5: the employee sees the refusal, built from the numbers in the entry.
      name: 'a notice over open tasks is a feed line with their numbers',
      view: conversationView({
        entries: [task, notice, answer(4), answerRefused],
      }),
      draft: null,
      optimistic: [],
      feed: ['seq-1', 'seq-4', 'seq-5 data-answer-refused:2,3'],
      tray: [],
    },
    {
      // uxrd.md MC-15, deep-agents AC-05.1: the refusal for a lacking final report names the subagent from the entry.
      name: 'a notice over a lacking final report is a feed line with the subagent name',
      view: conversationView({ entries: [task, answer(4), reportNotice] }),
      draft: null,
      optimistic: [],
      feed: ['seq-1', 'seq-4', 'seq-6 data-answer-refused:answer'],
      tray: [],
    },
    {
      name: 'a feed entry whose messageId is queued stays at the end and out of the tray; the draft is last',
      view: conversationView({
        chat: {
          status: 'working',
          failureReason: null,
          rootAgentId: 'root',
          model: 'claude-haiku-4-5',
        },
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
  ])(
    'toFeed places entries by seq and decisions and run cards after the last entry created not later than them: $name',
    ({ view, draft, optimistic, feed, tray, toolFree }) => {
      const feedView = feedViewOf(view);
      const messages = toFeed(feedView, draft, optimistic);

      expect(summary(messages)).toEqual(feed);
      if (toolFree !== undefined)
        expect(
          messages
            .filter(
              (message) => message.metadata?.custom?.['toolFree'] === true,
            )
            .map((message) => message.id),
        ).toEqual(toolFree);
      expect(
        trayEntries(feedView, optimistic).entries.map((entry) => entry.id),
      ).toEqual(tray);
    },
  );

  // UXRD run card part 4: the deep agent card shows the question of the brief that started it; data-model KD-5:
  // the brief names its deep agent by name (here in another case), and another deep agent's brief is not its.
  it('the deep agent run card carries the question the brief ran with', () => {
    const view = conversationView({
      decisions: [
        confirmation({
          decisionId: 'brief',
          agentId: 'root',
          kind: 'agents.brief',
          args: {
            deepAgent: 'исследование',
            question: 'Исходный',
            boundaries: '',
            result: '',
          },
          content: {
            deepAgent: 'исследование',
            question: 'Исходный',
            boundaries: '',
            result: '',
          },
          status: 'resolved',
          resolution: {
            approve: true,
            args: {
              deepAgent: 'исследование',
              question: 'Исправленный',
              boundaries: '',
              result: '',
            },
          },
          createdAt: fixtureTime(2.2),
          resolvedAt: fixtureTime(2.4),
        }),
        confirmation({
          decisionId: 'other-brief',
          agentId: 'root',
          kind: 'agents.brief',
          args: {
            deepAgent: 'Ресерч логов',
            question: 'Чужой',
            boundaries: '',
            result: '',
          },
          content: {
            deepAgent: 'Ресерч логов',
            question: 'Чужой',
            boundaries: '',
            result: '',
          },
          status: 'resolved',
          resolution: {
            approve: true,
            args: {
              deepAgent: 'Ресерч логов',
              question: 'Чужой',
              boundaries: '',
              result: '',
            },
          },
          createdAt: fixtureTime(2.3),
          resolvedAt: fixtureTime(2.35),
        }),
      ],
      agents: [
        agentNode({
          agentId: 'w1',
          name: DEEP_AGENT_NAME,
          origin: deepAgentOrigin(),
          createdAt: fixtureTime(2.5),
        }),
      ],
    });

    const card = toFeed(feedViewOf(view), null, [])
      .flatMap((message) =>
        typeof message.content === 'string' ? [] : message.content,
      )
      .find((part) => part.type === 'data-run-card');

    expect(card).toMatchObject({
      data: { agentId: 'w1', briefQuestion: 'Исправленный' },
    });
  });

  // The `delta` rule: a part delivered twice or after a gap neither doubles nor loses text.
  it.each<{
    name: string;
    draft: string | null;
    part: DraftPart;
    expected: string | null;
  }>([
    {
      name: 'offset 0 in the middle of a draft starts it anew',
      draft: 'Привет',
      part: { offset: 0, text: 'Заново' },
      expected: 'Заново',
    },
    {
      name: 'offset equal to the length appends',
      draft: 'Привет',
      part: { offset: 6, text: ', мир' },
      expected: 'Привет, мир',
    },
    {
      name: 'a repeated part is dropped',
      draft: 'Привет',
      part: { offset: 3, text: 'вет' },
      expected: 'Привет',
    },
    {
      name: 'a part after a gap is dropped',
      draft: 'Привет',
      part: { offset: 9, text: 'дела' },
      expected: 'Привет',
    },
    {
      name: 'a part without a start is dropped',
      draft: null,
      part: { offset: 4, text: 'мир' },
      expected: null,
    },
  ])(
    'draft parts follow the offset rule: $name',
    ({ draft, part, expected }) => {
      expect(applyDraftPart(draft, part)).toBe(expected);
    },
  );

  // KD-2: a `delta` that arrives after its stored answer was read leaves no draft behind the answer.
  it('a late delta after the stored answer is dropped by the next read that finds the chat idle', () => {
    const view = feedViewOf(
      conversationView({
        chat: {
          status: 'idle',
          failureReason: null,
          rootAgentId: 'root',
          model: 'claude-haiku-4-5',
        },
        entries: [task, answer(2)],
      }),
    );
    const late = applyDraftPart(null, { offset: 0, text: 'Заметка ' });

    const draft = draftAfterRead({
      draftAtStart: late,
      draft: late,
      added: 0,
      view,
    });

    expect(summary(toFeed(view, draft, []))).toEqual(['seq-1', 'seq-2']);
  });
});

describe('canFork', () => {
  const chat = (status: 'idle' | 'working' | 'awaiting_confirmation') => ({
    status,
    failureReason: null,
    rootAgentId: 'root',
    model: 'claude-haiku-4-5',
  });

  // improvements KD-3, AC-14.2, AC-09.3: the branch buttons hide exactly when the server would refuse the fork.
  it.each([
    { name: 'an idle chat', view: conversationView(), expected: true },
    {
      name: 'the root works',
      view: conversationView({ chat: chat('working') }),
      expected: false,
    },
    {
      name: 'the root waits for a decision',
      view: conversationView({ chat: chat('awaiting_confirmation') }),
      expected: false,
    },
    {
      name: 'a subagent deeper in the tree works',
      view: conversationView({
        agents: [
          agentNode({
            agentId: 'a1',
            status: 'completed',
            children: [
              agentNode({ agentId: 'a2', parentId: 'a1', status: 'working' }),
            ],
          }),
        ],
      }),
      expected: false,
    },
    {
      name: 'an agent of the tree waits for a decision',
      view: conversationView({
        agents: [agentNode({ agentId: 'a1', status: 'awaiting_confirmation' })],
      }),
      expected: false,
    },
    {
      name: 'every agent of the tree has finished',
      view: conversationView({
        agents: [
          agentNode({ agentId: 'a1', status: 'completed' }),
          agentNode({ agentId: 'a2', status: 'failed' }),
        ],
      }),
      expected: true,
    },
    {
      name: 'a conversation that is not a chat',
      view: conversationView({
        thread: threadSummary({ id: 't1', forkable: false }),
      }),
      expected: false,
    },
  ])('$name → $expected', ({ view, expected }) => {
    expect(canFork(feedViewOf(view))).toBe(expected);
  });
});

describe('stripAgents', () => {
  const strip = (view: Parameters<typeof conversationView>[0]) =>
    stripAgents(feedViewOf(conversationView(view))).map(
      (agent) => `${agent.agentId}:${agent.status}:${agent.decisionId}`,
    );

  // improvements AC-12.1, AC-12.2, IM-11: who stands in the strip, as what, in which order, and which card it leads to.
  it.each([
    {
      name: 'a working and a waiting agent, the waiting first',
      view: {
        agents: [
          agentNode({ agentId: 'a1', status: 'working' }),
          agentNode({ agentId: 'a2', status: 'awaiting_confirmation' }),
          agentNode({ agentId: 'a3', status: 'completed' }),
        ],
        decisions: [confirmation({ decisionId: 'd2', agentId: 'a2' })],
      },
      expected: ['a2:awaiting_confirmation:d2', 'a1:working:null'],
    },
    {
      name: 'a deep agent whose subagent waits stands as waiting, on the subagent decision',
      view: {
        agents: [
          agentNode({
            agentId: 'deep',
            status: 'working',
            origin: deepAgentOrigin(),
            children: [
              agentNode({
                agentId: 'sub',
                parentId: 'deep',
                status: 'awaiting_confirmation',
              }),
            ],
          }),
        ],
        decisions: [
          confirmation({
            decisionId: 'd-old',
            agentId: 'sub',
            status: 'resolved',
          }),
          confirmation({ decisionId: 'd-sub', agentId: 'sub' }),
        ],
      },
      expected: ['deep:awaiting_confirmation:d-sub'],
    },
    {
      name: 'every agent has finished',
      view: {
        agents: [
          agentNode({ agentId: 'a1', status: 'completed' }),
          agentNode({ agentId: 'a2', status: 'failed' }),
        ],
      },
      expected: [],
    },
  ])('$name', ({ view, expected }) => {
    expect(strip(view)).toEqual(expected);
  });
});

describe('newDividerSeq', () => {
  const schedule = { scheduleId: 's1', name: 'Сводка', manual: false };
  const ownMessage = (seq: number) =>
    historyEntry({ kind: 'user_message', seq });
  const dividerOf = (
    entries: HistoryEntry[],
    range: { afterSeq: number; throughSeq: number },
  ) =>
    newDividerSeq(
      toFeed(feedViewOf(conversationView({ entries })), null, []),
      range,
    );

  // improvements KD-4, AC-11.2, FR-11: the divider stands before the first unread message the employee did not write.
  it.each([
    {
      name: 'before the first unread answer',
      entries: [task, answer(2), ownMessage(3), answer(4)],
      range: { afterSeq: 2, throughSeq: 4 },
      expected: 4,
    },
    {
      name: "before a schedule's message in a schedule's conversation",
      entries: [
        historyEntry({
          kind: 'task',
          seq: 1,
          content: { text: 'Сводка', record: null, schedule },
        }),
        answer(2),
      ],
      range: { afterSeq: 0, throughSeq: 2 },
      expected: 1,
    },
    {
      name: "none in the employee's new conversation",
      entries: [task],
      range: { afterSeq: 0, throughSeq: 1 },
      expected: null,
    },
    {
      name: 'none for an answer that came after opening',
      entries: [task, answer(2)],
      range: { afterSeq: 0, throughSeq: 1 },
      expected: null,
    },
  ])('$name', ({ entries, range, expected }) => {
    expect(dividerOf(entries, range)).toBe(expected);
  });
});
