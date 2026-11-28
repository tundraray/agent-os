// live-feed / web - toFeed over a window that does not start at the first entry (pure function, no React).
// Design Doc: docs/features/live-feed/design-web.md (KD-3). PRD: docs/features/live-feed/prd.md (AC-07.2).
// Generated: 2026-11-28 | Part: web | Test type: Unit (provenAt: unit)
//
// One table: the three conditions of KD-3 are one rule - "something older than the window exists" - with a few rows.
// Not tested: the alignment on the divider only at open (a scroll effect, see the generation report), the unchanged
// full-history assembly (to-feed.test.ts).

import { describe, expect, it } from 'vitest';

import {
  agentNode,
  confirmation,
  conversationView,
  fixtureTime,
  historyEntry,
} from '@/test/fixtures';

import {
  feedViewOf,
  lacksTask,
  newDividerSeq,
  toFeed,
  windowStartOf,
} from './to-feed';

// A window of a long conversation: an answer, the employee's own message, an answer; no task entry.
const entries = [
  historyEntry({ kind: 'model_answer', seq: 50 }),
  historyEntry({ kind: 'user_message', seq: 51 }),
  historyEntry({ kind: 'model_answer', seq: 52 }),
];
// Every card was created long before the window's first entry.
const old = fixtureTime(10);
const decisions = [
  confirmation({ decisionId: 'd-old', status: 'resolved', createdAt: old }),
  confirmation({ decisionId: 'd-open', status: 'open', createdAt: old }),
];
const agents = [
  agentNode({ agentId: 'a-done', status: 'completed', createdAt: old }),
  agentNode({ agentId: 'a-work', status: 'working', createdAt: old }),
];

describe('toFeed - partial history window (KD-3)', () => {
  // AC: AC-07.2 "given непрочитанного больше, then лента стоит на последних записях, а разделитель найдётся в предыдущих записях."
  // Catches: a divider on the first reply of the window while the first unread lies above it; a stack of old cards over the first
  //   entry of a long conversation; the first message text shown as the refusal text of a send in a long conversation.
  it.each([
    {
      name: 'a window whose «seen» mark lies above it',
      hasOlder: true,
      seenThroughSeq: 40,
      lacksTask: false,
      messages: [
        'decision-d-open',
        'agent-a-work',
        'seq-50',
        'seq-51',
        'seq-52',
      ],
      divider: null,
    },
    {
      name: 'a window that holds the «seen» mark',
      hasOlder: true,
      seenThroughSeq: 50,
      lacksTask: false,
      messages: [
        'decision-d-open',
        'agent-a-work',
        'seq-50',
        'seq-51',
        'seq-52',
      ],
      divider: 52,
    },
    {
      name: 'the start of the history',
      hasOlder: false,
      seenThroughSeq: 40,
      lacksTask: true,
      messages: [
        'decision-d-old',
        'decision-d-open',
        'agent-a-done',
        'agent-a-work',
        'seq-50',
        'seq-51',
        'seq-52',
      ],
      divider: 50,
    },
  ])('$name', (row) => {
    const view = feedViewOf(
      conversationView({
        entries,
        decisions,
        agents,
        hasOlder: row.hasOlder,
        seenThroughSeq: row.seenThroughSeq,
      }),
    );
    const messages = toFeed(view, null, []);

    expect(lacksTask(view)).toBe(row.lacksTask);
    expect(messages.map((message) => message.id)).toEqual(row.messages);
    expect(
      newDividerSeq(
        messages,
        { afterSeq: row.seenThroughSeq, throughSeq: 52 },
        windowStartOf(view),
      ),
    ).toBe(row.divider);
  });
});
