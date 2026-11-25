// self-learning / training-web - integration tests (Vitest + RTL + MSW 2, jsdom)
// Design Doc: docs/features/self-learning/design-training-web.md, Test Strategy UC-1 (the start from the card), UC-3 (the training
//   conversation takes no message); UXRD SL-01, TR-01, MC-9, MC-10.
//
// Harness (src/test/, as deep-agents-web.int.test.tsx): `renderWithRuntime({ pathname })` mounts the shell with mocked next/navigation;
//   MSW server from '@/test/msw-server' (`onUnhandledRequest: 'error'`); answers built to pass the schemas of `packages/contracts`.
// Mock boundary: network (MSW), next/navigation, the event source of LiveStore.
//
// Server-side proofs are not repeated here: who may train, start, read the texts and activate is apps/api self-learning-training (TR-5).

import {
  TrainingErrorCode,
  type ConversationView,
  type HistoryEntry,
  type LibraryChoices,
  type MyRoleList,
  type SendMessageResponse,
  type StopResponse,
  type TestRunStarted,
  type TestRunSummary,
  type TestRunTaken,
  type ThreadSummary,
  type TrainingActivated,
  type TrainingState,
  type TrainingView,
} from '@agent-os/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  agentNode,
  conversationView,
  conversationWithTurns,
  currentUser,
  deepAgentContent,
  deepAgentOrigin,
  fixtureId,
  fixtureTime,
  historyEntry,
  recordDetail,
  recordSummary,
  testRunSummary,
  testRunView,
  threadList,
  threadSummary,
} from '@/test/fixtures';
import { server } from '@/test/msw-server';
import {
  renderWithRuntime,
  type RenderWithRuntimeResult,
} from '@/test/render-with-runtime';

type User = ReturnType<typeof userEvent.setup>;

const API = 'http://api.test';
const AGENT_ID = fixtureId(81);
const TRAINING_ID = fixtureId(82);
const AGENT_NAME = 'Разбор заказов';

/** The page of Аня's self-learning deep agent, with the reads the record page makes. */
function recordPageHandlers() {
  return [
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
    http.get(`${API}/api/library/${AGENT_ID}`, () =>
      HttpResponse.json(
        recordDetail({
          id: AGENT_ID,
          kind: 'deep_agent',
          name: AGENT_NAME,
          content: deepAgentContent({ selfLearning: true }),
        }),
      ),
    ),
    http.get(`${API}/api/library/choices`, () =>
      HttpResponse.json({
        servers: ['logs'],
        defaultModel: 'anthropic/claude-haiku-4-5',
        defaultMaxTurns: 40,
      } satisfies LibraryChoices),
    ),
    http.get(`${API}/api/auth/me/roles`, () =>
      HttpResponse.json([] satisfies MyRoleList),
    ),
    http.get(`${API}/api/library/${AGENT_ID}/training`, () =>
      HttpResponse.json({
        canTrain: true,
        selfLearning: true,
        capUsd: 2,
        running: null,
        lastFinished: null,
      } satisfies TrainingState),
    ),
  ];
}

describe('self-learning / training-web - integration (jsdom + MSW)', () => {
  // UC-1, MC-9. Catches: a refused start that shows nothing (or navigates anyway); a started training that does not open its conversation.
  it('WEB-T1: «Обучить» shows the refusal TRAINING_RUNNING as its text, and a started training opens its conversation', async () => {
    let answer: 'running' | 'started' = 'running';
    server.use(
      ...recordPageHandlers(),
      http.post(`${API}/api/library/${AGENT_ID}/training`, () =>
        answer === 'running'
          ? HttpResponse.json(
              {
                statusCode: 409,
                error: 'Conflict',
                errorCode: TrainingErrorCode.TRAINING_RUNNING,
                message: 'A training is running',
              },
              { status: 409 },
            )
          : HttpResponse.json({ trainingId: TRAINING_ID }, { status: 201 }),
      ),
    );
    const user = userEvent.setup();
    const { router } = renderWithRuntime({ pathname: `/library/${AGENT_ID}` });

    await user.click(await screen.findByRole('button', { name: 'Обучить' }));
    expect(
      await screen.findByText(/A training is running/),
    ).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();

    answer = 'started';
    await user.click(await screen.findByRole('button', { name: 'Обучить' }));
    await vi.waitFor(() =>
      expect(router.push).toHaveBeenCalledWith(`/chat/${TRAINING_ID}`),
    );
  });

  // UC-3, TR-01, MC-10. Catches: a composer in the training conversation (a message would reach the trainer); a «Стоп» missing while it
  //   works, or one that stops anything but the conversation's root.
  it('WEB-T3: the training conversation has no composer and, while it works, «Стоп» stops its root', async () => {
    const thread = threadSummary({
      id: TRAINING_ID,
      title: `Обучение «${AGENT_NAME}»`,
    });
    const stops: string[] = [];
    server.use(
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(threadList([thread])),
      ),
      http.get(`${API}/api/threads/${TRAINING_ID}`, () =>
        HttpResponse.json(thread),
      ),
      http.get(`${API}/api/threads/${TRAINING_ID}/history`, () =>
        HttpResponse.json(
          conversationView({
            thread,
            chat: {
              status: 'working',
              failureReason: null,
              rootAgentId: TRAINING_ID,
              model: 'anthropic/claude-haiku-4-5',
            },
            training: {
              agentId: AGENT_ID,
              trainingId: TRAINING_ID,
              isRoot: true,
              testRun: false,
              run: null,
            },
          }),
        ),
      ),
      http.post(`${API}/api/agents/:agentId/stop`, ({ params }) => {
        stops.push(String(params.agentId));
        return HttpResponse.json({
          stopped: [TRAINING_ID],
        } satisfies StopResponse);
      }),
    );
    const user = userEvent.setup();
    renderWithRuntime({ pathname: `/chat/${TRAINING_ID}` });

    const readOnly = await screen.findByText(
      'Беседа обучения только для чтения.',
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    const line = readOnly.parentElement;
    if (line === null) throw new Error('no training line');
    await user.click(within(line).getByRole('button', { name: 'Стоп' }));
    await vi.waitFor(() => expect(stops).toEqual([TRAINING_ID]));
  });
});

// create-and-test / chat-web — Design Doc: docs/features/create-and-test/design-chat-web.md, Test Strategy UC-1 – UC-5, UC-7
//   (KD-1 – KD-7, Flows 1–2); UXRD v2.0 CT-01 – CT-09, MC-1 – MC-17. Server-side proofs (who may start, take and activate, the phases,
//   the rounds) are apps/api create-and-test-run.
describe('create-and-test / chat-web - integration (jsdom + MSW)', () => {
  const TEST_RUN_ID = fixtureId(83);
  const SOURCE_ID = fixtureId(84);
  const TAKEN_THREAD_ID = fixtureId(85);
  const DESCRIPTION = 'Разбирать ошибки заказов';

  /** A finished tool call of a trainer's answer. */
  const call = (tool: string, callId: string, args: unknown = {}) => ({
    callId,
    tool,
    server: null,
    args,
    state: 'done' as const,
  });

  const planArgs = {
    name: AGENT_NAME,
    description: 'Разбирает ошибки заказов за день',
    servers: ['logs'],
    tests: [{ task: 'Найди ошибки за вчера', expected: 'Список ошибок' }],
  };

  /** The run's agent once the trainer created it. */
  const createdAgent = { id: AGENT_ID, name: AGENT_NAME, deleted: false };

  /** The test run's conversation: the description, the trainer's plan, the confirmation, the agent's creation. */
  const confirmedEntries = [
    historyEntry({ kind: 'task', seq: 1, content: { text: DESCRIPTION } }),
    historyEntry({
      kind: 'model_answer',
      seq: 2,
      content: {
        text: 'План готов',
        toolCalls: [call('propose_plan', 'plan-1', planArgs)],
      },
    }),
    historyEntry({
      kind: 'user_message',
      seq: 3,
      content: { text: 'Создать и проверить' },
    }),
    historyEntry({
      kind: 'model_answer',
      seq: 4,
      content: {
        text: 'Создаю агента',
        toolCalls: [call('create_agent', 'create-1')],
      },
    }),
  ];

  const confirmedPlan = {
    callId: 'plan-1',
    revision: 1,
    state: 'confirmed' as const,
    at: fixtureTime(3),
  };

  const firstRound = (passed: number | null = null) => ({
    startCallId: 'create-1',
    requested: false,
    passed,
    total: passed === null ? null : 4,
  });

  /** GET /threads/:id/history of the test run's conversation; `working` — the trainer's root works. */
  const testRunConversation = (
    run: TestRunSummary,
    entries: HistoryEntry[],
    thread: ThreadSummary = threadSummary({
      id: TEST_RUN_ID,
      title: 'Проверка нового агента',
      forkable: false,
    }),
  ) =>
    conversationView({
      thread,
      chat: {
        status: run.phase === 'working' ? 'working' : 'idle',
        failureReason: null,
        rootAgentId: TEST_RUN_ID,
        model: 'anthropic/claude-haiku-4-5',
      },
      entries,
      training: {
        agentId: run.agent?.id ?? null,
        trainingId: TEST_RUN_ID,
        isRoot: true,
        testRun: true,
        run,
      },
    });

  /** The list, the summary and the history of one conversation; `view` is read at every request. */
  const serveConversation = (view: () => ConversationView) => [
    http.get(`${API}/api/threads`, () =>
      HttpResponse.json(threadList([view().thread])),
    ),
    http.get(`${API}/api/threads/${view().thread.id}`, () =>
      HttpResponse.json(view().thread),
    ),
    http.get(`${API}/api/threads/${view().thread.id}/history`, () =>
      HttpResponse.json(view()),
    ),
  ];

  /** The paths and bodies of every POST the shell made. */
  const recordPosts = () => {
    const posts: { path: string; body: unknown }[] = [];
    const record = async ({ request }: { request: Request }) => {
      if (request.method !== 'POST') return;
      const text = await request.clone().text();
      posts.push({
        path: new URL(request.url).pathname,
        body: text === '' ? undefined : JSON.parse(text),
      });
    };
    server.events.on('request:start', record);
    onTestFinished(() => {
      server.events.removeListener('request:start', record);
    });
    return posts;
  };

  const chooseTestRun = async (user: User) => {
    await user.click(screen.getByRole('button', { name: 'Добавить' }));
    await user.click(
      await screen.findByRole('menuitem', {
        name: /Создать и проверить агента/,
      }),
    );
  };

  const waitForWatch = async (
    live: RenderWithRuntimeResult['live'],
    id: string,
  ) =>
    vi.waitFor(() =>
      expect(live.current()?.url).toBe(
        `${API}/api/events?watch=thread%3A${id}`,
      ),
    );

  const runCard = (name: RegExp) => screen.findByRole('group', { name });

  // UC-1: AC-09.1, AC-12.2, AC-12.3, AC-01.4, DC-1. Catches: the «+» row without the right; an empty field sent in a new chat;
  //   `originThreadId` in a new chat's body; a message sent to the feed on a refusal; the chip or the text lost on a refusal.
  it('UC-1: in an empty chat the action chip starts a test run without a conversation of its own; a refusal keeps the chip and the text', async () => {
    let answer: 'running' | 'started' = 'running';
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
      http.post(`${API}/api/test-runs`, () =>
        answer === 'running'
          ? HttpResponse.json(
              {
                statusCode: 409,
                message: 'A test run is running',
                errorCode: TrainingErrorCode.TEST_RUN_RUNNING,
                testRunId: SOURCE_ID,
                testRunTitle: 'Сводка по логам',
              },
              { status: 409 },
            )
          : HttpResponse.json(
              { testRunId: TEST_RUN_ID } satisfies TestRunStarted,
              { status: 201 },
            ),
      ),
    );
    const posts = recordPosts();
    const user = userEvent.setup();

    // Without the right: no row in «+»
    const withoutRight = renderWithRuntime({ pathname: '/' });
    await user.click(await screen.findByRole('button', { name: 'Добавить' }));
    await screen.findAllByRole('menuitem');
    expect(
      screen.queryByRole('menuitem', { name: /Создать и проверить агента/ }),
    ).toBeNull();
    withoutRight.unmount();

    // With the right: the chip; an empty field is not sent
    server.use(
      http.get(`${API}/api/auth/me`, () =>
        HttpResponse.json(currentUser({ trainOwn: true })),
      ),
    );
    const view = renderWithRuntime({ pathname: '/' });
    await chooseTestRun(user);
    expect(
      await screen.findByRole('button', {
        name: 'Убрать: Создать и проверить агента',
      }),
    ).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Создать и проверить' });
    expect(submit).toBeDisabled();
    const field = screen.getByRole('textbox', { name: 'Сообщение' });
    await user.click(field);
    await user.keyboard('{Enter}');

    // Refused: MC-3 under the field; the chip and the text stay; nothing reached a conversation
    await user.type(field, DESCRIPTION);
    await user.click(submit);
    const alert = await screen.findByText(/Уже идёт проверка/);
    expect(alert).toHaveTextContent(
      'Уже идёт проверка «Сводка по логам» — дождитесь итога или остановите её.',
    );
    expect(
      within(alert).getByRole('link', { name: 'Сводка по логам' }),
    ).toHaveAttribute('href', `/chat/${SOURCE_ID}`);
    expect(field).toHaveValue(DESCRIPTION);
    expect(
      screen.getByRole('button', {
        name: 'Убрать: Создать и проверить агента',
      }),
    ).toBeInTheDocument();
    expect(view.router.push).not.toHaveBeenCalled();

    // Started: the body has no `originThreadId`, the test run's conversation opens
    answer = 'started';
    await user.click(submit);
    await vi.waitFor(() =>
      expect(view.router.push).toHaveBeenCalledWith(`/chat/${TEST_RUN_ID}`),
    );
    expect(posts).toEqual([
      { path: '/api/test-runs', body: { description: DESCRIPTION } },
      { path: '/api/test-runs', body: { description: DESCRIPTION } },
    ]);
  });

  // UC-2: AC-09.2, AC-12.1. Catches: a body without the conversation's `originThreadId`; a fork without its divider.
  it('UC-2: in a conversation an empty field starts the test run in its fork, which opens with the divider', async () => {
    const source = threadSummary({ id: SOURCE_ID, title: 'Разбор Jira' });
    const fork = threadSummary({
      id: TEST_RUN_ID,
      title: 'Ветка · Разбор Jira',
      forkable: false,
      forkedFrom: { threadId: SOURCE_ID, title: 'Разбор Jira', throughSeq: 2 },
    });
    let open = source;
    server.use(
      http.get(`${API}/api/auth/me`, () =>
        HttpResponse.json(currentUser({ trainOwn: true })),
      ),
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(threadList([open])),
      ),
      http.get(`${API}/api/threads/${SOURCE_ID}`, () =>
        HttpResponse.json(source),
      ),
      http.get(`${API}/api/threads/${SOURCE_ID}/history`, () =>
        HttpResponse.json(
          conversationWithTurns(source, ['Разбери Jira', 'Готово']),
        ),
      ),
      http.get(`${API}/api/threads/${TEST_RUN_ID}`, () =>
        HttpResponse.json(fork),
      ),
      http.get(`${API}/api/threads/${TEST_RUN_ID}/history`, () =>
        HttpResponse.json(
          testRunConversation(
            testRunSummary(),
            [
              historyEntry({
                kind: 'task',
                seq: 1,
                content: { text: 'Разбери Jira' },
              }),
              historyEntry({
                kind: 'model_answer',
                seq: 2,
                content: { text: 'Готово' },
              }),
              historyEntry({
                kind: 'event',
                seq: 3,
                content: { event: 'forked', reason: null },
              }),
            ],
            fork,
          ),
        ),
      ),
      http.post(`${API}/api/test-runs`, () =>
        HttpResponse.json({ testRunId: TEST_RUN_ID } satisfies TestRunStarted, {
          status: 201,
        }),
      ),
    );
    const posts = recordPosts();
    const user = userEvent.setup();
    const view = renderWithRuntime({ pathname: `/chat/${SOURCE_ID}` });
    await screen.findByText('Готово');

    await chooseTestRun(user);
    await user.click(
      screen.getByRole('button', { name: 'Создать и проверить' }),
    );
    await vi.waitFor(() =>
      expect(view.router.push).toHaveBeenCalledWith(`/chat/${TEST_RUN_ID}`),
    );
    expect(posts).toEqual([
      {
        path: '/api/test-runs',
        body: { description: '', originThreadId: SOURCE_ID },
      },
    ]);

    open = fork;
    view.setPathname(`/chat/${TEST_RUN_ID}`);
    const divider = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-slot="feed-divider"]',
      );
      if (element === null) throw new Error('no feed divider');
      return element;
    });
    expect(divider).toHaveTextContent('Ответвлено от «Разбор Jira»');
    expect(
      within(divider).getByRole('link', { name: 'Разбор Jira' }),
    ).toHaveAttribute('href', `/chat/${SOURCE_ID}`);
  });

  // UC-3: AC-13.1, AC-13.7. Catches: «Взять» without the take route or without the agent's chip in the field; the plan's button
  //   without a message carrying its label; buttons on a replaced plan.
  it('UC-3: «Взять этого агента» opens the fork with the agent in the field; «Создать и проверить» answers the plan; a replaced plan has no buttons', async () => {
    const offerView = testRunConversation(
      testRunSummary({
        offer: {
          callId: 'offer-1',
          agentId: AGENT_ID,
          state: 'waiting',
          at: null,
        },
      }),
      [
        historyEntry({ kind: 'task', seq: 1, content: { text: DESCRIPTION } }),
        historyEntry({
          kind: 'model_answer',
          seq: 2,
          content: {
            text: 'Нашёл похожего агента',
            toolCalls: [call('offer_agent', 'offer-1', { agentId: AGENT_ID })],
          },
        }),
      ],
    );
    const taken = threadSummary({
      id: TAKEN_THREAD_ID,
      title: 'Ветка · Сводка',
    });
    server.use(
      ...serveConversation(() => offerView),
      http.get(`${API}/api/threads/${TAKEN_THREAD_ID}`, () =>
        HttpResponse.json(taken),
      ),
      http.get(`${API}/api/threads/${TAKEN_THREAD_ID}/history`, () =>
        HttpResponse.json(conversationWithTurns(taken, ['Сводка', 'Готово'])),
      ),
      http.get(`${API}/api/library`, () =>
        HttpResponse.json([
          recordSummary({ id: AGENT_ID, kind: 'deep_agent', name: AGENT_NAME }),
        ]),
      ),
      http.post(`${API}/api/test-runs/${TEST_RUN_ID}/take`, () =>
        HttpResponse.json({
          threadId: TAKEN_THREAD_ID,
          record: { id: AGENT_ID, kind: 'deep_agent', name: AGENT_NAME },
        } satisfies TestRunTaken),
      ),
    );
    const posts = recordPosts();
    const user = userEvent.setup();
    const offer = renderWithRuntime({ pathname: `/chat/${TEST_RUN_ID}` });

    const offerCard = await screen.findByRole('group', {
      name: /Есть похожий агент/,
    });
    await user.click(
      within(offerCard).getByRole('button', { name: 'Взять этого агента' }),
    );
    await vi.waitFor(() =>
      expect(offer.router.push).toHaveBeenCalledWith(
        `/chat/${TAKEN_THREAD_ID}`,
      ),
    );
    expect(posts.map((post) => post.path)).toEqual([
      `/api/test-runs/${TEST_RUN_ID}/take`,
    ]);
    offer.setPathname(`/chat/${TAKEN_THREAD_ID}`);
    expect(
      await screen.findByRole('button', { name: `Убрать: ${AGENT_NAME}` }),
    ).toBeInTheDocument();
    offer.unmount();

    // Two plans: the first replaced by the second, which waits
    const plansView = testRunConversation(
      testRunSummary({
        plans: [
          { callId: 'plan-1', revision: 1, state: 'replaced', at: null },
          { callId: 'plan-2', revision: 2, state: 'waiting', at: null },
        ],
      }),
      [
        historyEntry({ kind: 'task', seq: 1, content: { text: DESCRIPTION } }),
        historyEntry({
          kind: 'model_answer',
          seq: 2,
          content: {
            text: 'План',
            toolCalls: [
              call('propose_plan', 'plan-1', { ...planArgs, name: 'Сводка' }),
            ],
          },
        }),
        historyEntry({
          kind: 'user_message',
          seq: 3,
          content: { text: 'Добавь Jira' },
        }),
        historyEntry({
          kind: 'model_answer',
          seq: 4,
          content: {
            text: 'Исправленный план',
            toolCalls: [call('propose_plan', 'plan-2', planArgs)],
          },
        }),
      ],
    );
    server.use(
      ...serveConversation(() => plansView),
      http.post(`${API}/api/threads/${TEST_RUN_ID}/messages`, () =>
        HttpResponse.json({ messageId: null } satisfies SendMessageResponse, {
          status: 202,
        }),
      ),
    );
    renderWithRuntime({ pathname: `/chat/${TEST_RUN_ID}` });

    const replaced = await screen.findByRole('group', {
      name: /План · Сводка/,
    });
    expect(replaced).toHaveTextContent('Заменён планом ниже');
    expect(within(replaced).queryByRole('button')).toBeNull();
    const waiting = screen.getByRole('group', {
      name: new RegExp(`План · ${AGENT_NAME}`),
    });
    await user.click(
      within(waiting).getByRole('button', { name: 'Создать и проверить' }),
    );
    await vi.waitFor(() =>
      expect(posts.at(-1)).toEqual({
        path: `/api/threads/${TEST_RUN_ID}/messages`,
        body: { text: 'Создать и проверить' },
      }),
    );
  });

  // UC-4: AC-01.3, AC-14.1 – AC-14.3. Catches: a composer while the trainer works; no end line; a refusal without MC-17; a round
  //   asked for whose card is not under its own `startCallId`.
  it('UC-4: the footer follows the phase; a refused request keeps its text; a round asked for gets its own card', async () => {
    const fixAnswer = historyEntry({
      kind: 'model_answer',
      seq: 6,
      content: {
        text: 'Исправляю',
        toolCalls: [call('propose_version', 'fix-1')],
      },
    });
    const viewOf = (run: Partial<TestRunSummary>, extra: HistoryEntry[] = []) =>
      testRunConversation(
        testRunSummary({
          agent: createdAgent,
          plans: [confirmedPlan],
          ...run,
        }),
        [...confirmedEntries, ...extra],
      );
    const working = {
      phase: 'working' as const,
      canSend: false,
      closedReason: 'working' as const,
      step: 'Прогоняю тесты',
    };
    let current = viewOf({ ...working, rounds: [firstRound()] });
    server.use(
      ...serveConversation(() => current),
      http.post(`${API}/api/threads/${TEST_RUN_ID}/messages`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            message: 'The test run takes no message now',
            errorCode: TrainingErrorCode.TEST_RUN_NOT_ACCEPTING,
            reason: 'training_running',
          },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    const { live } = renderWithRuntime({ pathname: `/chat/${TEST_RUN_ID}` });
    const reread = async (next: ConversationView) => {
      current = next;
      live.emit('ready', {});
    };

    // Working: the line with «Стоп», no field; the card names the step, then the judged round
    expect(
      await screen.findByText(
        'Тренер работает — писать можно будет после итога.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Стоп' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).toBeNull();
    const card = await runCard(new RegExp(`^Проверка «${AGENT_NAME}»`));
    expect(card).toHaveTextContent('Сейчас: Прогоняю тесты');
    await waitForWatch(live, TEST_RUN_ID);
    await reread(viewOf({ ...working, rounds: [firstRound(3)] }));
    await vi.waitFor(() =>
      expect(card).toHaveTextContent('Первая версия — 3 из 4'),
    );

    // Result: the field; a request the run takes not now is refused by MC-17 and keeps its text
    await reread(
      viewOf({ phase: 'result', status: 'done', rounds: [firstRound(3)] }),
    );
    const field = await screen.findByRole('textbox', { name: 'Сообщение' });
    expect(field).toHaveAttribute(
      'placeholder',
      'Попросите исправить агента или спросите о проверке…',
    );
    await user.type(field, 'Исправь третий тест');
    await user.keyboard('{Enter}');
    expect(
      await screen.findByText(
        `Сейчас идёт обучение «${AGENT_NAME}» — исправить можно после него.`,
      ),
    ).toBeInTheDocument();
    expect(field).toHaveValue('Исправь третий тест');

    // A round asked for: its card stands under its own call; the first card keeps its result
    await reread(
      viewOf(
        {
          ...working,
          step: 'Исправляю агента',
          rounds: [
            firstRound(3),
            {
              startCallId: 'fix-1',
              requested: true,
              passed: null,
              total: null,
            },
          ],
        },
        [
          historyEntry({
            kind: 'user_message',
            seq: 5,
            content: { text: 'Исправь третий тест' },
          }),
          fixAnswer,
        ],
      ),
    );
    const fixCard = await runCard(
      new RegExp(`^Исправление 1 · «${AGENT_NAME}»`),
    );
    expect(fixCard).toHaveTextContent('Сейчас: Исправляю агента');
    expect(card).toHaveTextContent('Первая версия — 3 из 4');
    expect(card).not.toHaveTextContent('Сейчас:');
    const fixAnswerText = screen.getByText('Исправляю');
    expect(
      fixAnswerText.compareDocumentPosition(fixCard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Ended at the cap: the end line, no field
    await reread(
      viewOf({
        phase: 'ended',
        status: 'stopped',
        capped: true,
        canSend: false,
        closedReason: 'capped',
        rounds: [firstRound(3)],
      }),
    );
    expect(
      await screen.findByText(
        /^Проверка закончена: .+\. Писать сюда больше нельзя\.$/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).toBeNull();
  });

  // UC-5: AC-10.1, AC-10.2, AC-10.4, AC-08.1, AC-08.2, DC-2, DC-3. Catches: a panel that opens by itself; the activation of another
  //   version than the one chosen; «Запуск» links of a deleted agent.
  it('UC-5: the run tab opens only by «Ход и итог»; its rounds and fixes; the activation names the version; a deleted agent has no runs', async () => {
    const version = (n: number, canActivate: boolean) => ({
      versionId: fixtureId(100 + n),
      version: n,
      requested: false,
      passed: n,
      total: 3,
      errors: 0,
      toolCalls: 4,
      costUsd: 0.004,
      changes: n === 1 ? null : `Изменение ${n - 1}`,
      texts: { prompt: `Инструкция ${n}`, subagents: [], scripts: [] },
      canActivate,
    });
    const tests = (rounds: number) =>
      [1, 2].map((number) => ({
        task: `Тест ${number}`,
        expected: 'Ответ',
        rounds: Array.from({ length: rounds }, (_, index) => ({
          conversationId: fixtureId(110 + number * 10 + index),
          errors: 0,
          toolCalls: 2,
          costUsd: 0.001,
          verdict: 'passed' as const,
          reason: null,
        })),
      }));
    let tab = testRunView({
      id: TEST_RUN_ID,
      agentId: AGENT_ID,
      rounds: [version(1, false)],
      tests: tests(1),
    });
    const activations: unknown[] = [];
    // A replay of version 1 while the library row is at version 3: the nested card offers no paid re-run.
    const replay = agentNode({
      agentId: fixtureId(120),
      status: 'completed',
      origin: { ...deepAgentOrigin(), recordId: AGENT_ID, name: AGENT_NAME },
    });
    server.use(
      ...serveConversation(() => ({
        ...testRunConversation(
          testRunSummary({
            phase: 'result',
            status: 'done',
            agent: createdAgent,
            plans: [confirmedPlan],
            rounds: [firstRound(3)],
          }),
          confirmedEntries,
        ),
        agents: [replay],
      })),
      http.get(`${API}/api/test-runs/${TEST_RUN_ID}`, () =>
        HttpResponse.json(tab),
      ),
      http.get(`${API}/api/library`, () =>
        HttpResponse.json([
          recordSummary({
            id: AGENT_ID,
            kind: 'deep_agent',
            name: AGENT_NAME,
            version: 3,
          }),
        ]),
      ),
      http.post(
        `${API}/api/test-runs/${TEST_RUN_ID}/activate`,
        async ({ request }) => {
          activations.push(await request.json());
          tab = {
            ...tab,
            activatedAt: fixtureTime(60),
            activeVersion: 3,
            rounds: tab.rounds.map((round) => ({
              ...round,
              canActivate: false,
            })),
          };
          return HttpResponse.json({
            version: 3,
            activatedAt: fixtureTime(60),
          } satisfies TrainingActivated);
        },
      ),
    );
    const user = userEvent.setup();
    const openTab = async () => {
      const view = renderWithRuntime({ pathname: `/chat/${TEST_RUN_ID}` });
      const card = await runCard(new RegExp(`^Проверка «${AGENT_NAME}»`));
      expect(
        screen.queryByRole('complementary', { name: 'Ход и итог' }),
      ).toBeNull();
      await user.click(
        within(card).getByRole('button', { name: 'Ход и итог' }),
      );
      const panel = await screen.findByRole('complementary', {
        name: 'Ход и итог',
      });
      expect(
        within(panel).getByRole('tab', { name: 'Проверка' }),
      ).toBeInTheDocument();
      await within(panel).findByRole('heading', { name: 'Тесты' });
      return { view, panel };
    };

    // One round: no activation, «Удалить агента»
    const one = await openTab();
    expect(
      within(one.panel).queryByRole('button', { name: /^Сделать активной/ }),
    ).toBeNull();
    expect(
      await within(one.panel).findByRole('button', { name: 'Удалить агента' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Запустить заново' }),
    ).toBeNull();
    one.view.unmount();

    // Three rounds: each test has three round lines, two fixes to compare and to activate; «Исправление 2» activates version 3
    tab = testRunView({
      id: TEST_RUN_ID,
      agentId: AGENT_ID,
      rounds: [version(1, false), version(2, true), version(3, true)],
      tests: tests(3),
    });
    const three = await openTab();
    const testList = within(three.panel)
      .getAllByRole('list', { name: 'Тесты' })
      .find((list) => list.tagName === 'OL');
    if (testList === undefined) throw new Error('no list of tests');
    const testItems = within(testList).getAllByRole('listitem');
    expect(testItems).toHaveLength(2);
    for (const item of testItems)
      for (const round of ['Первая версия', 'Исправление 1', 'Исправление 2'])
        expect(item).toHaveTextContent(round);
    expect(
      within(three.panel).getByRole('heading', {
        name: 'Что меняет исправление 1',
      }),
    ).toBeInTheDocument();
    expect(
      within(three.panel).getByRole('heading', {
        name: 'Что меняет исправление 2',
      }),
    ).toBeInTheDocument();
    const activate = within(three.panel).getAllByRole('button', {
      name: /^Сделать активной: Исправление /,
    });
    expect(activate).toHaveLength(2);
    await user.click(activate[1]);
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Сделать «Исправление 2» активной версией?',
    });
    await user.click(
      within(dialog).getByRole('button', { name: 'Сделать активной' }),
    );
    await vi.waitFor(() => expect(activations).toEqual([{ version: 3 }]));
    expect(
      await within(three.panel).findByText(/^Активна с /),
    ).toBeInTheDocument();
    three.view.unmount();

    // A deleted agent: «Агент удалён.», no runs to open
    tab = testRunView({
      id: TEST_RUN_ID,
      agentId: AGENT_ID,
      rounds: [version(1, false)],
      tests: tests(1),
      canDelete: false,
      agent: {
        id: AGENT_ID,
        name: AGENT_NAME,
        description: 'Разбирает ошибки заказов',
        deleted: true,
        content: deepAgentContent(),
      },
    });
    const deleted = await openTab();
    expect(
      within(deleted.panel).getByText('Агент удалён.'),
    ).toBeInTheDocument();
    expect(
      within(deleted.panel).queryByRole('link', { name: /^Запуск теста / }),
    ).toBeNull();
  });

  // UC-7: AC-10.3. Catches: «Схема» or «Задачи» in a training's conversation; an activation past the training's route.
  it('UC-7: «Ход и итог» opens the tab «Обучение» with the changes, the comparison, the spend and the recommendation; activation calls the route', async () => {
    const thread = threadSummary({
      id: TRAINING_ID,
      title: `Обучение «${AGENT_NAME}»`,
      forkable: false,
    });
    const texts = (prompt: string) => ({ prompt, subagents: [], scripts: [] });
    const activations: string[] = [];
    server.use(
      ...serveConversation(() =>
        conversationView({
          thread,
          chat: {
            status: 'idle',
            failureReason: null,
            rootAgentId: TRAINING_ID,
            model: 'anthropic/claude-haiku-4-5',
          },
          training: {
            agentId: AGENT_ID,
            trainingId: TRAINING_ID,
            isRoot: true,
            testRun: false,
            run: null,
          },
        }),
      ),
      http.get(`${API}/api/library/${AGENT_ID}/training/${TRAINING_ID}`, () =>
        HttpResponse.json({
          agent: { id: AGENT_ID, name: AGENT_NAME },
          startedBy: 'Аня Смирнова',
          startedAt: fixtureTime(0),
          baseVersion: 1,
          status: 'done',
          failureReason: null,
          cappedAt: null,
          spentUsd: 0.42,
          capUsd: 2,
          pool: [],
          proposal: {
            version: 2,
            base: texts('Старая инструкция'),
            proposed: texts('Новая инструкция'),
            changes: 'Добавил проверку дат',
            explanation: null,
          },
          comparisons: [
            {
              task: 'Ошибки за вчера',
              verdict: 'proposed_better',
              reason: 'Нашёл больше',
              base: null,
              proposed: null,
            },
          ],
          totals: {
            base: { errors: 1, toolCalls: 3, costUsd: 0.01 },
            proposed: { errors: 0, toolCalls: 2, costUsd: 0.01 },
          },
          recommended: true,
          activatedAt: null,
          activeVersion: 1,
          canActivate: true,
        } satisfies TrainingView),
      ),
      http.post(
        `${API}/api/library/${AGENT_ID}/training/${TRAINING_ID}/activate`,
        () => {
          activations.push(TRAINING_ID);
          return HttpResponse.json({
            version: 2,
            activatedAt: fixtureTime(60),
          } satisfies TrainingActivated);
        },
      ),
    );
    const user = userEvent.setup();
    renderWithRuntime({ pathname: `/chat/${TRAINING_ID}` });

    await user.click(await screen.findByRole('button', { name: 'Ход и итог' }));
    const panel = await screen.findByRole('complementary', {
      name: 'Ход и итог',
    });
    expect(
      within(panel).getByRole('tab', { name: 'Обучение' }),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole('tab', { name: /Схема/ })).toBeNull();
    expect(within(panel).queryByRole('tab', { name: /Задачи/ })).toBeNull();
    expect(
      await within(panel).findByRole('heading', {
        name: 'Что меняет версия 2',
      }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole('heading', {
        name: 'Сравнение на прошлых задачах',
      }),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent('потрачено 0,42 $ из 2,00 $');
    expect(panel).toHaveTextContent(
      'Рекомендована: лучше в 1 задаче, хуже в 0, равны в 0.',
    );

    await user.click(
      within(panel).getByRole('button', { name: 'Сделать активной' }),
    );
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Сделать версию 2 активной?',
    });
    await user.click(
      within(dialog).getByRole('button', { name: 'Сделать активной' }),
    );
    await vi.waitFor(() => expect(activations).toEqual([TRAINING_ID]));
  });
});
