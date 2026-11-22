// deep-agents / web - integration tests (Vitest + RTL + MSW 2, jsdom)
// Design Doc: docs/features/deep-agents/design-agent-types.md (v1.3), Test Strategy UC-10 (the diagram panel, the task list and the record
//   card in the library), §KD-6 and §C3 web (the panel, the tab «Задачи», the «Запись» card); UXRD: docs/features/deep-agents/uxrd.md
//   DA-04, DA-05, DA-11, DA-12, DA-13, MC-9–MC-14, MC-24, MC-25.
// Budget Used: WEB-1 and WEB-2 of the part (work plan phases 9 and 8).
// Test Type: Integration.
//
// Harness (src/test/, same as agent-platform-web.int.test.tsx and self-learning-web.int.test.tsx): `renderWithRuntime({ pathname })`
//   mounts ChatRuntimeProvider + ChatShell + Toaster with mocked next/navigation; MSW server from '@/test/msw-server'
//   (`onUnhandledRequest: 'error'`); fixtures of '@/test/fixtures', built to pass the schemas of `packages/contracts`.
// Mock boundary: network (MSW), next/navigation, the event source of LiveStore. Real: the shell, LiveStore, FeedStore, toFeed,
//   `changedFields`, DecisionCard, DefinitionView, RecordPage, DeepAgentCard, the panel «Схема», RunTaskList and AgentScreen. Do NOT mock
//   any of them.
//
// Server-side proofs are NOT repeated here: the save's version check and the refusal's path and rule are the API tests of the part
//   (apps/api/test/deep-agents-agent-types.int.e2e-spec.ts). Every server answer below is scripted; the test proves what the browser shows.

import {
  DecisionRequestSchema,
  type Confirmation,
  type ConversationView,
  type DecisionResponse,
  type LibraryChoices,
  type MyRoleList,
  type RecordDetail,
  type RunTaskView,
  type Subagent,
} from '@agent-os/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  agentNode,
  agentPageView,
  conversationView,
  deepAgentContent,
  deepAgentOrigin,
  deepAgentRunView,
  fixtureId,
  fixtureTime,
  historyEntry,
  recordConfirmation,
  recordDetail,
  runTask,
  threadList,
  threadSummary,
} from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';
const MODEL = 'anthropic/claude-haiku-4-5';
const DEEP_AGENT_ID = fixtureId(71);
const DEEP_AGENT_NAME = 'Разбор ошибок оплаты';
const TEAM_LIST = 'Сабагенты, кого и когда звать, решает агент';

const subagent = (name: string, description: string, prompt = `Ты — ${name}.`): Subagent => ({
  name,
  description,
  prompt,
  servers: ['logs'],
  model: MODEL,
  maxTurns: 20,
  maxRuns: 3,
});

/** Desktop: the panel «Схема» sits beside the feed and opens by itself (UXRD DA-12, Responsive Behavior). */
const DESKTOP = { '(min-width: 1024px)': true, '(min-width: 768px)': true };

/** The run of the deep agent «Разбор ошибок оплаты» started from the conversation. */
const DEEP_RUN_ID = 'deep-1';
const deepOrigin = () => ({ ...deepAgentOrigin(), recordId: DEEP_AGENT_ID, name: DEEP_AGENT_NAME, builtinKey: null });

/** The task list's rows as their expand buttons read them (MC-12): «Задача {N}: {текст}, {статус}». */
function taskRows(list: HTMLElement): (string | null)[] {
  return within(list)
    .getAllByRole('button')
    .map((row) => row.getAttribute('aria-label'));
}

/** The subagent row of the team list, by the subagent's name. */
function subagentRow(list: HTMLElement, name: string): HTMLElement {
  const row = within(list).getByText(name).closest('li');
  if (row === null) throw new Error(`no subagent row «${name}»`);
  return row;
}

describe('deep-agents / web - integration (jsdom + MSW)', () => {
  // AC: AC-29.1 "Глубокий агент в библиотеке открывается карточкой только для чтения" (UXRD DA-13)
  // Behavior: Аня opens her deep agent with two subagents, «Писатель» writing the answer -> the card shows the team with «пишет ответ»
  //   on «Писатель» and «Кто пишет ответ — Писатель», and not one field to type into.
  // Catches: a deep agent opened by an editor form again (KD-1: the chat changes it, not a form), or a card that loses the team or its final
  //   subagent - no unit test sees the record page's choice of the card.
  // @category: core-functionality
  // @dependency: RecordPage, DeepAgentCard, DefinitionView, MSW, next/navigation mock
  // @complexity: low
  it('WEB-2 (a): the deep agent card shows the team with its final subagent and offers no field to edit', async () => {
    // Arrange: Аня's deep agent «Разбор ошибок оплаты» with «Аналитик» and «Писатель», «Писатель» writes the answer
    const record = recordDetail({
      id: DEEP_AGENT_ID,
      kind: 'deep_agent',
      name: DEEP_AGENT_NAME,
      description: 'Ищет причины ошибок оплаты',
      content: deepAgentContent({
        subagents: [subagent('Аналитик', 'Ищет причины ошибок'), subagent('Писатель', 'Пишет сводку по находкам')],
        finalSubagent: 'Писатель',
      }),
    });
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
      http.get(`${API}/api/library/${DEEP_AGENT_ID}`, () => HttpResponse.json(record)),
      http.get(`${API}/api/library/choices`, () =>
        HttpResponse.json({ servers: ['logs'], defaultModel: MODEL, defaultMaxTurns: 40 } satisfies LibraryChoices),
      ),
      http.get(`${API}/api/auth/me/roles`, () => HttpResponse.json([] satisfies MyRoleList)),
    );

    // Act
    renderWithRuntime({ pathname: `/library/${DEEP_AGENT_ID}` });
    const team = await screen.findByRole('list', { name: TEAM_LIST });

    // Assert (AC-29.1): the team with its final subagent; nothing on the page can be typed into
    expect(within(team).getAllByRole('listitem')).toHaveLength(2);
    expect(within(subagentRow(team, 'Писатель')).getByText('пишет ответ')).toBeInTheDocument();
    expect(within(subagentRow(team, 'Аналитик')).queryByText('пишет ответ')).toBeNull();
    const main = screen.getByRole('main');
    expect(within(main).getByText('Кто пишет ответ').closest('div')).toHaveTextContent('Писатель');
    for (const role of ['textbox', 'combobox', 'spinbutton'] as const) {
      expect(within(main).queryAllByRole(role)).toHaveLength(0);
    }
  });

  // AC: AC-06.1 "Чат правит запись только через карточку подтверждения" (вид); AC-06.4 (вид отказа, KD-4); PRD Risks «Слабая модель шлёт
  //   неполную запись» (UXRD DA-11, MC-24)
  // Behavior: the chat proposes an edit of «Разбор ошибок оплаты»: «Аналитик» gets a new instruction, «Сборщик» is left out and «Писатель»
  //   comes in -> the card «Изменить «Разбор ошибок оплаты»» marks «Аналитик» «изменено», «Писатель» «новый», says «Убрано: Сборщик» and
  //   marks nothing else -> Аня presses «Сохранить изменения», the save is refused -> the card ends «Не сохранено:» with the platform's
  //   text as is.
  // Catches: an omitted subagent the card does not name (the person would approve a team that silently lost a member), a mark on what did
  //   not change, and an approved card that reads as saved when the save was refused.
  // @category: core-functionality
  // @dependency: toFeed, DecisionCard, DefinitionView, changedFields, FeedStore, LiveStore, MSW, next/navigation mock
  // @complexity: medium
  it('WEB-2 (b, c): the edit card marks changed, new and removed subagents, and a refusal after approval shows the platform text', async () => {
    // Arrange: the open card of the chat's `edit_record`; the save after approval is refused
    const refusal = 'recordId: the record changed after the card was shown; read it again and propose the change anew';
    const description = 'Ищет причины ошибок оплаты';
    const previous = {
      name: DEEP_AGENT_NAME,
      description,
      content: deepAgentContent({
        subagents: [subagent('Аналитик', 'Ищет причины ошибок'), subagent('Сборщик', 'Собирает логи')],
      }),
      version: 4,
    };
    const next = {
      name: DEEP_AGENT_NAME,
      description,
      content: deepAgentContent({
        subagents: [
          subagent('Аналитик', 'Ищет причины ошибок', 'Сначала прочитай логи, потом тикеты.'),
          subagent('Писатель', 'Пишет сводку по находкам'),
        ],
      }),
    };
    const card = recordConfirmation(
      { action: 'edit', recordId: DEEP_AGENT_ID, kind: 'deep_agent', system: false, next, previous },
      { decisionId: 'd-edit', createdAt: fixtureTime(2) },
    );
    const thread = threadSummary({ id: 'a', title: 'Правка разбора' });
    let view: ConversationView = conversationView({
      thread,
      chat: { status: 'awaiting_confirmation', failureReason: null, rootAgentId: 'root', model: 'claude-haiku-4-5' },
      entries: [
        historyEntry({ kind: 'task', seq: 1, content: { text: 'Добавь писателя в разбор ошибок оплаты' } }),
        historyEntry({
          kind: 'model_answer',
          seq: 2,
          content: {
            text: 'Предлагаю правку.',
            toolCalls: [{ callId: 'c1', tool: 'edit_record', server: null, args: card.args, state: 'awaiting_confirmation' }],
          },
        }),
      ],
      decisions: [card],
    });
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([thread]))),
      http.get(`${API}/api/threads/a`, () => HttpResponse.json(thread)),
      http.get(`${API}/api/threads/a/history`, ({ request }) => {
        const afterSeq = Number(new URL(request.url).searchParams.get('afterSeq'));
        return HttpResponse.json({ ...view, entries: view.entries.filter((entry) => entry.seq > afterSeq) });
      }),
      http.post(`${API}/api/decisions/:decisionId`, async ({ request }) => {
        const body = DecisionRequestSchema.parse(await request.json());
        const resolved: Confirmation = {
          ...card,
          status: 'resolved',
          resolution: { approve: body.approve, args: card.args },
          resolvedAt: fixtureTime(2.5),
        };
        view = {
          ...view,
          chat: { ...view.chat, status: 'idle' },
          decisions: [resolved],
          entries: [
            ...view.entries,
            historyEntry({
              kind: 'tool_result',
              seq: 3,
              content: {
                callId: 'c1',
                tool: 'edit_record',
                server: null,
                args: card.args,
                outcome: 'refused',
                refusalReason: 'version_conflict',
                text: refusal,
              },
            }),
          ],
        };
        return HttpResponse.json({ outcome: 'resolved' } satisfies DecisionResponse);
      }),
    );
    const user = userEvent.setup();
    renderWithRuntime({ pathname: '/chat/a' });

    // Act 1: the card stands in the feed
    const edit = await screen.findByRole('group', { name: `Нужно решение: Изменить «${DEEP_AGENT_NAME}»` });
    const team = within(edit).getByRole('list', { name: TEAM_LIST });

    // Assert 1 (DA-11, MC-24): the changed, the new and the removed subagent are named; nothing else is marked
    expect(within(subagentRow(team, 'Аналитик')).getByText('изменено')).toBeInTheDocument();
    expect(within(subagentRow(team, 'Писатель')).getByText('новый')).toBeInTheDocument();
    expect(within(edit).getByText('Убрано: Сборщик')).toBeInTheDocument();
    expect(within(edit).getAllByText('изменено')).toHaveLength(1);

    // Act 2: approve; the save is refused
    await user.click(within(edit).getByRole('button', { name: 'Сохранить изменения' }));

    // Assert 2 (AC-06.4, KD-4): «Не сохранено:» and the platform's text as is; the card asks nothing more
    const done = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-decision-id="d-edit"]');
      expect(element).toHaveAttribute('data-state', 'failed');
      return element;
    });
    if (done === null) throw new Error('the decision card left the feed');
    expect(within(done).getByText(`Не сохранено: ${refusal}`)).toBeInTheDocument();
    expect(within(done).queryByRole('button', { name: 'Сохранить изменения' })).toBeNull();
  });

  // AC: AC-28.1 "Когда чат создал запись, схема показывает её", AC-28.2 "После правки схема показывает новую версию без перезагрузки",
  //   AC-28.3 "У запущенного глубокого агента в панели есть вкладка «Задачи»" (UXRD DA-12, DA-05; DD §KD-6)
  // Behavior: Аня's conversation touches no record -> the chat creates «Разбор ошибок оплаты» with three subagents (a `tree` note brings
  //   `focus` «создано») -> the panel opens by itself, focus stays in the feed, and shows the three -> the chat drops «Сборщик» (`focus`
  //   «изменено» at a new time, the record's version 2) -> two without a reload -> the chat starts the deep agent (`focus` «запущено»,
  //   a deep agent among the conversation's agents) -> the panel turns to «Задачи · 3» with the items and their statuses.
  // Catches: a panel that keeps the version it read first (AC-28.2 is about exactly this), a panel that never opens or steals focus, and a
  //   started deep agent whose list the conversation never shows - no unit test sees the store, the live note and the panel together.
  // @category: core-functionality
  // @dependency: ChatShell, SchemaAutoOpen, SchemaPanel, DefinitionView, RunTaskList, FeedStore, LiveStore, MSW, next/navigation mock
  // @complexity: high
  it('WEB-1 (a-c): the panel opens on a created deep agent, re-reads it after a change and shows «Задачи» once it starts', async () => {
    // Arrange: a conversation with no record in focus; the record and the list answer from the state below
    const description = 'Ищет причины ошибок оплаты';
    const detail = (version: number, subagents: Subagent[]): RecordDetail =>
      recordDetail({ id: DEEP_AGENT_ID, kind: 'deep_agent', name: DEEP_AGENT_NAME, description, version, content: deepAgentContent({ subagents }) });
    const analyst = subagent('Аналитик', 'Ищет причины ошибок');
    const collector = subagent('Сборщик', 'Собирает логи');
    const writer = subagent('Писатель', 'Пишет сводку по находкам');
    let record = detail(1, [analyst, collector, writer]);
    let tasks: RunTaskView[] = [];
    const thread = threadSummary({ id: 'a', title: 'Разбор ошибок' });
    let view: ConversationView = conversationView({
      thread,
      entries: [historyEntry({ kind: 'task', seq: 1, content: { text: 'Сделай глубокого агента для ошибок оплаты' } })],
    });
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([thread]))),
      http.get(`${API}/api/threads/a`, () => HttpResponse.json(thread)),
      http.get(`${API}/api/threads/a/history`, ({ request }) => {
        const afterSeq = Number(new URL(request.url).searchParams.get('afterSeq'));
        return HttpResponse.json({ ...view, entries: view.entries.filter((entry) => entry.seq > afterSeq) });
      }),
      http.get(`${API}/api/library/${DEEP_AGENT_ID}`, () => HttpResponse.json(record)),
      http.get(`${API}/api/agents/${DEEP_RUN_ID}/run`, () => HttpResponse.json(deepAgentRunView({ origin: deepOrigin() }))),
      http.get(`${API}/api/agents/${DEEP_RUN_ID}/tasks`, () => HttpResponse.json({ tasks })),
    );
    const { live } = renderWithRuntime({ pathname: '/chat/a', media: DESKTOP });
    await screen.findByText('Сделай глубокого агента для ошибок оплаты');
    expect(screen.queryByRole('complementary', { name: 'Схема' })).toBeNull();

    // Act 1: the chat created the deep agent
    view = { ...view, focus: { recordId: DEEP_AGENT_ID, action: 'created', at: fixtureTime(3) } };
    live.emit('tree', { threadId: 'a' });

    // Assert 1 (AC-28.1): the panel opened by itself, focus stayed out of it, the three subagents are drawn
    const panel = await screen.findByRole('complementary', { name: 'Схема' });
    const team = await within(panel).findByRole('list', { name: TEAM_LIST });
    expect(within(team).getAllByRole('listitem')).toHaveLength(3);
    expect(panel.contains(document.activeElement)).toBe(false);

    // Act 2: the chat dropped «Сборщик»: version 2, the same record in focus at a new time
    record = detail(2, [analyst, writer]);
    view = { ...view, focus: { recordId: DEEP_AGENT_ID, action: 'changed', at: fixtureTime(4) } };
    live.emit('tree', { threadId: 'a' });

    // Assert 2 (AC-28.2): two subagents, without a reload
    await waitFor(() => {
      expect(within(within(panel).getByRole('list', { name: TEAM_LIST })).getAllByRole('listitem')).toHaveLength(2);
    });
    expect(within(panel).queryByText('Сборщик')).toBeNull();

    // Act 3: the chat started the deep agent; its plan has three items
    tasks = [
      runTask({ number: 1, text: 'Собрать логи за ночь', status: 'done' }),
      runTask({ number: 2, text: 'Найти причину отказов', status: 'running' }),
      runTask({ number: 3, text: 'Написать сводку' }),
    ];
    view = {
      ...view,
      agents: [
        agentNode({ agentId: DEEP_RUN_ID, name: DEEP_AGENT_NAME, origin: deepOrigin(), status: 'working', createdAt: fixtureTime(5) }),
      ],
      focus: { recordId: DEEP_AGENT_ID, action: 'started', at: fixtureTime(5) },
    };
    live.emit('tree', { threadId: 'a' });

    // Assert 3 (AC-28.3): the panel is on «Задачи · 3» with each item's number, text and status
    const tasksTab = await within(panel).findByRole('tab', { name: 'Задачи · 3' });
    expect(tasksTab).toHaveAttribute('aria-selected', 'true');
    expect(taskRows(within(panel).getByRole('list', { name: 'Задачи' }))).toEqual([
      'Задача 1: Собрать логи за ночь, Готова',
      'Задача 2: Найти причину отказов, В работе',
      'Задача 3: Написать сводку, Ожидает',
    ]);
  });

  // AC: AC-04.1 "Сотрудник видит план глубокого агента на его странице" (вид); UXRD DA-04 "Выбранная вкладка живёт в адресе"
  // Behavior: Аня opens the address of the deep agent's tab «Задачи» -> the page shows that tab chosen, the plan items with their statuses
  //   in place of the feed, and the composer under it.
  // Catches: an address whose tab is lost (a link or «Назад» lands on «Ход работы»), and a tab that drops the composer.
  // @category: core-functionality
  // @dependency: parseShellRoute, AgentScreen, RunTaskList, Thread, MSW, next/navigation mock
  // @complexity: low
  it('WEB-1 (d): the deep agent page opened at its «Задачи» address shows the list under the chosen tab', async () => {
    // Arrange: the deep agent's page and a plan of two items
    const page = agentPageView({
      agent: { agentId: DEEP_RUN_ID, name: DEEP_AGENT_NAME, origin: deepOrigin(), status: 'working', threadId: 'a' },
      entries: [historyEntry({ kind: 'task', seq: 1, content: { text: 'Почему падают платежи?' } })],
    });
    const tasks = [runTask({ number: 1, text: 'Собрать логи за ночь', status: 'done' }), runTask({ number: 2, text: 'Найти причину отказов' })];
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
      http.get(`${API}/api/agents/${DEEP_RUN_ID}/history`, () => HttpResponse.json(page)),
      http.get(`${API}/api/agents/${DEEP_RUN_ID}/run`, () => HttpResponse.json(deepAgentRunView({ origin: deepOrigin() }))),
      http.get(`${API}/api/agents/${DEEP_RUN_ID}/tasks`, () => HttpResponse.json({ tasks })),
    );

    // Act
    renderWithRuntime({ pathname: `/agents/${DEEP_RUN_ID}/tasks` });

    // Assert (AC-04.1, DA-04): «Задачи · 2» chosen, the items with their statuses, the composer stays
    const tasksTab = await screen.findByRole('tab', { name: 'Задачи · 2' });
    expect(tasksTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Ход работы' })).toHaveAttribute('aria-selected', 'false');
    expect(taskRows(screen.getByRole('list', { name: 'Задачи' }))).toEqual([
      'Задача 1: Собрать логи за ночь, Готова',
      'Задача 2: Найти причину отказов, Ожидает',
    ]);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});
