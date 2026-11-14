// agent-platform / web Integration Test — Design Doc: docs/features/agent-platform/design-web.md (v1.1)
// File: agent-platform-web.int.test.tsx — Test Strategy, "Main Use Cases" UC-1..UC-4 and "Error and Edge Use Cases" UC-E1 (the five tested use cases)
// Generated: 2026-11-14 | Budget Used: 5 integration skeletons (design-mandated: Test Strategy marks exactly these five surfaces as tested;
//   over the 3-test default, within the 5-test ceiling — each names a defect no other test catches, see "Catches"), 0/2 E2E (L1 checklist instead)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom). all five cases are implemented.
//
// NOT covered here on purpose (design marks them L1, real browser only): UC-5 spend (AC-29.1, AC-29.2), UC-E2 agent not found
//   (AC-13.3, AC-21.2), UC-N1 accessibility and width (NFR-08), and the layout/animation checks of the L1 table.
//   Not tested at all: assistant-ui behaviour with the external store (spike S-1), EventSource reconnect internals, pure presentation.
//
// Harness (src/test/): renderWithRuntime(options) from '@/test/render-with-runtime' mounts ChatRuntimeProvider + ChatShell with mocked
//   next/navigation (controlled pathname, router spy). MSW server from '@/test/msw-server' (onUnhandledRequest: 'error').
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test'. TZ = 'Europe/Berlin'.
//   The implementation tasks rewrite the harness: the AI SDK fixtures (sseFromChunks, historyMessages) go away; the fixtures
//   for ConversationView, AgentPageView, AgentNode, Confirmation and the `/api/events` frames come with the tasks.
// Mock boundary: network (MSW) and the event source injected into LiveStore (jsdom has no EventSource; the test supplies its own source and
//   pushes `ready`, `tree` and `delta` frames through it) + next/navigation. LiveStore, FeedStore, toFeed, useFeedRuntime, the shell,
//   assistant-ui and every component — real. Do NOT mock lib/threads/*, lib/config.ts, @assistant-ui/* or the stores.
//   Contracts: docs/features/agent-platform/design-chat.md (ConversationView, AgentPageView, AgentNode, Confirmation, history `afterSeq`).
import {
  DecisionRequestSchema,
  InterruptRequestSchema,
  SendMessageRequestSchema,
  WORKFLOWS_BRIEF_CONFIRMATION,
  type AgentListPage,
  type AgentPageView,
  type Confirmation,
  type ConversationView,
  type DecisionRequest,
  type DecisionResponse,
  type InterruptRequest,
  type InterruptResponse,
  type RestartResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type StopResponse,
  type ThreadSummary,
} from '@agent-os/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  agentListPage,
  agentNode,
  agentPageView,
  confirmation,
  conversationView,
  deferred,
  fixtureTime,
  historyEntry,
  pendingMessage,
  threadList,
  threadSummary,
  type Deferred,
} from '@/test/fixtures';
import { createTestLiveSource, type TestLiveSource } from '@/test/live-source';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';
const THREAD = threadSummary({ id: 'a', title: 'Выгрузка' });
/** The stream once the shell watches conversation `a` (KD-2). */
const WATCH_A = `${API}/api/events?watch=thread%3Aa`;

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------
// Local helpers: the emulated server of conversation `a` and a readable picture of the feed.

type ConversationServer = {
  /** What the server holds now; a history read answers the entries after its `afterSeq` and the rest as is. */
  view: ConversationView;
  /** `afterSeq` of every history read, in request order. */
  afterSeqs: number[];
  /** History reads answered so far. */
  served: number;
  /** Holds the next history read until the test resolves it. */
  holdNextRead: () => Deferred<void>;
};

/** Given: GET /threads, /threads/a and /threads/a/history answer from one server-side state. */
function serveConversation(thread: ThreadSummary, view: ConversationView): ConversationServer {
  let hold: Deferred<void> | null = null;
  const state: ConversationServer = {
    view,
    afterSeqs: [],
    served: 0,
    holdNextRead: () => {
      const gate = deferred();
      hold = gate;
      return gate;
    },
  };
  server.use(
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([thread]))),
    http.get(`${API}/api/threads/${thread.id}`, () => HttpResponse.json(thread)),
    http.get(`${API}/api/threads/${thread.id}/history`, async ({ request }) => {
      const afterSeq = Number(new URL(request.url).searchParams.get('afterSeq'));
      state.afterSeqs.push(afterSeq);
      const gate = hold;
      hold = null;
      if (gate !== null) await gate.promise;
      const body: ConversationView = {
        ...state.view,
        entries: state.view.entries.filter((entry) => entry.seq > afterSeq),
      };
      state.served += 1;
      return HttpResponse.json(body);
    }),
  );
  return state;
}

/** Given: `/chat/a` is open, its first read is on screen and the stream watches it. */
async function openConversation(firstText: string): Promise<{ live: TestLiveSource; container: HTMLElement }> {
  const live = createTestLiveSource();
  const { container } = renderWithRuntime({ pathname: '/chat/a', liveSource: live });
  await screen.findByText(firstText);
  await waitFor(() => expect(live.current()?.url).toBe(WATCH_A));
  return { live, container };
}

const text = (element: Element | null): string => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** `element` without the descendants matching `selector`, as text. */
function textWithout(element: Element | null, selector: string): string {
  if (element === null) return '';
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) return '';
  for (const node of copy.querySelectorAll(selector)) node.remove();
  return text(copy);
}

const FEED_ITEM =
  '[data-slot="aui_user-message-root"], [data-slot="aui_assistant-message-root"], [data-slot="aui_feed-part"]';

/** One feed item as a line: who speaks and what, or which card with its accessible name and state. */
function describeFeedItem(item: HTMLElement): string {
  if (item.dataset.slot === 'aui_user-message-root') {
    return `Вы: ${text(item.querySelector('.aui-user-message-content'))}`;
  }
  if (item.dataset.slot === 'aui_assistant-message-root') {
    const answer = textWithout(
      item.querySelector('[data-slot="aui_assistant-message-content"]'),
      '[data-slot="aui_message-source"], [data-slot="tool-group-root"]',
    );
    const tools = item.querySelector('[data-slot="tool-group-trigger-label"]');
    return tools === null ? `Ответ: ${answer}` : `Ответ: ${answer} · ${text(tools)}`;
  }
  const run = item.querySelector('[data-slot="run-card"]');
  if (run !== null) {
    const steps = Array.from(run.querySelectorAll('li a'), (step) => step.getAttribute('aria-label'));
    return `Запуск: ${run.getAttribute('aria-label')}${steps.length === 0 ? '' : ` — ${steps.join('; ')}`}`;
  }
  const decision = item.querySelector('[data-slot="decision-card"]');
  if (decision !== null) {
    return `Решение: ${decision.getAttribute('aria-label')} (${decision.getAttribute('data-state')})`;
  }
  const report = item.querySelector('[data-slot="agent-report"]');
  if (report !== null) return `${report.getAttribute('aria-label')}`;
  const event = item.querySelector('[data-slot="agent-status-event"]');
  if (event !== null) return `Событие: ${textWithout(event, 'time, [aria-hidden]')}`;
  return `? ${text(item)}`;
}

/** The feed of the open screen, top to bottom. */
function feedItems(): string[] {
  const group = document.querySelector('[data-slot="aui_message-group"]');
  if (group === null) return [];
  return Array.from(group.querySelectorAll<HTMLElement>(FEED_ITEM), describeFeedItem);
}

const tray = (): HTMLElement | null => screen.queryByRole('region', { name: 'Ждут доставки' });

/**
 * Records every DOM state in which `message` is not shown exactly once across the tray and the feed
 * (invariant 3: an accepted message is never missing and never drawn twice).
 */
function trackOnePlace(container: HTMLElement, message: string): string[] {
  const breaches: string[] = [];
  const check = () => {
    const box = tray();
    const inTray = box === null ? 0 : Array.from(box.querySelectorAll('li')).filter((li) => text(li).includes(message)).length;
    const inFeed = feedItems().filter((item) => item === `Вы: ${message}`).length;
    if (inTray + inFeed !== 1) breaches.push(`tray ${inTray}, feed ${inFeed}`);
  };
  check();
  const observer = new MutationObserver(check);
  observer.observe(container, { subtree: true, childList: true, characterData: true });
  onTestFinished(() => observer.disconnect());
  return breaches;
}

/** Every phrase the shell's single polite live region speaks from now on, in order (MC-25). */
function trackAnnouncements(): string[] {
  const region = document.querySelector('div[role="status"][aria-live="polite"]');
  if (region === null) throw new Error('the shell announcer is not rendered');
  const spoken: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const said = text(node instanceof Element ? node : null);
        if (said !== '') spoken.push(said);
      }
    }
  });
  observer.observe(region, { childList: true });
  onTestFinished(() => observer.disconnect());
  return spoken;
}

const CONNECTION_LINE = 'Нет связи с сервером. Переподключаемся…';

// ---------------------------------------------------------------------------------------------------
// Local helpers of the agent screens: the emulated agent API and readable pictures of the tree and the header.

type AgentServer = {
  /** What GET /agents answers now. */
  list: AgentListPage;
  /** What GET /agents/:agentId/history holds now, by agent. */
  pages: Record<string, AgentPageView>;
  /** `afterSeq` of every history read, by agent, in request order. */
  afterSeqs: Record<string, number[]>;
};

/** Given: GET /threads, GET /agents and GET /agents/:agentId/history answer from one server-side state. */
function serveAgents(threads: ThreadSummary[], list: AgentListPage, pages: Record<string, AgentPageView>): AgentServer {
  const state: AgentServer = { list, pages, afterSeqs: {} };
  server.use(
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList(threads))),
    http.get(`${API}/api/agents`, () => HttpResponse.json(state.list)),
    http.get(`${API}/api/agents/:agentId/history`, ({ request, params }) => {
      const agentId = String(params['agentId']);
      const afterSeq = Number(new URL(request.url).searchParams.get('afterSeq'));
      state.afterSeqs[agentId] = [...(state.afterSeqs[agentId] ?? []), afterSeq];
      const page = state.pages[agentId];
      if (page === undefined) {
        return HttpResponse.json(
          { statusCode: 404, message: 'Agent not found', errorCode: 'AGENT_NOT_FOUND' },
          { status: 404 },
        );
      }
      return HttpResponse.json({ ...page, entries: page.entries.filter((entry) => entry.seq > afterSeq) });
    }),
  );
  return state;
}

/** The agent tree, top to bottom: each row as «task: status» (the status icon's accessible name). */
function treeRows(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-agent-row]'), (row) => {
    const status = row.querySelector('[data-slot="agent-status"][role="img"]')?.getAttribute('aria-label') ?? '?';
    return `${text(row.querySelector('[data-agent-link]'))}: ${status}`;
  });
}

/** The agent page's header (AV-01): the `h1` and its neighbours, the status label and the control button. */
function agentHeader(): HTMLElement {
  const header = screen.getByRole('heading', { level: 1 }).parentElement;
  if (header === null) throw new Error('the agent header is not rendered');
  return header;
}

describe('Agent platform web: the conversation feed, live and after a re-read (UC-1)', () => {
  // AC: AC-24.1 "Given в беседе идёт workflow deep-research, when сотрудник смотрит беседу, then видит агентов, которых вызвал
  //   координатор, и их статусы, и картина обновляется без перезагрузки."
  // AC: AC-22.2 "Given агент работает, when сотрудник смотрит его историю, then новые записи появляются без перезагрузки."
  // AC: DC-1 (design-web) "Лента после перечитывания с afterSeq совпадает с лентой, собранной вживую: записи не повторяются и не пропадают."
  // Behavior: open /chat/a (view: chat answer, an MCP tool call with its result, a confirmed brief, a workflow run with two steps)
  //   → the event source delivers `ready`, then `delta` parts, then a `tree` note whose re-read (afterSeq = last seq) adds a third step
  //   and a report → the draft text is shown until its history entry arrives and is replaced by it; the run card sits under the
  //   brief card with three steps and their statuses; the report is last; no entry appears twice
  // Catches: toFeed places a decision or a run card by the wrong rule (KD-3), or a re-read with afterSeq duplicates or drops entries
  //   (invariant 2), or the draft is left next to the entry that replaced it
  // Verification items:
  // - draft visible before its history entry exists, gone (not duplicated) after the re-read that brings the entry
  // - run card is placed directly under the brief card (CV-01), with 3 steps in order and their statuses
  // - `GET history` after the `tree` note carries afterSeq equal to the last seq of the first load
  // - the successful start_agent / start_workflow tool call is not drawn (the run card replaces it, MC-23)
  // @category: core-functionality
  // @dependency: LiveStore (injected event source), FeedStore, toFeed, useFeedRuntime, threadsApiClient, Thread, AssistantMessage, RunCard, MSW
  // @complexity: high
  it('AC-24.1 / AC-22.2 / DC-1: live draft is replaced by its history entry, the run card sits under its brief with three steps, and the re-read repeats no entry', async () => {
    // Arrange: a chat answer with an MCP call and its result, a confirmed brief, a workflow run with two steps
    const briefArgs = {
      template: 'research',
      question: 'Почему падает выгрузка?',
      boundaries: 'Только логи за неделю',
      result: 'Короткий отчёт',
    };
    const brief = confirmation({
      decisionId: 'd-brief',
      agentId: 'root',
      description: 'Чат',
      kind: WORKFLOWS_BRIEF_CONFIRMATION,
      tool: 'start_workflow',
      server: null,
      args: briefArgs,
      content: { title: 'Исследование', question: briefArgs.question, boundaries: briefArgs.boundaries, result: briefArgs.result },
      templateTitle: 'Исследование',
      status: 'resolved',
      resolution: { approve: true, args: briefArgs },
      createdAt: fixtureTime(4),
      resolvedAt: fixtureTime(4.5),
    });
    const step = (agentId: string, description: string, status: 'working' | 'completed', at: number) =>
      agentNode({ agentId, parentId: 'w1', depth: 2, description, status, createdAt: fixtureTime(at) });
    const run = (status: 'working' | 'completed', steps: ReturnType<typeof step>[]) =>
      agentNode({
        agentId: 'w1',
        definition: 'research',
        description: 'Исследование',
        template: { name: 'research', title: 'Исследование' },
        status,
        createdAt: fixtureTime(5),
        children: steps,
      });
    const firstEntries = [
      historyEntry({ kind: 'task', seq: 1, content: { text: 'Разберись, почему падает ночная выгрузка' } }),
      historyEntry({
        kind: 'model_answer',
        seq: 2,
        content: {
          text: 'Смотрю логи.',
          toolCalls: [{ callId: 'c1', tool: 'search', server: 'logs', args: { query: 'ошибки' }, state: 'done' }],
        },
      }),
      historyEntry({ kind: 'tool_result', seq: 3, content: { callId: 'c1', tool: 'search', server: 'logs', text: 'Три ошибки' } }),
      historyEntry({
        kind: 'model_answer',
        seq: 4,
        content: {
          text: 'Готовлю бриф.',
          toolCalls: [{ callId: 'c2', tool: 'start_workflow', server: null, args: briefArgs, state: 'done' }],
        },
      }),
      historyEntry({
        kind: 'tool_result',
        seq: 5,
        content: { callId: 'c2', tool: 'start_workflow', server: null, args: briefArgs, text: 'Запущено' },
      }),
    ];
    const conversation = serveConversation(
      THREAD,
      conversationView({
        thread: THREAD,
        chat: { status: 'working', failureReason: null, rootAgentId: 'root', model: 'claude-haiku-4-5' },
        entries: firstEntries,
        decisions: [brief],
        agents: [
          run('working', [step('s1', 'Поиск в логах', 'completed', 5.1), step('s2', 'Разбор ошибок', 'working', 5.2)]),
        ],
      }),
    );
    const { live } = await openConversation('Смотрю логи.');

    // Act: `ready` re-reads from the last seq; the root's answer streams in as `delta` parts
    live.emit('ready', {});
    await waitFor(() => expect(conversation.served).toBe(2));
    const draftHead = 'Запустил исследование, ';
    live.emit('delta', { agentId: 'root', offset: 0, text: draftHead });
    live.emit('delta', { agentId: 'root', offset: draftHead.length, text: 'жду отчёт.' });

    // Assert (live): the draft is last; the run card stands right under its brief; the start call is not drawn (MC-23)
    const head = [
      'Вы: Разберись, почему падает ночная выгрузка',
      'Ответ: Смотрю логи. · 1 вызов инструмента',
      'Ответ: Готовлю бриф.',
      'Решение: Бриф: Почему падает выгрузка? (approved)',
    ];
    await waitFor(() =>
      expect(feedItems()).toEqual([
        ...head,
        'Запуск: Исследование: Работает — Поиск в логах, Завершён; Разбор ошибок, Работает',
        'Ответ: Запустил исследование, жду отчёт.',
      ]),
    );

    // Act: the server stores the answer, a third step and the report; a `tree` note re-reads
    conversation.view = {
      ...conversation.view,
      chat: { ...conversation.view.chat, status: 'idle' },
      entries: [
        ...firstEntries,
        historyEntry({ kind: 'model_answer', seq: 6, content: { text: 'Запустил исследование, жду отчёт.', toolCalls: [] } }),
        historyEntry({
          kind: 'child_report',
          seq: 7,
          content: {
            agentId: 'w1',
            description: 'Исследование',
            status: 'completed',
            text: 'Причина — таймаут базы.',
            toolCalls: 3,
            durationMs: 42000,
          },
        }),
      ],
      agents: [
        run('completed', [
          step('s1', 'Поиск в логах', 'completed', 5.1),
          step('s2', 'Разбор ошибок', 'completed', 5.2),
          step('s3', 'Сводка', 'completed', 5.3),
        ]),
      ],
    };
    live.emit('tree', { threadId: 'a' });

    // Assert (after the re-read): the draft gave way to its entry, three steps with new statuses, the report last, no repeats
    await waitFor(() =>
      expect(feedItems()).toEqual([
        ...head,
        'Запуск: Исследование: Завершён — Поиск в логах, Завершён; Разбор ошибок, Завершён; Сводка, Завершён',
        'Ответ: Запустил исследование, жду отчёт.',
        'Отчёт: Исследование',
      ]),
    );
    expect(conversation.afterSeqs).toEqual([0, 5, 5]);
  });
});

describe('Agent platform web: the queue tray and "Прервать и отправить" (UC-2)', () => {
  // AC: AC-23.1 "Given агент открыт, when сотрудник отправляет сообщение, then оно видно как ожидающее до доставки и доставляется по FR-07."
  // AC: AC-16.1 "Given чат отвечает, when сотрудник отправляет новое сообщение, then оно принято, видно в беседе как ожидающее и учитывается чатом на ближайшей границе (FR-07)."
  // AC: AC-16.2 "Given чат отвечает, when сотрудник прерывает ответ, then чат прекращает текущую операцию по FR-08."
  // AC: DC-2 (design-web) "Сообщение, которое сервер принял, видно сразу — в конце ленты или в лотке; непринятое возвращается в поле со строкой MC-27."
  // Behavior: /chat/a with chat status `working`
  //   → send message 1: POST messages answers 202 → the composer clears, the message stands in the tray; the re-read now has it in history
  //     → the tray is empty, the message is in the feed at its delivery place
  //   → type text 2 and press "Прервать и отправить": POST interrupt → the text is at once at the end of the feed, focus in the field;
  //     the re-read still has it in `pending` → it stays at the end of the feed and the tray does not show it
  //   → send message 3: POST messages answers 500 → the text is back in the field with the MC-27 line, nothing in the tray
  // Catches: an accepted message not visible between the 202 and the re-read (silent pause), a tray entry that outlives its delivery
  //   or duplicates a `pending` record that the feed already draws (invariant 3), a rejected message that is kept in the tray or
  //   loses the user's text
  // Verification items:
  // - "Отправить" stays enabled while the chat is `working` (no isRunning passed to assistant-ui, KD-1)
  // - tray entry removed only when the same messageId shows up in the feed (invariant 3)
  // - after the 500 the field holds the original text and the line «Не удалось отправить сообщение. Попробуйте ещё раз.» is shown
  // @category: core-functionality
  // @dependency: FeedStore (optimistic entries), toFeed, QueueTray, InterruptButton, Composer, threadsApiClient, MSW
  // @complexity: high
  it('AC-23.1 / AC-16.1 / AC-16.2 / DC-2: an accepted message stands in the tray then in the feed; "Прервать и отправить" goes straight to the feed; a 500 returns the text with MC-27', async () => {
    // Arrange: the chat is `working`; the first message is accepted, the next one fails with 500
    const firstEntries = [
      historyEntry({ kind: 'task', seq: 1, content: { text: 'Собери отчёт по продажам' } }),
      historyEntry({ kind: 'model_answer', seq: 2, content: { text: 'Начинаю.', toolCalls: [] } }),
    ];
    const conversation = serveConversation(
      THREAD,
      conversationView({
        thread: THREAD,
        chat: { status: 'working', failureReason: null, rootAgentId: 'root', model: 'claude-haiku-4-5' },
        entries: firstEntries,
      }),
    );
    const queued = 'Добавь итоги за квартал';
    const urgent = 'Хватит, сделай короче';
    const refused = 'Ещё вопрос';
    const sendBodies: SendMessageRequest[] = [];
    const interruptBodies: InterruptRequest[] = [];
    server.use(
      http.post(`${API}/api/threads/a/messages`, async ({ request }) => {
        const body = SendMessageRequestSchema.parse(await request.json());
        sendBodies.push(body);
        if (body.text !== queued) {
          return HttpResponse.json({ statusCode: 500, message: 'Internal server error' }, { status: 500 });
        }
        conversation.view = {
          ...conversation.view,
          pending: [pendingMessage({ messageId: 'm1', text: queued, createdAt: fixtureTime(3) })],
        };
        return HttpResponse.json({ messageId: 'm1' } satisfies SendMessageResponse, { status: 202 });
      }),
      http.post(`${API}/api/threads/a/interrupt`, async ({ request }) => {
        interruptBodies.push(InterruptRequestSchema.parse(await request.json()));
        conversation.view = {
          ...conversation.view,
          entries: [
            ...conversation.view.entries,
            historyEntry({ kind: 'event', seq: 4, content: { event: 'interrupted', reason: null } }),
          ],
          pending: [pendingMessage({ messageId: 'm2', text: urgent, interrupt: true, createdAt: fixtureTime(5) })],
        };
        return HttpResponse.json({ outcome: 'interrupted' } satisfies InterruptResponse);
      }),
    );
    const user = userEvent.setup();
    const { live, container } = await openConversation('Начинаю.');
    const composer = screen.getByRole('textbox', { name: 'Сообщение' });

    // Act 1: send to the busy chat; the re-read after the 202 is held
    const afterAccept = conversation.holdNextRead();
    await user.type(composer, queued);
    const send = screen.getByRole('button', { name: 'Отправить' });
    expect(send).toBeEnabled(); // KD-1: no isRunning — sending stays open while the chat works
    await user.click(send);

    // Assert 1a: accepted → the field is empty and the message stands in the tray before any re-read
    const queueTray = await screen.findByRole('region', { name: 'Ждут доставки' });
    expect(within(queueTray).getByText('Ждут доставки · 1')).toBeInTheDocument();
    expect(within(queueTray).getByText(queued)).toBeInTheDocument();
    expect(composer).toHaveValue('');
    expect(sendBodies).toEqual([{ text: queued }]);
    const breaches = trackOnePlace(container, queued);

    // Act 1b: the re-read brings it as `pending`; then it is delivered and a `tree` note re-reads
    afterAccept.resolve();
    await waitFor(() => expect(conversation.served).toBe(2));
    conversation.view = {
      ...conversation.view,
      entries: [...firstEntries, historyEntry({ kind: 'user_message', seq: 3, content: { text: queued } })],
      pending: [],
    };
    live.emit('tree', { threadId: 'a' });

    // Assert 1b: the tray is empty and the message is in the feed at its place; never missing, never twice
    await waitFor(() => expect(tray()).toBeNull());
    expect(feedItems()).toEqual(['Вы: Собери отчёт по продажам', 'Ответ: Начинаю.', `Вы: ${queued}`]);
    expect(breaches).toEqual([]);

    // Act 2: «Прервать и отправить»; the re-read after the interrupt is held
    const afterInterrupt = conversation.holdNextRead();
    await user.type(composer, urgent);
    await user.click(screen.getByRole('button', { name: 'Прервать и отправить' }));

    // Assert 2a: at once at the end of the feed, not in the tray; the field is empty and focused
    await waitFor(() => expect(feedItems().at(-1)).toBe(`Вы: ${urgent}`));
    expect(tray()).toBeNull();
    expect(composer).toHaveValue('');
    expect(composer).toHaveFocus();
    expect(interruptBodies).toEqual([{ text: urgent }]);

    // Act 2b: the re-read still holds it in `pending` (interrupt) and adds the interrupt event
    afterInterrupt.resolve();

    // Assert 2b: it stays at the end of the feed and the tray does not show it
    await waitFor(() =>
      expect(feedItems()).toEqual([
        'Вы: Собери отчёт по продажам',
        'Ответ: Начинаю.',
        `Вы: ${queued}`,
        'Событие: Прервано вами',
        `Вы: ${urgent}`,
      ]),
    );
    expect(tray()).toBeNull();

    // Act 3: the server refuses the next message
    await user.type(composer, refused);
    await user.click(screen.getByRole('button', { name: 'Отправить' }));

    // Assert 3: the text is back in the field with MC-27; nothing in the tray or the feed
    expect(await screen.findByText('Не удалось отправить сообщение. Попробуйте ещё раз.')).toBeInTheDocument();
    expect(composer).toHaveValue(refused);
    expect(tray()).toBeNull();
    expect(feedItems()).not.toContain(`Вы: ${refused}`);
    expect(sendBodies).toEqual([{ text: queued }, { text: refused }]);
    expect(conversation.afterSeqs).toEqual([0, 2, 2, 3]);
  });
});

describe('Agent platform web: the decision card (UC-3)', () => {
  // AC: AC-24.2 "Given в беседе ждёт запрос на действие или бриф, when сотрудник решает его в беседе, then исход совпадает с AC-12.3, AC-12.4 или AC-28.2, AC-28.3."
  // AC: AC-28.2 "Given бриф ждёт, when сотрудник подтверждает его, в том числе исправив текст, then запускается один workflow, и его агенты получают подтверждённый бриф, но не историю беседы."
  // AC: AC-28.3 "Given бриф ждёт, when сотрудник отказывается, then workflow не запускается, а чат получает результат «отклонено пользователем» (как AC-12.4)."
  // Behavior: /chat/a with an open brief and an open mutating-action request of a background agent
  //   → edit the brief question and press "Запустить с правками": POST decisions carries approve, the `template` from the Confirmation
  //     unchanged and the three brief fields with the edited question → the card shows «Бриф подтверждён», focus is on the card
  //   → press "Отклонить" on the action request, the first POST fails with a network error → the card returns to "Ждёт" with the MC-19
  //     error line (role="alert") → repeat the same button: the card shows «Отклонено»
  // Catches: the brief decision sent without `template` or with the original instead of the edited text (the workflow would start from
  //   the wrong brief), a failed decision that leaves the card stuck in "Отправка" or loses the retry button
  // Verification items:
  // - request body of the brief decision: approve true, template as in the Confirmation, question = edited value
  // - the focus moves to the card container after the outcome
  // - the error line of the failed decision is announced inside the card; the retry button is the same control
  // @category: core-functionality
  // @dependency: FeedStore.decide, toFeed (decisions placement), DecisionCard, threadsApiClient, MSW
  // @complexity: medium
  it('AC-24.2 / AC-28.2 / AC-28.3: an edited brief is sent with its template and the card confirms; a failed decline shows MC-19 and the retry gives "Отклонено"', async () => {
    // Arrange: the clock is on the fixture day, so outcome times read «ЧЧ:ММ» (FIXTURE_TIME 10:00Z = 11:00 Berlin)
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00+01:00'));
    const briefArgs = {
      template: 'research',
      question: 'Почему падает выгрузка?',
      boundaries: 'Только логи за неделю',
      result: 'Короткий отчёт',
    };
    const brief = confirmation({
      decisionId: 'd-brief',
      agentId: 'root',
      description: 'Чат',
      kind: WORKFLOWS_BRIEF_CONFIRMATION,
      tool: 'start_workflow',
      server: null,
      args: briefArgs,
      content: { title: 'Исследование', question: briefArgs.question, boundaries: briefArgs.boundaries, result: briefArgs.result },
      templateTitle: 'Исследование',
      createdAt: fixtureTime(3),
    });
    const ticket = confirmation({
      decisionId: 'd-ticket',
      agentId: 'a1',
      description: 'Разбор заявок',
      tool: 'create_ticket',
      server: 'backoffice',
      args: { title: 'Сбой выгрузки', urgent: true },
      content: { title: 'Сбой выгрузки' },
      toolTitle: 'Создать заявку',
      argLabels: { title: 'Заголовок' },
      createdAt: fixtureTime(4),
    });
    const conversation = serveConversation(
      THREAD,
      conversationView({
        thread: THREAD,
        chat: { status: 'awaiting_confirmation', failureReason: null, rootAgentId: 'root', model: 'claude-haiku-4-5' },
        entries: [
          historyEntry({ kind: 'task', seq: 1, content: { text: 'Разберись, почему падает ночная выгрузка' } }),
          historyEntry({
            kind: 'model_answer',
            seq: 2,
            content: {
              text: 'Предлагаю бриф.',
              toolCalls: [
                { callId: 'c1', tool: 'start_workflow', server: null, args: briefArgs, state: 'awaiting_confirmation' },
              ],
            },
          }),
        ],
        decisions: [brief, ticket],
      }),
    );
    const resolvedAt: Record<string, string> = { 'd-brief': fixtureTime(60), 'd-ticket': fixtureTime(120) };
    const decisionBodies: { decisionId: string; body: DecisionRequest }[] = [];
    let ticketFailures = 1;
    server.use(
      http.post(`${API}/api/decisions/:decisionId`, async ({ request, params }) => {
        const decisionId = String(params['decisionId']);
        const body = DecisionRequestSchema.parse(await request.json());
        decisionBodies.push({ decisionId, body });
        if (decisionId === 'd-ticket' && ticketFailures > 0) {
          ticketFailures -= 1;
          return HttpResponse.error();
        }
        conversation.view = {
          ...conversation.view,
          decisions: conversation.view.decisions.map(
            (decision): Confirmation =>
              decision.decisionId !== decisionId
                ? decision
                : {
                    ...decision,
                    status: 'resolved',
                    resolution: { approve: body.approve, args: body.args ?? decision.args },
                    resolvedAt: resolvedAt[decisionId] ?? null,
                  },
          ),
        };
        return HttpResponse.json({ outcome: 'resolved' } satisfies DecisionResponse);
      }),
    );
    const user = userEvent.setup();
    const { container } = await openConversation('Предлагаю бриф.');
    const cardOf = (decisionId: string): HTMLElement => {
      const card = container.querySelector<HTMLElement>(`[data-decision-id="${decisionId}"]`);
      if (card === null) throw new Error(`decision card ${decisionId} is not rendered`);
      return card;
    };

    // Act 1: edit the brief question and launch with the edits
    const briefCard = await screen.findByRole('group', { name: 'Бриф: Почему падает выгрузка?' });
    await user.click(within(briefCard).getByRole('button', { name: 'Исправить' }));
    const question = within(briefCard).getByRole('textbox', { name: 'Вопрос' });
    await user.clear(question);
    await user.type(question, 'Почему падает ночная выгрузка?');
    await user.click(within(briefCard).getByRole('button', { name: 'Запустить с правками' }));

    // Assert 1: approve with the template unchanged and the edited question; the card confirms and takes focus
    await waitFor(() => expect(within(cardOf('d-brief')).getByText('Бриф подтверждён · 11:01')).toBeInTheDocument());
    expect(decisionBodies).toEqual([
      {
        decisionId: 'd-brief',
        body: {
          approve: true,
          args: {
            template: 'research',
            question: 'Почему падает ночная выгрузка?',
            boundaries: 'Только логи за неделю',
            result: 'Короткий отчёт',
          },
        },
      },
    ]);
    expect(within(cardOf('d-brief')).getByText('Почему падает ночная выгрузка?')).toBeInTheDocument();
    await waitFor(() => expect(cardOf('d-brief')).toHaveFocus());

    // Act 2: decline the background agent's request; the first POST is lost
    const ticketCard = screen.getByRole('group', { name: 'Нужно решение: Создать заявку' });
    expect(ticketCard).toHaveTextContent('Агент «Разбор заявок» хочет выполнить:');
    // The action reads as the tool's title over «name · server», its arguments as rows «label — value»
    // (the schema title, or the key as is); the exact JSON opens only by its disclosure, focus stays on it
    expect(ticketCard).toHaveTextContent('create_ticket · backoffice');
    const ticketArgs = within(ticketCard).getByRole('region', { name: 'Аргументы' });
    expect(
      [...ticketArgs.querySelectorAll('dt')].map((term) => `${term.textContent} — ${term.nextElementSibling?.textContent}`),
    ).toEqual(['Заголовок — Сбой выгрузки', 'urgent — да']);
    expect(ticketArgs).not.toHaveTextContent('{');
    const showJson = within(ticketArgs).getByRole('button', { name: 'Показать как JSON' });
    expect(showJson).toHaveAttribute('aria-expanded', 'false');
    await user.click(showJson);
    expect(within(ticketArgs).getByRole('button', { name: 'Скрыть JSON' })).toBe(showJson);
    expect(showJson).toHaveAttribute('aria-expanded', 'true');
    expect(showJson).toHaveFocus();
    expect(within(ticketArgs).getByRole('region', { name: 'JSON' })).toHaveTextContent('"urgent": true');
    const reject = within(ticketCard).getByRole('button', { name: 'Отклонить' });
    await user.click(reject);

    // Assert 2: back to «Ждёт» with the MC-19 error line inside the card; the same button retries
    expect(await within(ticketCard).findByRole('alert')).toHaveTextContent(
      'Не удалось отправить решение. Попробуйте ещё раз.',
    );
    expect(ticketCard).toHaveAttribute('data-state', 'open');
    expect(within(ticketCard).getByText('Ждёт подтверждения')).toBeInTheDocument();
    expect(within(ticketCard).getByRole('button', { name: 'Отклонить' })).toBe(reject);
    expect(reject).toBeEnabled();
    expect(reject).not.toHaveAttribute('aria-busy');

    // Act 3: the same button again
    await user.click(reject);

    // Assert 3: «Отклонено», the error line is gone, focus on the card
    await waitFor(() => expect(within(cardOf('d-ticket')).getByText('Отклонено · 11:02')).toBeInTheDocument());
    expect(within(cardOf('d-ticket')).queryByRole('alert')).toBeNull();
    await waitFor(() => expect(cardOf('d-ticket')).toHaveFocus());
    expect(decisionBodies.slice(1)).toEqual([
      { decisionId: 'd-ticket', body: { approve: false } },
      { decisionId: 'd-ticket', body: { approve: false } },
    ]);
  });
});

describe('Agent platform web: tree, agent page and controls (UC-4)', () => {
  // AC: AC-21.1 "Given сотрудник запустил агента из беседы, when открыт список агентов, then агент появляется в списке без перезагрузки, а смена его статуса видна сразу."
  // AC: AC-22.1 "Given агент работал, when сотрудник открывает его, then видит задание, ответы модели, вызовы инструментов с аргументами и результатами, доставленные и ожидающие сообщения, запросы на действия и отчёты дочерних агентов."
  // AC: AC-23.2 "Given агент открыт, when сотрудник прерывает, останавливает, продолжает или запускает его с нуля, then исход совпадает с FR-08 и FR-09, а новый статус виден в истории и в списке."
  // Behavior: /agents lists a root agent with a child in status "Работает" (GET /agents)
  //   → a `tree` note arrives, the re-read adds a new root → the new row is in the tree without a page reload
  //   → open the agent (watch moves to `agent:<id>`, the first `ready` re-reads): history and status are shown
  //   → press "Остановить": POST stop → the event line «Остановлен вами» and a "Запустить с нуля" button in the same place, focus kept there
  //   → press "Запустить с нуля": POST restart answers 201 with a new agentId → the page of the new agent is open
  // Catches: the tree not refreshing on a `tree` note, the agent page not following the screen change (stale watch / old history),
  //   the control button not reflecting the status after stop, restart opening the old agent instead of the new one
  // Verification items:
  // - exactly one event source is open at any moment, also across the /agents → /agents/<id> switch (invariant 1)
  // - the stop button and "Запустить с нуля" are one element whose label changes, so focus stays on it
  // - after restart the route is /agents/<new agentId>, and the page title/h1 belong to the new agent
  // @category: core-functionality
  // @dependency: LiveStore (watch switch), FeedStore (agent source), AgentTree, AgentScreen, AgentHeader, AgentStatus, threadsApiClient, MSW
  // @complexity: high
  it('AC-21.1 / AC-22.1 / AC-23.2: a new root appears in the tree on a `tree` note; the agent page shows history and status; stop swaps to "Запустить с нуля"; restart opens the new agent', async () => {
    // Arrange: a working root of conversation `a` with a working child; the child's page holds its task and one tool call
    const root = {
      agentId: 'r1',
      description: 'Разбор логов',
      threadId: 'a',
      threadTitle: 'Выгрузка',
      createdAt: fixtureTime(1),
      children: [
        agentNode({ agentId: 'c1', parentId: 'r1', depth: 2, description: 'Поиск ошибок', createdAt: fixtureTime(2) }),
      ],
    };
    const childAgent = (agentId: string, status: 'working' | 'stopped') => ({
      agentId,
      parentId: 'r1',
      depth: 2,
      description: 'Поиск ошибок',
      status,
      threadId: 'a',
      threadTitle: 'Выгрузка',
      parentDescription: 'Разбор логов',
    });
    const childEntries = [
      historyEntry({ kind: 'task', seq: 1, content: { text: 'Найди ошибки в логах' } }),
      historyEntry({
        kind: 'model_answer',
        seq: 2,
        content: {
          text: 'Смотрю логи.',
          toolCalls: [{ callId: 'c1', tool: 'search', server: 'logs', args: { query: 'ошибки' }, state: 'done' }],
        },
      }),
      historyEntry({ kind: 'tool_result', seq: 3, content: { callId: 'c1', tool: 'search', server: 'logs', text: 'Три ошибки' } }),
    ];
    const agents = serveAgents([THREAD], agentListPage([root]), {
      c1: agentPageView({ agent: childAgent('c1', 'working'), entries: childEntries }),
    });
    const stopped: string[] = [];
    const restarted: string[] = [];
    server.use(
      http.post(`${API}/api/agents/:agentId/stop`, ({ params }) => {
        const agentId = String(params['agentId']);
        stopped.push(agentId);
        agents.pages[agentId] = agentPageView({
          agent: childAgent(agentId, 'stopped'),
          entries: [...childEntries, historyEntry({ kind: 'event', seq: 4, content: { event: 'stopped', reason: null } })],
        });
        return HttpResponse.json({ stopped: [agentId] } satisfies StopResponse);
      }),
      http.post(`${API}/api/agents/:agentId/restart`, ({ params }) => {
        restarted.push(String(params['agentId']));
        agents.pages['c2'] = agentPageView({ agent: childAgent('c2', 'working'), entries: childEntries.slice(0, 1) });
        return HttpResponse.json({ agentId: 'c2' } satisfies RestartResponse, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const live = createTestLiveSource();
    const { router, setPathname } = renderWithRuntime({ pathname: '/agents', liveSource: live });

    // Assert (tree): the stream has no target; the root is expanded with its working child
    await waitFor(() => expect(treeRows()).toEqual(['Разбор логов: Работает', 'Поиск ошибок: Работает']));
    expect(live.opened).toEqual([{ url: `${API}/api/events`, closed: false }]);

    // Act: a new root is stored and a `tree` note arrives
    agents.list = agentListPage([
      {
        agentId: 'r2',
        description: 'Сводка по продажам',
        threadId: 'a',
        threadTitle: 'Выгрузка',
        status: 'completed',
        createdAt: fixtureTime(10),
        finishedAt: fixtureTime(20),
      },
      root,
    ]);
    live.emit('tree', { threadId: 'a' });

    // Assert: the new root is first in the tree without a reload (AC-21.1)
    await waitFor(() =>
      expect(treeRows()).toEqual(['Сводка по продажам: Завершён', 'Разбор логов: Работает', 'Поиск ошибок: Работает']),
    );

    // Act: open the child agent; the stream moves to it and its first `ready` re-reads
    setPathname('/agents/c1');
    const title = await screen.findByRole('heading', { level: 1, name: 'Поиск ошибок' });
    await waitFor(() => expect(live.current()?.url).toBe(`${API}/api/events?watch=agent%3Ac1`));
    await waitFor(() =>
      expect(feedItems()).toEqual(['Вы: Найди ошибки в логах', 'Ответ: Смотрю логи. · 1 вызов инструмента']),
    );
    live.emit('ready', {});
    await waitFor(() => expect(agents.afterSeqs['c1']).toEqual([0, 3]));

    // Assert (agent page): the task under its caption, the answer with its tool call, the status in the header (AC-22.1)
    expect(screen.getByText('Задание')).toBeInTheDocument();
    expect(title).toHaveTextContent('Поиск ошибок');
    expect(within(agentHeader()).getByText('Работает')).toBeInTheDocument();

    // Act: «Остановить»
    const control = within(agentHeader()).getByRole('button', { name: 'Остановить' });
    await user.click(control);

    // Assert: «Остановлен вами» ends the history; the same button now reads «Запустить с нуля» and keeps focus (AC-23.2)
    await waitFor(() => expect(feedItems().at(-1)).toBe('Событие: Остановлен вами'));
    expect(within(agentHeader()).getByText('Остановлен')).toBeInTheDocument();
    expect(within(agentHeader()).getByRole('button', { name: 'Запустить с нуля' })).toBe(control);
    expect(control).toHaveFocus();
    expect(stopped).toEqual(['c1']);

    // Act: «Запустить с нуля»; the server answers 201 with the new agent
    await user.click(control);

    // Assert: the router opens the new agent, not the old one
    await waitFor(() => expect(router.push.mock.calls).toEqual([['/agents/c2']]));
    expect(restarted).toEqual(['c1']);

    // Act: Next performs the navigation
    setPathname('/agents/c2');

    // Assert: the new agent's page — its own history and status, its `h1` focused, the stream watching it
    await waitFor(() => expect(feedItems()).toEqual(['Вы: Найди ошибки в логах']));
    const newTitle = screen.getByRole('heading', { level: 1, name: 'Поиск ошибок' });
    await waitFor(() => expect(newTitle).toHaveFocus());
    expect(within(agentHeader()).getByText('Работает')).toBeInTheDocument();
    expect(within(agentHeader()).getByRole('button', { name: 'Остановить' })).toBeInTheDocument();
    await waitFor(() => expect(live.current()?.url).toBe(`${API}/api/events?watch=agent%3Ac2`));
    expect(agents.afterSeqs).toEqual({ c1: [0, 3, 3, 4], c2: [0] });

    // Assert (invariant 1): the stream followed every screen, one source at a time
    expect(live.opened).toEqual([
      { url: `${API}/api/events`, closed: true },
      { url: `${API}/api/events?watch=agent%3Ac1`, closed: true },
      { url: `${API}/api/events?watch=agent%3Ac2`, closed: false },
    ]);
    expect(live.mostOpenAtOnce()).toBe(1);
  });
});

describe('Agent platform web: the stream drops and comes back (UC-E1)', () => {
  // AC: AC-01.1 (platform, via the web shell) and AC-12.5 — a restart of the server loses no state the employee sees
  // AC: DC-3 (design-web) "Пока поток событий оборван, под шапкой стоит строка связи; после ready она уходит, а экран дочитывается без повторов и без прокрутки."
  // AC: NFR-08 (connection line and announcements part only; widths and keyboard order stay L1)
  // Behavior: /chat/a with a tray entry and an open decision card → the event source reports an error → the connection line appears and
  //   the loss is announced → the source reopens and delivers `ready` → the view is re-read with the last afterSeq; the response has
  //   one new entry, the full `pending` and `decisions` → the connection line goes and the recovery is announced; the feed has the new
  //   entry once; the tray entry and the decision card are still there
  // Catches: after a reconnect the feed repeats or loses entries (re-read without afterSeq or with a stale one), the tray or the card is
  //   dropped because the state is not taken from the full `pending` / `decisions`, the connection line is stuck after `ready`
  // Verification items:
  // - the re-read request after `ready` carries afterSeq equal to the last known seq
  // - the loss and recovery are announced once each (MC-25), through the single polite live region
  // - the draft of the observed agent is reset by the re-read that added entries
  // @category: core-functionality
  // @dependency: LiveStore (injected source error → ready), FeedStore.refresh, ConnectionBar, Announcer, QueueTray, DecisionCard, MSW
  // @complexity: medium
  it('DC-3 / AC-12.5: the connection line shows and goes, the re-read after `ready` adds one entry with no repeats, and the tray and the decision card stay', async () => {
    // Arrange: the chat works with a message in the queue and a background agent's open request
    const queued = 'Добавь итоги за квартал';
    const ticket = confirmation({
      decisionId: 'd-ticket',
      agentId: 'a1',
      description: 'Разбор заявок',
      tool: 'create_ticket',
      server: 'backoffice',
      args: { title: 'Сбой выгрузки' },
      content: { title: 'Сбой выгрузки' },
      createdAt: fixtureTime(2.5),
    });
    const firstEntries = [
      historyEntry({ kind: 'task', seq: 1, content: { text: 'Собери отчёт по продажам' } }),
      historyEntry({ kind: 'model_answer', seq: 2, content: { text: 'Начинаю.', toolCalls: [] } }),
    ];
    const conversation = serveConversation(
      THREAD,
      conversationView({
        thread: THREAD,
        chat: { status: 'working', failureReason: null, rootAgentId: 'root', model: 'claude-haiku-4-5' },
        entries: firstEntries,
        pending: [pendingMessage({ messageId: 'm1', text: queued, createdAt: fixtureTime(3) })],
        decisions: [ticket],
      }),
    );
    const { live } = await openConversation('Начинаю.');
    live.emit('ready', {});
    await waitFor(() => expect(conversation.served).toBe(2));
    const head = ['Вы: Собери отчёт по продажам', 'Ответ: Начинаю.', 'Решение: Нужно решение: create_ticket (open)'];
    const spoken = trackAnnouncements();

    // Act: the root's answer starts streaming, then the stream errors and closes itself
    live.emit('delta', { agentId: 'root', offset: 0, text: 'Готовлю итог' });
    await waitFor(() => expect(feedItems()).toEqual([...head, 'Ответ: Готовлю итог']));
    live.fail({ closed: true });

    // Assert (lost): the connection line stands and the loss is announced once
    expect(await screen.findByText(CONNECTION_LINE)).toBeInTheDocument();
    await waitFor(() => expect(spoken).toEqual(['Связь с сервером потеряна']));

    // Act: meanwhile the server stores the answer; the store reopens the stream after 2 s
    conversation.view = {
      ...conversation.view,
      entries: [...firstEntries, historyEntry({ kind: 'model_answer', seq: 3, content: { text: 'Готовлю итог.', toolCalls: [] } })],
    };
    await waitFor(
      () =>
        expect(live.opened.slice(-2)).toEqual([
          { url: WATCH_A, closed: true },
          { url: WATCH_A, closed: false },
        ]),
      { timeout: 3000 },
    );
    expect(screen.getByText(CONNECTION_LINE)).toBeInTheDocument();
    live.emit('ready', {});

    // Assert (back): the line goes, the recovery is announced once, the feed adds the answer once in place of the draft
    await waitFor(() => expect(screen.queryByText(CONNECTION_LINE)).toBeNull());
    await waitFor(() => expect(feedItems()).toEqual([...head, 'Ответ: Готовлю итог.']));
    expect(spoken).toEqual(['Связь с сервером потеряна', 'Связь с сервером восстановлена']);
    expect(conversation.afterSeqs).toEqual([0, 2, 2]);

    // Assert: the tray and the decision card are still there, taken from the full `pending` and `decisions`
    const queueTray = tray();
    expect(queueTray).not.toBeNull();
    expect(within(queueTray ?? document.body).getByText('Ждут доставки · 1')).toBeInTheDocument();
    expect(within(queueTray ?? document.body).getByText(queued)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Нужно решение: create_ticket' })).toHaveAttribute('data-state', 'open');
    expect(live.mostOpenAtOnce()).toBe(1);
  });
});
