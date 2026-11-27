// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.9)
// File: shell.workspace.int.test.tsx — Test Strategy, "Integration Tests (I)" (replaced workspace-panel.test.tsx in v1.2, N003)
// Generated: 2026-10-30 | Budget Used: 10 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 tests in 7 files, all implemented — no it.todo left (plan «Решение по бюджету интеграционных тестов»).
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime)
//
// Harness (src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   options.media: { '(min-width: 1024px)': true, '(min-width: 768px)': true } drives the matchMedia polyfill (src/test/setup.ts).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'.
//   Page address in tests: jsdom url 'http://api.test' (vitest.config.ts); relative `/api/...` requests resolve against it.
// Mock boundary: network only (MSW, empty list) + next/navigation. ChatShell, WorkspacePanel, ChatHeader,
//   react-resizable-panels — real. Panel widths (40 %, 360 px / 480 px limits) are NOT asserted here (jsdom has no layout) → L1-1.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentNode,
  conversationView,
  fixtureId,
  historyEntry,
  threadList,
  threadSummary,
} from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';
// deep-agents DA-12, MC-25: the workspace is the panel «Схема»; with no record in focus it shows its empty state.
const PLACEHOLDER = 'Здесь появится схема';

describe('Shell: workspace panel (FR-11, AC-11.1 / AC-11.3)', () => {
  // AC-11.3: "When нажата та же кнопка или «×», the system shall скрыть панель, фокус — на кнопку в шапке."
  // AC-11.1 (merged into this test as the after-load assertion, before the first click):
  //   "When загружается / или /chat/<id> на десктопе, the system shall не показывать рабочую область."
  // EARS: When (event: close). Both closers hide the same panel and land focus on the same button, so they are table rows of ONE test.
  //   AC-11.1: When (event: page load at ≥ 1024 px) — the same ChatShell render, asserted before the panel is opened.
  // ROI: 3.5 | Business Value: 6 | Frequency: 5 | Legal: false | Defect Detection: 8 (focus is lost when the focused «×» unmounts)
  // ROI (AC-11.1): 6.0 | Business Value: 6 (chat gets full width by default) | Frequency: 10 | Legal: false | Defect Detection: 6
  // Behavior: render at '/', desktop media → button «Схема» aria-expanded="false", no complementary «Схема» (AC-11.1)
  //   → click HD-04 → panel visible, aria-expanded="true" → close by the row's closer → panel gone, aria-expanded="false", focus on HD-04
  // Primary failure mode: closing via «×» leaves focus on <body> (the focused element unmounted), the HD-04 toggle only opens,
  //   or focus jumps into the panel/body on close; AC-11.1: the panel is open by default (the pre-feature layout kept a permanent 60 % panel)
  // @category: ux
  // @dependency: ChatShell (workspaceOpen state), ChatHeader (HD-04), WorkspacePanel (WS-03), MSW
  // @complexity: medium
  // Table rows (implement with it.each):
  //   | closer                                   | focus before close | focus after close            |
  //   | button "Закрыть схему" (WS-03) | on «×» (in panel)  | button "Схема" (HD-04) |
  //   | button "Схема" (HD-04)         | on HD-04           | button "Схема" (HD-04) |
  it.each([{ closer: 'Закрыть схему' }, { closer: 'Схема' }])(
    'AC-11.3 + AC-11.1: the workspace is hidden on load; closing it by "$closer" hides it and leaves focus on the header button',
    async ({ closer }) => {
      // Arrange
      server.use(
        http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
      );
      const user = userEvent.setup();
      renderWithRuntime({
        pathname: '/',
        media: { '(min-width: 1024px)': true, '(min-width: 768px)': true },
      });

      // Act 1: load
      await screen.findByText('Пока нет бесед');

      // Assert 1 (AC-11.1): hidden by default, HD-04 not pressed
      const toggle = screen.getByRole('button', { name: 'Схема' });
      expect(screen.queryByRole('complementary', { name: 'Схема' })).toBeNull();
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      // Act 2: open
      await user.click(toggle);
      const panel = screen.getByRole('complementary', { name: 'Схема' });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(panel).toHaveTextContent(PLACEHOLDER);

      // Act 3: close by the row's closer
      await user.click(screen.getByRole('button', { name: closer }));

      // Assert 2 (AC-11.3)
      expect(screen.queryByRole('complementary', { name: 'Схема' })).toBeNull();
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveFocus();
    },
  );
});

describe('Shell: side chat (improvements FR-09, AC-09.1 / AC-09.3)', () => {
  const SOURCE = fixtureId(81);
  const BRANCH = fixtureId(82);
  const DESKTOP = { '(min-width: 1024px)': true, '(min-width: 768px)': true };

  afterEach(() => {
    toast.dismiss();
  });

  // improvements UC-4 (a): AC-09.1, AC-09.3, FR-09 (design-web.md KD-1, KD-3, Flow 1; UXRD IM-05, IM-06). Catches: the
  //   branch opening in place of the main conversation, a wrong boundary, the button while an agent works, a tab after
  //   a refusal, a quote not cut at a word boundary.
  it('UC-4: «Спросить в стороне» forks through the answer and opens the branch on «В стороне» beside the conversation', async () => {
    // 40 five-letter words: 239 characters, cut to the 33 words that fit in 200 with «…».
    const answer = Array<string>(40).fill('слово').join(' ');
    const quote = `> ${Array<string>(33).fill('слово').join(' ')}…

`;
    const thread = threadSummary({ id: SOURCE, title: 'Разбор инцидента' });
    const entries = [
      historyEntry({
        kind: 'task',
        seq: 1,
        content: { text: 'Что упало ночью?' },
      }),
      historyEntry({ kind: 'model_answer', seq: 2, content: { text: answer } }),
    ];
    let busy = true;
    let forkAnswer: 'refused' | 'created' = 'refused';
    const forkBodies: unknown[] = [];
    server.use(
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(threadList([thread])),
      ),
      http.get(`${API}/api/threads/${SOURCE}`, () => HttpResponse.json(thread)),
      http.get(`${API}/api/threads/${SOURCE}/history`, () =>
        HttpResponse.json(
          conversationView({
            thread,
            entries,
            // A subagent still works: the server would refuse the fork (KD-3).
            agents: busy
              ? [agentNode({ agentId: 'a1', status: 'working' })]
              : [],
          }),
        ),
      ),
      http.get(`${API}/api/threads/${BRANCH}/history`, () =>
        HttpResponse.json(
          conversationView({
            thread: threadSummary({ id: BRANCH, title: 'Ветка · Разбор' }),
            entries,
          }),
        ),
      ),
      http.post(`${API}/api/threads/${SOURCE}/fork`, async ({ request }) => {
        forkBodies.push(await request.json());
        return forkAnswer === 'refused'
          ? HttpResponse.json(
              {
                statusCode: 409,
                message: 'The conversation cannot be forked now',
                errorCode: 'FORK_REFUSED',
                reason: 'answering',
              },
              { status: 409 },
            )
          : HttpResponse.json(
              threadSummary({ id: BRANCH, title: 'Ветка · Разбор' }),
              { status: 201 },
            );
      }),
    );
    const user = userEvent.setup();
    const view = renderWithRuntime({
      pathname: `/chat/${SOURCE}`,
      media: DESKTOP,
    });
    await screen.findByText('Что упало ночью?');
    expect(
      screen.queryByRole('button', { name: 'Спросить в стороне' }),
    ).toBeNull();

    // The subagent finished: the re-read shows the button at the answer
    busy = false;
    await waitFor(() =>
      expect(view.live.current()?.url).toBe(
        `${API}/api/events?watch=thread%3A${SOURCE}`,
      ),
    );
    view.live.emit('ready', {});
    const ask = await screen.findByRole('button', {
      name: 'Спросить в стороне',
    });

    // Refused: the notice, no tab
    await user.click(ask);
    expect(
      await screen.findByText('Ветку сейчас не сделать: агент ещё отвечает.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'В стороне' })).toBeNull();

    // Created: the tab shows the branch with the quote in its own field; the conversation stays
    forkAnswer = 'created';
    await user.click(
      await screen.findByRole('button', { name: 'Спросить в стороне' }),
    );
    const tab = await screen.findByRole('tab', { name: 'В стороне' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel', { name: 'В стороне' });
    expect(
      await within(panel).findByRole('link', { name: 'Ветка · Разбор' }),
    ).toHaveAttribute('href', `/chat/${BRANCH}`);
    expect(await within(panel).findByText('Что упало ночью?')).toBeVisible();
    const field = within(panel).getByRole('textbox', { name: 'Сообщение' });
    await waitFor(() => expect(field).toHaveValue(quote));
    await waitFor(() => expect(field).toHaveFocus());
    expect(forkBodies).toEqual([{ throughSeq: 2 }, { throughSeq: 2 }]);
    expect(view.router.push).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Спросить в стороне' }),
    ).toBeInTheDocument();
  });

  // improvements UC-4 (b): AC-09.2 (design-web.md KD-7, Flow 1; UXRD IM-06, IM-07, MC-7). Catches: the text sent into
  //   the branch instead of the main conversation, sent with a chip, or put into the main field; the panel still named
  //   «Схема» on «В стороне». The popover over a selection is left to the browser check: jsdom has no selection layout.
  it('UC-4: «В основной чат» of an answer on «В стороне» sends its text as the main conversation’s next message', async () => {
    const answer = 'Упал сборщик логов в 03:12.';
    const thread = threadSummary({ id: SOURCE, title: 'Разбор инцидента' });
    const entries = [
      historyEntry({
        kind: 'task',
        seq: 1,
        content: { text: 'Что упало ночью?' },
      }),
      historyEntry({ kind: 'model_answer', seq: 2, content: { text: answer } }),
    ];
    const sent: { threadId: unknown; body: unknown }[] = [];
    server.use(
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(threadList([thread])),
      ),
      http.get(`${API}/api/threads/${SOURCE}`, () => HttpResponse.json(thread)),
      http.get(`${API}/api/threads/${SOURCE}/history`, () =>
        HttpResponse.json(conversationView({ thread, entries })),
      ),
      http.get(`${API}/api/threads/${BRANCH}/history`, () =>
        HttpResponse.json(
          conversationView({
            thread: threadSummary({ id: BRANCH, title: 'Ветка · Разбор' }),
            entries,
          }),
        ),
      ),
      http.post(`${API}/api/threads/${SOURCE}/fork`, () =>
        HttpResponse.json(
          threadSummary({ id: BRANCH, title: 'Ветка · Разбор' }),
          { status: 201 },
        ),
      ),
      http.post(
        `${API}/api/threads/:id/messages`,
        async ({ params, request }) => {
          sent.push({ threadId: params['id'], body: await request.json() });
          return HttpResponse.json({ messageId: 'm-3' }, { status: 202 });
        },
      ),
    );
    const user = userEvent.setup();
    renderWithRuntime({ pathname: `/chat/${SOURCE}`, media: DESKTOP });
    await user.click(
      await screen.findByRole('button', { name: 'Спросить в стороне' }),
    );
    const panel = await screen.findByRole('tabpanel', { name: 'В стороне' });
    expect(
      screen.getByRole('complementary', { name: 'В стороне' }),
    ).toBeInTheDocument();
    // Only the branch's answer has it; the main feed's answer has «Спросить в стороне» instead.
    const toMain = await within(panel).findByRole('button', {
      name: 'В основной чат',
    });
    expect(screen.getAllByRole('button', { name: 'В основной чат' })).toEqual([
      toMain,
    ]);

    await user.click(toMain);

    expect(
      await within(panel).findByRole('button', { name: 'Отправлено' }),
    ).toBeInTheDocument();
    expect(sent).toEqual([{ threadId: SOURCE, body: { text: answer } }]);
    const mainField = screen
      .getAllByRole('textbox', { name: 'Сообщение' })
      .find((field) => !panel.contains(field));
    expect(mainField).toHaveValue('');
  });
});
