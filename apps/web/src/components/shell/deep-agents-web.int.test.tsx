// deep-agents / web - integration tests (Vitest + RTL + MSW 2, jsdom)
// Design Doc: docs/features/deep-agents/design-agent-types.md (v1.3), Test Strategy UC-10 (the diagram panel, the task list and the record
//   card in the library), §KD-6 and §C3 web (the panel, the tab «Задачи», the «Запись» card); UXRD: docs/features/deep-agents/uxrd.md
//   DA-04, DA-05, DA-11, DA-12, DA-13, MC-9–MC-14, MC-24, MC-25; design-task-list.md KD-5 (the tab «Задачи» shows the conversation's list).
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
  taskList: false,
});

/** Desktop: the panel «Схема» sits beside the feed and opens by itself (UXRD DA-12, Responsive Behavior). */
const DESKTOP = { '(min-width: 1024px)': true, '(min-width: 768px)': true };

/** The run of the deep agent «Разбор ошибок оплаты» started from the conversation. */
const DEEP_RUN_ID = 'deep-1';
const deepOrigin = () => ({ ...deepAgentOrigin(), recordId: DEEP_AGENT_ID, name: DEEP_AGENT_NAME, builtinKey: null });

/** The task list's rows as their expand buttons read them (MC-12): «Задача {N}: {тема}, {статус}». */
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

  // AC: AC-15.1 "Сотрудник видит список задач беседы, и он обновляется без перезагрузки" (UXRD DA-12, KD-3, KD-7; design-task-list.md KD-5)
  // Behavior: Аня's conversation has no task and a deep agent with its own list -> the chat creates three tasks (a `tree` note) -> the panel
  //   opens by itself on «Задачи · 3», focus stays in the feed, and shows the conversation's tasks: the one in progress with its in-progress
  //   text, the blocked one with «ждёт 2» -> the chat finishes task 2 and starts task 3 (another note) -> the rows follow without a reload.
  // Catches: a tab that shows a deep agent's list instead of the conversation's, a list read once and never again, and a panel that does not
  //   open on the first task or steals focus - no unit test sees the live note, the shell and the panel together.
  // @category: core-functionality
  // @dependency: ChatShell, SchemaAutoOpen, SchemaPanel, RunTaskList, FeedStore, LiveStore, MSW, next/navigation mock
  // @complexity: medium
  it('WEB-1: the panel opens on the first tasks of the conversation and its tab «Задачи» follows them after each `tree` note', async () => {
    // Arrange: the conversation «a» (root «root») with no task; a deep agent it started keeps a list of its own
    let tasks: RunTaskView[] = [];
    const thread = threadSummary({ id: 'a', title: 'Релизы и инциденты' });
    const view: ConversationView = conversationView({
      thread,
      entries: [historyEntry({ kind: 'task', seq: 1, content: { text: 'Сравни релизы за год с инцидентами' } })],
      agents: [agentNode({ agentId: DEEP_RUN_ID, name: DEEP_AGENT_NAME, origin: deepOrigin(), status: 'working', createdAt: fixtureTime(1) })],
    });
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([thread]))),
      http.get(`${API}/api/threads/a`, () => HttpResponse.json(thread)),
      http.get(`${API}/api/threads/a/history`, ({ request }) => {
        const afterSeq = Number(new URL(request.url).searchParams.get('afterSeq'));
        return HttpResponse.json({ ...view, entries: view.entries.filter((entry) => entry.seq > afterSeq) });
      }),
      http.get(`${API}/api/agents/${DEEP_RUN_ID}/run`, () => HttpResponse.json(deepAgentRunView({ origin: deepOrigin() }))),
      http.get(`${API}/api/agents/root/tasks`, () => HttpResponse.json({ tasks })),
      http.get(`${API}/api/agents/${DEEP_RUN_ID}/tasks`, () =>
        HttpResponse.json({ tasks: [runTask({ id: 1, subject: 'Собрать логи за ночь', status: 'in_progress' })] }),
      ),
    );
    const { live } = renderWithRuntime({ pathname: '/chat/a', media: DESKTOP });
    await screen.findByText('Сравни релизы за год с инцидентами');
    expect(screen.queryByRole('complementary', { name: 'Схема' })).toBeNull();

    // Act 1: the chat created three tasks and started the second
    tasks = [
      runTask({ id: 1, subject: 'Найти релизы за год', status: 'completed' }),
      runTask({ id: 2, subject: 'Сравнить с инцидентами', status: 'in_progress', activeForm: 'Сравниваю релизы с инцидентами' }),
      runTask({ id: 3, subject: 'Написать сводку', blockedBy: [2] }),
    ];
    live.emit('tree', { threadId: 'a' });

    // Assert 1 (AC-15.1, KD-7): the panel opened by itself on «Задачи · 3», focus stayed out of it, the conversation's tasks are listed
    const panel = await screen.findByRole('complementary', { name: 'Схема' });
    const tasksTab = await within(panel).findByRole('tab', { name: 'Задачи · 3' });
    expect(tasksTab).toHaveAttribute('aria-selected', 'true');
    expect(panel.contains(document.activeElement)).toBe(false);
    const list = within(panel).getByRole('list', { name: 'Задачи' });
    expect(taskRows(list)).toEqual([
      'Задача 1: Найти релизы за год, Готова',
      'Задача 2: Сравнить с инцидентами, В работе',
      'Задача 3: Написать сводку, Ожидает',
    ]);
    expect(within(list).getByText('В работе · Сравниваю релизы с инцидентами')).toBeInTheDocument();
    expect(within(list).getByText('Ожидает · ждёт 2')).toBeInTheDocument();

    // Act 2: task 2 is done, task 3 is in progress
    tasks = [
      tasks[0],
      runTask({ id: 2, subject: 'Сравнить с инцидентами', status: 'completed' }),
      runTask({ id: 3, subject: 'Написать сводку', status: 'in_progress', activeForm: 'Пишу сводку', blockedBy: [2] }),
    ];
    live.emit('tree', { threadId: 'a' });

    // Assert 2 (AC-15.1): the rows follow without a reload; task 3 waits for nothing any more
    await waitFor(() => {
      expect(taskRows(within(panel).getByRole('list', { name: 'Задачи' }))).toEqual([
        'Задача 1: Найти релизы за год, Готова',
        'Задача 2: Сравнить с инцидентами, Готова',
        'Задача 3: Написать сводку, В работе',
      ]);
    });
    expect(within(panel).getByText('В работе · Пишу сводку')).toBeInTheDocument();
  });

  // AC: AC-04.1 "Сотрудник видит план глубокого агента на его странице" (вид); UXRD DA-04 "Выбранная вкладка живёт в адресе"
  // Behavior: Аня opens the address of the deep agent's tab «Задачи» -> the page shows that tab chosen, its tasks with their statuses
  //   in place of the feed, and the composer under it.
  // Catches: an address whose tab is lost (a link or «Назад» lands on «Ход работы»), and a tab that drops the composer.
  // @category: core-functionality
  // @dependency: parseShellRoute, AgentScreen, RunTaskList, Thread, MSW, next/navigation mock
  // @complexity: low
  it('WEB-1 (d): the deep agent page opened at its «Задачи» address shows the list under the chosen tab', async () => {
    // Arrange: the deep agent's page and a list of two tasks
    const page = agentPageView({
      agent: { agentId: DEEP_RUN_ID, name: DEEP_AGENT_NAME, origin: deepOrigin(), status: 'working', threadId: 'a' },
      entries: [historyEntry({ kind: 'task', seq: 1, content: { text: 'Почему падают платежи?' } })],
    });
    const tasks = [
      runTask({ id: 1, subject: 'Собрать логи за ночь', status: 'completed' }),
      runTask({ id: 2, subject: 'Найти причину отказов' }),
    ];
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
      http.get(`${API}/api/agents/${DEEP_RUN_ID}/history`, () => HttpResponse.json(page)),
      http.get(`${API}/api/agents/${DEEP_RUN_ID}/run`, () => HttpResponse.json(deepAgentRunView({ origin: deepOrigin() }))),
      http.get(`${API}/api/agents/${DEEP_RUN_ID}/tasks`, () => HttpResponse.json({ tasks })),
    );

    // Act
    renderWithRuntime({ pathname: `/agents/${DEEP_RUN_ID}/tasks` });

    // Assert (AC-04.1, DA-04): «Задачи · 2» chosen, the tasks with their statuses, the composer stays
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
