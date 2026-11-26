// schedules-search-memory / conversation-search - web integration: opening a match in the feed
// Design Doc: docs/features/schedules-search-memory/design-conversation-search.md, Test Strategy UC-3 (open a match).
// Generated: 2026-11-25 | Budget: 1 of the part's 4 integration skeletons (the API ones are in apps/api/test/conversation-search.int.e2e-spec.ts)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime over the feed store)
//
// Harness (like shell.open-thread.int.test.tsx): `renderWithRuntime` from '@/test/render-with-runtime', MSW server from '@/test/msw-server',
//   fixtures from '@/test/fixtures' (`conversationView`, `agentPageView`, `historyEntry`). The search store is real and is given the target
//   (conversation or agent, `seq` or `callId`) the way the list of matches does it: the test types in the field and opens a match; the page
//   address is the ordinary `threadPath` / `agentPath`. jsdom has no layout: the scroll call (a `scrollIntoView` spy, as for the queue
//   tray) is the observable.
// Mock boundary: network (MSW) + next/navigation only; Thread, feed store, search store, tool-call block are real.
//
// Not repeated here: the match list and field (UC-4), the route (API UC-1).

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { START_AGENT_TOOL, type ConversationMatch } from '@agent-os/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import {
  agentPageView,
  conversationMatch,
  conversationView,
  historyEntry,
  searchResponse,
  threadList,
  threadSummary,
} from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';

const thread = threadSummary({ id: 't-1', title: 'Сбои оплаты' });

/** A done call of the model answer at `seq`. */
const answerWithCall = (
  seq: number,
  text: string,
  call: { callId: string; tool: string; server: string | null },
) =>
  historyEntry({
    kind: 'model_answer',
    seq,
    content: {
      text,
      toolCalls: [{ ...call, args: { query: 'оплата' }, state: 'done' }],
    },
  });

const resultOf = (
  seq: number,
  call: { callId: string; tool: string; server: string | null },
) =>
  historyEntry({
    kind: 'tool_result',
    seq,
    content: { ...call, text: 'timeout payment-service', outcome: 'success' },
  });

const LOG_CALL = { callId: 'c-log', tool: 'search', server: 'logs' };
const AGENT_CALL = { callId: 'c-agent', tool: START_AGENT_TOOL, server: null };

/**
 * The conversation over two history pages: seq 2 calls a tool inside a collapsed group of calls; seq 6 starts a
 * sub-agent and is drawn as its card, not as a call block.
 */
const FIRST_PAGE = [
  historyEntry({
    kind: 'task',
    seq: 1,
    content: { text: 'Разбери сбои оплаты' },
  }),
  answerWithCall(2, 'Смотрю логи.', LOG_CALL),
  resultOf(3, LOG_CALL),
  historyEntry({
    kind: 'model_answer',
    seq: 4,
    content: { text: 'В логах timeout payment-service.', toolCalls: [] },
  }),
];
const SECOND_PAGE = [
  historyEntry({
    kind: 'user_message',
    seq: 5,
    content: { text: 'Проверь шлюз' },
  }),
  answerWithCall(6, 'Запускаю разбор.', AGENT_CALL),
  resultOf(7, AGENT_CALL),
  historyEntry({
    kind: 'model_answer',
    seq: 8,
    content: { text: 'Готово.', toolCalls: [] },
  }),
];

const SUB_AGENT_CALL = { callId: 'c-sub', tool: 'search', server: 'logs' };

/** The search answer the field gets: one match per row of the test. */
const MATCHES: ConversationMatch[] = [
  conversationMatch({ threadId: 't-1', title: 'Сбои оплаты', seq: 4 }),
  conversationMatch({ threadId: 't-1', title: 'Сбои оплаты', seq: 1 }),
  conversationMatch({
    threadId: 't-1',
    title: 'Сбои оплаты',
    place: 'tool_result',
    agent: { agentId: 'a1', name: 'Разбор логов' },
    tool: 'search',
    seq: null,
    callId: SUB_AGENT_CALL.callId,
  }),
  conversationMatch({
    threadId: 't-1',
    title: 'Сбои оплаты',
    place: 'tool_result',
    tool: START_AGENT_TOOL,
    seq: null,
    callId: AGENT_CALL.callId,
  }),
];

const markedElements = (): Element[] =>
  Array.from(document.querySelectorAll('[data-search-target]'));

describe('Thread: the target of an opened match (UC-3)', () => {
  // AC-13.1: "Given совпадение в сообщении месячной давности, when сотрудник открывает его, then беседа открыта, и найденное сообщение
  //   на экране."
  // AC-13.2: "Given совпадение в беседе сабагента, when сотрудник открывает его, then открыт экран этого сабагента со ссылкой на беседу
  //   сотрудника."
  // DC-4: the target is not drawn in the feed (a call the feed shows as a card) -> the conversation opens as usual, without a mark.
  // Behavior: a target in the store + a long history that the feed loads to the end -> Thread finds the element by its data attribute
  //   (message `seq`; tool-call block by `callId`) -> scrolls it to the upper third, marks it and focuses it; the call block is expanded.
  //   Rows: an old message in a long conversation, then another one in the same feed; a tool result on the sub-agent's agent screen (its path to the employee's conversation is present); a target that has
  //   no element (card) -> no mark, no scroll, no error.
  // Catches: the result's target being the message instead of the call block (collapsed block, nothing marked); the mark staying on a
  //   previous match or the feed throwing when the target element does not exist.
  // @category: core-functionality
  // @dependency: Thread, tool-fallback block, search store, FeedStore, MSW
  // @complexity: high
  it('UC-3: an old message is scrolled to, marked and focused; a tool result expands and marks its call block; a card target opens the feed unmarked', async () => {
    // Arrange: the conversation's history comes in two pages; the agent page holds the sub-agent's call and its result.
    server.use(
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(threadList([thread])),
      ),
      http.get(`${API}/api/threads/t-1`, () => HttpResponse.json(thread)),
      http.get(`${API}/api/threads/t-1/history`, ({ request }) => {
        const afterSeq = new URL(request.url).searchParams.get('afterSeq');
        return HttpResponse.json(
          afterSeq === '0'
            ? conversationView({
                thread,
                entries: FIRST_PAGE,
                nextAfterSeq: 4,
              })
            : conversationView({ thread, entries: SECOND_PAGE }),
        );
      }),
      http.get(`${API}/api/agents/a1/history`, () =>
        HttpResponse.json(
          agentPageView({
            agent: {
              agentId: 'a1',
              description: 'Разбор логов',
              threadId: 't-1',
              threadTitle: 'Сбои оплаты',
            },
            entries: [
              historyEntry({
                kind: 'task',
                seq: 1,
                content: { text: 'Найди сбои в логах' },
              }),
              answerWithCall(2, 'Ищу.', SUB_AGENT_CALL),
              resultOf(3, SUB_AGENT_CALL),
            ],
          }),
        ),
      ),
      http.get(`${API}/api/search`, () =>
        HttpResponse.json(searchResponse(MATCHES)),
      ),
    );
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    const user = userEvent.setup();
    const view = renderWithRuntime({ pathname: '/' });
    await user.type(
      screen.getByRole('searchbox', { name: 'Поиск по беседам' }),
      'payment-service',
    );
    const matches = await screen.findByRole('list', { name: 'Совпадения' });
    const openMatch = async (index: number, path: string): Promise<void> => {
      await user.click(within(matches).getAllByRole('link')[index]);
      expect(view.router.push.mock.lastCall?.[0]).toBe(path);
      view.setPathname(path);
    };

    // Act (row 1): an old message of the first history page
    await openMatch(0, '/chat/t-1');

    // Assert (row 1): the answer of seq 4 is scrolled to, marked and focused, with the second page in too
    const answer = (
      await screen.findByText('В логах timeout payment-service.')
    ).closest('[data-role="assistant"]');
    await waitFor(() => expect(answer).toHaveFocus());
    expect(screen.getByText('Готово.')).toBeInTheDocument();
    expect(markedElements()).toEqual([answer]);
    expect(scrolled.mock.contexts).toEqual([answer]);

    // Act (row 1, another match in the same feed): the task
    await openMatch(1, '/chat/t-1');

    // Assert: the mark moved from the previous match to the task
    const task = screen
      .getByText('Разбери сбои оплаты')
      .closest('[data-role="user"]');
    await waitFor(() => expect(task).toHaveFocus());
    expect(markedElements()).toEqual([task]);
    expect(scrolled.mock.contexts).toEqual([answer, task]);

    // Act (row 2): a tool result of the sub-agent
    await openMatch(2, '/agents/a1');

    // Assert (row 2): the agent screen with its path to the employee's conversation; the call block is expanded, marked and focused
    const block = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        `[data-call-id="${SUB_AGENT_CALL.callId}"]`,
      );
      expect(found).not.toBeNull();
      return found;
    });
    await waitFor(() => expect(block).toHaveFocus());
    expect(markedElements()).toEqual([block]);
    expect(
      within(block as HTMLElement).getByRole('button', { expanded: true }),
    ).toBeInTheDocument();
    expect(
      within(block as HTMLElement).getByText('timeout payment-service'),
    ).toBeInTheDocument();
    expect(scrolled.mock.contexts).toEqual([answer, task, block]);
    expect(
      screen
        .getAllByRole('link', { name: /Сбои оплаты/ })
        .some((link) => link.getAttribute('href') === '/chat/t-1'),
    ).toBe(true);

    // Act (row 3): the start of a sub-agent, which the conversation draws as its card
    await openMatch(3, '/chat/t-1');

    // Assert (row 3): the conversation is open as usual, nothing is marked or scrolled, the previous mark is gone
    expect(await screen.findByText('Запускаю разбор.')).toBeInTheDocument();
    expect(await screen.findByText('Готово.')).toBeInTheDocument();
    // Gives the feed the frames in which it would look for the target.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(markedElements()).toEqual([]);
    expect(
      document.querySelector(`[data-call-id="${AGENT_CALL.callId}"]`),
    ).toBeNull();
    expect(scrolled.mock.contexts).toEqual([answer, task, block]);
  });
});
