// custom-agents / web - integration tests (Vitest + RTL + MSW 2, jsdom)
// Design Doc: docs/features/custom-agents/design-web.md, Test Strategy UC-1..UC-11, UC-E1..UC-E6;
//   PRD: docs/features/custom-agents/prd.md FR-20..FR-29 (AC-20.1 .. AC-29.1); UXRD: docs/features/custom-agents/uxrd.md.
// Budget Used: 4/3 integration tests for the part (INT-1, INT-2, INT-3, INT-5), all in this file - the default 3 plus 1 extra, each
//   naming the defect no other test catches (see "Catches"). The four are four different surfaces with four different data sources (the
//   record page, the editor form, the feed's run labels, the audience dialog with the panel section); merging them would put unrelated
//   failures into one test. INT-4 (the draft card) went with the record drafts (deep-agents design-agent-types.md, KD-3).
//   0/2 E2E: the repo has no browser tool (no Playwright, no `e2e` directory), so
//   the design's «L1-сценарии в браузере» table stays the manual real-browser acceptance, exactly as in agent-platform-web and
//   enterprise-access-admin. The two spikes of that table (the browser «Назад» guard, the chip in a new conversation) are L1 only:
//   jsdom has no real history stack.
// Test Type: Integration. Each `it` is a long scenario of rows; `resetRow()` separates the rows (toasts dismissed, handlers reset).
//
// Harness (src/test/, same as agent-platform-web.int.test.tsx and enterprise-access-admin.int.test.tsx):
//   `renderWithRuntime({ pathname })` mounts ChatRuntimeProvider + ChatShell + Toaster inside a RouterContext.Provider (a `next/link`
//   click reaches the router spy) with mocked next/navigation (controlled pathname, router spy). setup.ts dismisses the toasts after each
//   test. MSW server from '@/test/msw-server' (`onUnhandledRequest: 'error'`: a request a screen must NOT send fails the test);
//   `trackRequests`, `logRecords`, `loggerModule` from '@/test/admin-support'; the fixtures of '@/test/fixtures' (`recordSummary`,
//   `recordDetail`, `agentContent`, `copyResult`, `deepAgentRunView`, `agentNode`, `conversationView`, ...),
//   built to pass the schemas of `packages/contracts`; `createTestLiveSource()` for the `/api/events` frames.
// Mock boundary: network (MSW), next/navigation, the event source of LiveStore, the clipboard, and `@/lib/logger` (the Sentry/console
//   boundary). Real: shell route parsing, `libraryIndex`, `composerSeed`, `createdHandoff`, `leaveGuard` and the other shell stores,
//   `libraryApi`, `adminApi.library`, `apiRequest` with its handlers, `useResource`, `toFeed`, `useFeedRuntime`, `RecordEditor`,
//   `useRecordForm`, `ShareDialog`, the cards, toast and announcer. Do NOT mock any of them.
//
// Server-side proofs are NOT repeated here: that an invisible record answers like a missing one, who may change what, the version check on
//   the server, the copy's dropped tools and replaced model, `START_REFUSED` and the run limit are proven by the API tests of `library`
//   and `agents` (apps/api/test/custom-agents-library.int.e2e-spec.ts, apps/api/test/custom-agents-runtime.int.e2e-spec.ts,
//   packages/agents/test/custom-agents-runtime.int.e2e-spec.ts). Every
//   server answer below is a scripted MSW response; the test proves what the browser shows, sends and keeps for it. The panel's
//   administrator gate is proven by enterprise-access-admin.int.test.tsx (INT-1).
//
// Proven by unit tests (NOT repeated here):
//   - `parseShellRoute` table (lib/shell-route.test.ts): `/library`, `/library/<id>`, `/library/new/agent` before the id, the
//     panel's `/admin/library`, `/shared`, `/bans`, `new/...`, `<id>`; a tab is an address (DC-6, AC-24.1 half "the tab survives a
//     reload and «Назад»").
//   - `describeLibraryError` table (lib/library/library-errors.test.ts): every row of «Ошибки и их место» -> place and text; unknown code ->
//     «Не удалось сохранить: {причина}».
//   - the web rules table (lib/library/record-rules.test.ts): «Использовать в чате» (AC-26.2, `missingRights` with a null subagent and a
//     model), «изменён после запуска», «пояснение получателю», the one function comparing two agent definitions into field labels (MC-7).
//   - `useRecordForm` reducer (components/library/use-record-form.test.ts): Чисто / Изменено / Сохраняем / Сохранено / Конфликт, «есть
//     изменения» as a comparison, «Отменить изменения», «Взять сохранённое» and «Вернуть» (invariants 1 and 2).
//   - `leaveGuard` store (lib/leave-guard.test.ts): `hold` / `release` / `confirmLeave`, nothing held -> no question.
//   - `composerSeed` store (lib/threads/composer-seed.test.ts): one chip per conversation, the text is taken once.
//
// `not automated`: the browser «Назад» guard and the beforeunload question (KD-4, the spike), the chip in a new conversation across a real
//   navigation, 360 px width, touch targets, theme and contrast, focus order and announcements across screens (NFR-05) - the L1 table.
//   Logging fields (Логирование) are asserted only where a row below shows an error being handled.
//
// AC proof map (one proof per AC; the DC rows of the design are listed beside):
//   AC-20.1 INT-1 | AC-20.2 INT-1 | AC-21.1 INT-2 | AC-21.2 INT-2 | AC-23.1 INT-1 | AC-23.2 INT-5 | AC-24.1 INT-5 (list, columns, close access) +
//   unit (the tab as an address) | AC-25.1 INT-3 | AC-25.2 INT-1 (library) + INT-3 (card) | AC-26.2 INT-1 + unit (the rule) | AC-27.1 INT-3 |
//   AC-27.2 INT-3 | AC-27.3 INT-3 | AC-28.1 INT-3 (card and agent page) | AC-29.1 INT-1 + INT-3 | DC-1 INT-1 | DC-2 INT-2 | DC-3 INT-2 |
//   DC-5 INT-1 | DC-6 unit | DC-7 INT-3 | DC-11 INT-3. The workflow form (AC-22.x, DC-4) and the record drafts (AC-26.1, DC-8–DC-10, DC-12)
//   were removed by deep-agents (design-agent-types.md, KD-1, KD-3).

import type {
  AgentNode,
  BannedRecord,
  ConversationView,
  CurrentUser,
  LibraryChoices,
  LibrarySettings,
  MyRoleList,
  RecordDetail,
  RecordSummary,
  RunOrigin,
} from '@agent-os/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { logRecords, trackRequests, type RecordedRequest } from '@/test/admin-support';
import {
  agentContent,
  agentListPage,
  agentNode,
  agentPageView,
  confirmation,
  conversationView,
  copyResult,
  currentUser,
  deepAgentRunView,
  fixtureId,
  fixtureTime,
  historyEntry,
  mcpServerSummary,
  recordDetail,
  recordSummary,
  threadList,
  threadSummary,
} from '@/test/fixtures';
import { createTestLiveSource } from '@/test/live-source';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

vi.mock('@/lib/logger', async () => (await import('@/test/admin-support')).loggerModule);

const API = 'http://api.test';

/** Борис, the viewer; the fixtures' default employee (`fixtureId(1)`) is Аня, the author of the shared records. */
const BORIS = currentUser({ id: fixtureId(2), email: 'boris@corp.example', name: 'Борис Петров' });
const ANYA = { id: fixtureId(1), name: 'Аня Смирнова', disabled: false };
const SRE = { id: fixtureId(100), name: 'SRE' };
const HAIKU = 'anthropic/claude-haiku-4-5';
const SONNET = 'anthropic/claude-sonnet-4-5';
/** «Максимум шагов» of a new record as the administrator set it; not the platform's 40. */
const NEW_MAX_TURNS = 25;

/** The one body of every invisible record: the server answers it like a missing one (ADR-0016). */
const RECORD_NOT_FOUND = { statusCode: 404, message: 'Record not found', errorCode: 'RECORD_NOT_FOUND' };

type LibraryAnswers = {
  viewer?: CurrentUser;
  roles?: MyRoleList;
  list?: RecordSummary[];
  /** What `GET /api/library/:id` returns; any other id gets RECORD_NOT_FOUND. */
  records?: RecordDetail[];
};

/** The library as the server answers the viewer: who they are, their roles, the list, the records, the editor's choices. */
function serveLibrary({ viewer = BORIS, roles = [], list = [], records = [] }: LibraryAnswers): void {
  server.use(
    http.get(`${API}/api/auth/me`, () => HttpResponse.json(viewer)),
    http.get(`${API}/api/auth/me/roles`, () => HttpResponse.json(roles)),
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
    http.get(`${API}/api/library`, () => HttpResponse.json(list)),
    http.get(`${API}/api/library/choices`, () =>
      HttpResponse.json({ servers: ['logs'], defaultModel: HAIKU, defaultMaxTurns: NEW_MAX_TURNS } satisfies LibraryChoices),
    ),
    http.get(`${API}/api/library/:id`, ({ params }) => {
      const record = records.find((candidate) => candidate.id === params['id']);
      return record === undefined ? HttpResponse.json(RECORD_NOT_FOUND, { status: 404 }) : HttpResponse.json(record);
    }),
  );
}

/** «METHOD path» of the library requests (and the viewer's roles, read by the share dialog) since request number `from`. */
const libraryRequestsSince = (requests: readonly RecordedRequest[], from: number): string[] =>
  requests
    .slice(from)
    .filter((request) => request.path.startsWith('/api/library') || request.path === '/api/auth/me/roles')
    .map((request) => `${request.method} ${request.path}`);

/** Row boundary inside a long scenario: the toasts and the handlers the row stacked do not reach the next row. */
function resetRow(): void {
  toast.dismiss();
  server.resetHandlers();
}

/** Invariant 5: the panel's words for a record's audience never reach an employee's screen. */
function expectNoPanelWords(): void {
  expect(document.body.textContent).not.toMatch(/встроенн|личн/i);
}

describe('custom-agents / web - integration (jsdom + MSW)', () => {
  // INT-1 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-20.1 "Given в агенте Ани есть Jira, а у Бориса права на Jira нет, when Борис открывает агента в библиотеке, then Jira помечен как
  //   недоступный ему"; AC-20.2 "Given Борис копирует запись, then он видит список выпавших инструментов (AC-05.1) и заменённую модель
  //   (AC-05.3, AC-05.4)"; AC-23.1 "Given Борис видит ролевую запись Ани, then кнопки «Поделиться» у него нет"; AC-25.2 "Given системный агент
  //   `general-purpose`, when сотрудник видит его в библиотеке или на карточке, then пометка простыми словами говорит, что агента дала компания,
  //   а что агент встроенный, сотрудник не видит нигде"; AC-26.2 "…выключила «предлагать в главном чате», when Борис открывает агента в
  //   библиотеке, then кнопки «Использовать в чате» у него нет"; AC-29.1 (the page half: the explanation to the recipient). Design: UC-1,
  //   UC-2, UC-E1, UC-E3, DC-1, DC-5, invariant 3 and 5.
  // Behavior: the employee opens `/library`, a colleague's page or a missing address -> `libraryIndex` and `GET /api/library/:id` answer ->
  //   the row, the menu and the page show exactly the actions the flags and the viewer's rights allow, and an invisible record is one screen.
  // Rows (Борис is the viewer; responses are `recordSummary` / `recordDetail` fixtures):
  //   1. Given Аня's agent shared to «SRE» with `offerInChat: false` and Jira that Борис has no right to, and `general-purpose` from the company;
  //      When Борис opens `/library` and then `/library/<id>` of Аня's agent; Then the row carries the note about Jira, the row menu and the page
  //      have neither «Использовать в чате» nor «Поделиться» (the buttons are absent, not disabled), the page shows the recipient's
  //      explanation (who shared it and with which role, rights and accounts are Борис's, changes only after confirmation, who may remove it)
  //      with no field to answer; `general-purpose` is labelled «от компании» and the word «встроенная» occurs nowhere on the screen.
  //   2. Given Аня's agent with Jira and a model Борис has no access to; When he chooses «Скопировать себе» and confirms the dialog (the
  //      dialog names Jira); Then `POST …/copy` is sent once, the toast names the dropped tool and both models (the replaced and the
  //      replacement), and its «Открыть» leads to the copy's page.
  //   3. `GET /api/library/:id` answers 404 for each of: a deleted one (the list still holds its row) and a missing one (two calls, one
  //      body); Then every address shows the same RV-02 screen with «В библиотеку», focus on the `h1`, and nothing of the record's name.
  //   4. Given Борис owns a record but has no roles (and, in a second pass, the record carries `ban`); When he opens its page; Then the audience
  //      button is disabled with the reason of MC-14 and clicking it opens no dialog and sends no request.
  // Catches: an action button drawn for a viewer the flags forbid (the web trusting nothing but the server, then showing a button whose use is
  //   always refused); the word «встроенная» or «личная» leaking outside the panel; the recipient asked a question instead of told; a
  //   copy that hides the dropped tools or the replaced model from the one who must know; two different screens for a deleted and a
  //   missing record, which would let a viewer tell «exists» from «does not exist» (ADR-0016).
  // @category: core-functionality
  // @dependency: parseShellRoute, MainView, libraryIndex, libraryApi, LibraryScreen, LibraryRow, RecordPage, DefinitionView, RecordLabel, ShareDialog (disabled state), ThreadNotice (RV-02), MSW, next/navigation mock
  // @complexity: high
  it('INT-1: a colleague\'s record shows only the actions its flags allow with the recipient\'s explanation, a copy tells what was dropped, and every 404 is one screen', async () => {
    const user = userEvent.setup();
    const tracked = trackRequests(server);

    // Arrange (rows 1-2): Аня's agent open to «SRE», not offered in Борис's chat, with Jira and a model he has no right to;
    //   `general-purpose` from the company
    const sharedFields = {
      id: fixtureId(11),
      name: 'Разбор инцидентов',
      mine: false,
      author: ANYA,
      audience: { roles: [{ ...SRE, member: true }] },
      offerInChat: false,
      missingRights: [{ subagent: null, servers: ['jira'], model: SONNET }],
      canEdit: false,
      canShare: false,
      canDelete: false,
    } satisfies Partial<RecordSummary> & Pick<RecordSummary, 'id'>;
    const shared = recordDetail({ ...sharedFields, content: agentContent({ servers: ['logs', 'jira'], model: SONNET }) });
    const company = recordSummary({
      id: fixtureId(12),
      name: 'general-purpose',
      builtinKey: 'general-purpose',
      mine: false,
      author: null,
      offerInChat: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
    });
    serveLibrary({ roles: [SRE], list: [recordSummary(sharedFields), company], records: [shared] });
    const copyId = fixtureId(201);
    server.use(
      http.post(`${API}/api/library/:id/copy`, () =>
        HttpResponse.json(
          copyResult({
            record: recordDetail({ id: copyId, name: 'Разбор инцидентов', author: { id: BORIS.id, name: BORIS.name, disabled: false } }),
            removedServers: [{ subagent: null, servers: ['jira'] }],
            replacedModels: [{ subagent: null, from: SONNET, to: HAIKU }],
          }),
        ),
      ),
    );
    const view = renderWithRuntime({ pathname: '/library' });

    // Assert (row 1, library): the row notes Jira; its menu has neither «Использовать в чате» nor «Поделиться»; the company's agent
    //   reads «от компании»
    const colleagues = await screen.findByRole('region', { name: 'От коллег · 1' });
    expect(within(colleagues).getByText('jira у вас недоступна — агент будет работать без неё')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'От компании · 1' })).getByText('от компании')).toBeInTheDocument();
    await user.click(within(colleagues).getByRole('button', { name: 'Действия: Разбор инцидентов' }));
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Открыть', 'Скопировать себе']);
    expectNoPanelWords();

    // Act (row 1): «Открыть»
    await user.click(screen.getByRole('menuitem', { name: 'Открыть' }));
    expect(view.router.push).toHaveBeenCalledWith(`/library/${shared.id}`);
    view.setPathname(`/library/${shared.id}`);

    // Assert (row 1, page): no «Использовать в чате» and no audience button (absent, not disabled); the recipient is told, not asked
    expect(await screen.findByRole('heading', { level: 1, name: 'Разбор инцидентов' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скопировать себе' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Использовать в чате' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Поделиться|Кто видит)/ })).toBeNull();
    const note = screen.getByRole('note');
    for (const part of [
      'Автор — Аня Смирнова.',
      'открыт вашей роли SRE.',
      'Работает с вашими правами и подключёнными аккаунтами.',
      'Изменения в системах — только после вашего подтверждения.',
      'может автор или администратор.',
    ]) {
      expect(note).toHaveTextContent(part);
    }
    expect(screen.queryByRole('textbox')).toBeNull();
    expectNoPanelWords();

    // Act (row 2): «Скопировать себе» opens the dialog naming Jira; nothing is sent before «Скопировать»
    const beforeCopy = tracked.requests.length;
    await user.click(screen.getByRole('button', { name: 'Скопировать себе' }));
    const dialog = await screen.findByRole('dialog', { name: 'Скопировать «Разбор инцидентов» себе?' });
    expect(dialog).toHaveTextContent('Не войдут системы, к которым у вас нет доступа: jira');
    expect(libraryRequestsSince(tracked.requests, beforeCopy)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Скопировать' }));

    // Assert (row 2): one POST; the toast names the dropped tool and both models; its «Открыть» leads to the copy's page
    expect(await screen.findByText('Копия «Разбор инцидентов» сохранена', { selector: '[data-title]' })).toBeInTheDocument();
    expect(
      screen.getByText('Не вошли системы, к которым у вас нет доступа: jira. Модель Sonnet вам недоступна — стоит Haiku.'),
    ).toBeInTheDocument();
    expect(libraryRequestsSince(tracked.requests, beforeCopy).filter((request) => request.startsWith('POST'))).toEqual([
      `POST /api/library/${shared.id}/copy`,
    ]);
    await user.click(screen.getByRole('button', { name: 'Открыть' }));
    expect(view.router.push).toHaveBeenLastCalledWith(`/library/${copyId}`);
    view.unmount();

    // Arrange (row 3): a deleted record (the list still holds it, read a moment before the deletion) and a missing one; every
    //   `GET /api/library/:id` answers the same 404
    resetRow();
    const hidden = [fixtureId(33), fixtureId(34)];
    const deletedRow = recordSummary({ id: hidden[0] ?? '', name: 'Отчёт о релизах', mine: false, author: ANYA });
    serveLibrary({ roles: [SRE], list: [deletedRow] });
    const beforeHidden = tracked.requests.length;
    const hiddenView = renderWithRuntime({ pathname: `/library/${hidden[0] ?? ''}` });

    // Assert (row 3): every address shows the same RV-02 screen, focus on its `h1`, nothing of the record
    const screens: string[] = [];
    for (const [index, id] of hidden.entries()) {
      if (index > 0) hiddenView.setPathname(`/library/${id}`);
      const heading = await screen.findByRole('heading', { level: 1, name: 'Не найдено' });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(screen.getByRole('link', { name: 'В библиотеку' })).toHaveAttribute('href', '/library');
      expect(document.title).toBe('Не найдено — Agent OS');
      expect(document.body.textContent).not.toContain('Отчёт о релизах');
      screens.push(heading.closest('section')?.textContent ?? '');
    }
    expect(screens).toEqual(
      hidden.map(() => 'Не найденоТакого агента или глубокого агента нет: его удалили, закрыли для вас или ссылка неверна.В библиотеку'),
    );
    expect(
      libraryRequestsSince(tracked.requests, beforeHidden).filter((request) => request.startsWith('GET /api/library/')),
    ).toEqual(hidden.map((id) => `GET /api/library/${id}`));
    hiddenView.unmount();

    // Rows 4 - Борис's own record: without roles, then (second pass) under the administrator's ban. The ban pass answers as the
    //   server builds the record (apps/api/src/library/record-view.ts: `canShare` is false under a ban, design-library.md).
    const ownFields = {
      id: fixtureId(41),
      name: 'Мой разбор',
      author: { id: BORIS.id, name: BORIS.name, disabled: false },
    } satisfies Partial<RecordSummary> & Pick<RecordSummary, 'id'>;
    const passes = [
      { roles: [], record: recordDetail(ownFields), reason: 'У вас нет ролей — поделиться не с кем' },
      {
        roles: [SRE],
        record: recordDetail({ ...ownFields, ban: { closedAt: '2026-11-10T09:00:00.000Z' }, canShare: false }),
        reason: 'Доступ закрыл администратор — делиться нельзя',
      },
    ];
    for (const pass of passes) {
      resetRow();
      serveLibrary({ roles: pass.roles, list: [recordSummary(ownFields)], records: [pass.record] });
      const ownView = renderWithRuntime({ pathname: `/library/${ownFields.id}` });

      // Assert (row 4): the audience button is disabled with the reason of MC-14; a click opens no dialog and sends no request
      const audience = await screen.findByRole('button', { name: /^Кто видит: только вы/ });
      await waitFor(() => expect(audience).toHaveAttribute('aria-disabled', 'true'));
      expect(audience).toHaveAccessibleDescription(pass.reason);
      const beforeClick = tracked.requests.length;
      await user.click(audience);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(libraryRequestsSince(tracked.requests, beforeClick)).toEqual([]);
      ownView.unmount();
    }
  });

  // INT-2 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-21.1 "Given Аня потеряла право на Jira, а Jira есть в её агенте, when она открывает редактор, then Jira помечен, а сохранить агента
  //   можно"; AC-21.2 "Given запись изменили в другой вкладке, when Аня сохраняет, then она видит конфликт (AC-08.1)". Design: UC-3, UC-E2,
  //   DC-2, DC-3, KD-3, Flow 1, invariants 1 and 2.
  // Behavior: the author edits -> the form keeps the saved version and the typed values apart -> «Сохранить» sends the version the edit started
  //   from -> a conflict leaves the typed values in place and offers two actions -> leaving with unsaved changes asks first.
  // Rows (`PUT /api/library/:id` and `GET /api/library/:id` scripted per row; the tracker reads the request bodies):
  //   1. Given Аня's agent with Jira and no right to it (version 3); When she opens the editor, changes the instruction and saves; Then Jira is
  //      marked and does not block «Сохранить»; the `PUT` body carries `version: 3` and the new instruction; the panel shows «Сохранено»
  //      and `libraryIndex` is re-read.
  //   2. Same form, the save answers 409 `RECORD_VERSION_CONFLICT` and `GET` returns version 4 with a different description; Then the block of
  //      MC-10 stands above the panel, names the fields that differ between 4 and 3 (and only them), the typed instruction is still in the
  //      field; «Сохранить мои правки» sends `version: 4`. «Взять сохранённое» makes form and saved version 4 and the toast «Вернуть»
  //      puts the typed instruction back over version 4. In a second pass the `GET` after the conflict fails: the block is shown
  //      without the field list and without «Взять сохранённое».
  //   3. Given a changed form; When she clicks a sidebar item, then «Новый чат»; Then the dialog of MC-11 opens with the focus on
  //      «Остаться»; «Остаться» keeps the route and the typed values, «Уйти без сохранения» goes (router `push`). Given a clean form the
  //      same two clicks go without a question.
  // Catches: a save that sends the current stored version instead of the version the edit started from (a silent overwrite of the other tab's
  //   change - invariant 2); a conflict that clears what the author typed (invariant 1); a sidebar or «Новый чат» route that bypasses
  //   `leaveGuard` and loses a long instruction.
  // @category: core-functionality
  // @dependency: RecordEditor, useRecordForm, leaveGuard, ShellLink, newChat action, libraryApi, libraryIndex, ConfirmDialog (MC-11), MSW, next/navigation mock
  // @complexity: high
  it('INT-2: the editor saves with the version the edit started from, keeps the typed values through a conflict, and asks before leaving with unsaved changes', async () => {
    const user = userEvent.setup();
    const tracked = trackRequests(server);
    const ANYA_VIEWER = currentUser();
    const TYPED = 'Найди причины ошибок и предложи исправление.';
    const VERSION_CONFLICT = { statusCode: 409, message: 'Record version conflict', errorCode: 'RECORD_VERSION_CONFLICT' };
    const CONFLICT_HEAD = 'Вы уже сохранили изменения в другом окне или в чате.';

    /** Bodies of the `method path` requests since request number `from`. */
    const bodiesSince = (from: number, method: string, path: string): unknown[] =>
      tracked.requests
        .slice(from)
        .filter((request) => request.method === method && request.path === path)
        .map((request) => request.body);
    /** What `GET /api/library/<id>` answers from now on; any other path of that pattern (`choices`) falls through. */
    const answerRecord = (id: string, answer: () => Response): void => {
      server.use(http.get(`${API}/api/library/:id`, ({ params }) => (params['id'] === id ? answer() : undefined)));
    };
    /** The answer of every `PUT /api/library/:id`, switched per step. */
    let putAnswer: () => Response = () => HttpResponse.json(VERSION_CONFLICT, { status: 409 });
    const servePut = (): void => {
      server.use(http.put(`${API}/api/library/:id`, () => putAnswer()));
    };

    // Аня's agent at version 3 with Jira, which she has no right to any more (`choices.servers` holds only «logs»)
    const agentFields = { id: fixtureId(51), name: 'Разбор логов', version: 3 } satisfies Partial<RecordSummary> &
      Pick<RecordSummary, 'id'>;
    const agentPath = `/api/library/${agentFields.id}`;
    const agentV3 = recordDetail({ ...agentFields, content: agentContent({ servers: ['logs', 'jira'] }) });
    const agentV4 = recordDetail({
      ...agentFields,
      version: 4,
      description: 'Ищет причины ошибок в логах и метриках',
      content: agentContent({ servers: ['logs', 'jira'] }),
    });
    const openAgentEditor = async () => {
      serveLibrary({ viewer: ANYA_VIEWER, list: [recordSummary(agentFields)], records: [agentV3] });
      servePut();
      const view = renderWithRuntime({ pathname: `/library/${agentFields.id}` });
      const prompt = await screen.findByRole('textbox', { name: 'Инструкция' });
      return { view, prompt, panel: screen.getByRole('region', { name: 'Сохранение' }) };
    };

    // Row 1: Jira is marked and does not block «Сохранить»; the `PUT` carries version 3 and the new instruction
    putAnswer = () =>
      HttpResponse.json(recordDetail({ ...agentFields, version: 4, content: agentContent({ servers: ['logs', 'jira'], prompt: TYPED }) }));
    const first = await openAgentEditor();
    expect(screen.getByText('у вас недоступна').closest('div')).toHaveTextContent('jira');
    await user.clear(first.prompt);
    await user.type(first.prompt, TYPED);
    const beforeSave = tracked.requests.length;
    await user.click(within(first.panel).getByRole('button', { name: 'Сохранить' }));
    expect(await within(first.panel).findByText('Сохранено')).toBeInTheDocument();
    await waitFor(() =>
      expect(bodiesSince(beforeSave, 'PUT', agentPath)).toEqual([
        expect.objectContaining({ version: 3, content: expect.objectContaining({ prompt: TYPED, servers: ['logs', 'jira'] }) }),
      ]),
    );
    await waitFor(() => expect(libraryRequestsSince(tracked.requests, beforeSave)).toContain('GET /api/library'));
    first.view.unmount();

    // Row 2: the save answers 409 and the record reads as version 4 with another description
    resetRow();
    putAnswer = () => HttpResponse.json(VERSION_CONFLICT, { status: 409 });
    const conflicted = await openAgentEditor();
    answerRecord(agentFields.id, () => HttpResponse.json(agentV4));
    await user.clear(conflicted.prompt);
    await user.type(conflicted.prompt, TYPED);
    const beforeConflict = tracked.requests.length;
    await user.click(within(conflicted.panel).getByRole('button', { name: 'Сохранить' }));

    // Assert (row 2): MC-10 names only the field that differs between 4 and 3; the typed instruction stays; the record is read once
    expect(await screen.findByText(`${CONFLICT_HEAD} Там изменились: Описание.`)).toBeInTheDocument();
    expect(conflicted.prompt).toHaveValue(TYPED);
    await waitFor(() => expect(bodiesSince(beforeConflict, 'PUT', agentPath)).toEqual([expect.objectContaining({ version: 3 })]));
    expect(libraryRequestsSince(tracked.requests, beforeConflict).filter((request) => request === `GET ${agentPath}`)).toHaveLength(1);

    // Act (row 2): «Сохранить мои правки» carries the saved version 4
    const beforeMine = tracked.requests.length;
    await user.click(screen.getByRole('button', { name: 'Сохранить мои правки' }));
    await waitFor(() => expect(bodiesSince(beforeMine, 'PUT', agentPath)).toEqual([expect.objectContaining({ version: 4 })]));
    await screen.findByRole('button', { name: 'Взять сохранённое' });

    // Act (row 2): «Взять сохранённое» makes form and saved version 4; «Вернуть» puts the typed instruction back over it
    await user.click(screen.getByRole('button', { name: 'Взять сохранённое' }));
    expect(screen.getByRole('textbox', { name: 'Описание' })).toHaveValue('Ищет причины ошибок в логах и метриках');
    expect(conflicted.prompt).toHaveValue('Найди в логах причины ошибок и перечисли их.');
    expect(screen.queryByText(CONFLICT_HEAD)).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Вернуть' }));
    expect(conflicted.prompt).toHaveValue(TYPED);
    conflicted.view.unmount();

    // Row 2, second pass: the read after the conflict fails -> the block without the field list and without «Взять сохранённое»
    resetRow();
    putAnswer = () => HttpResponse.json(VERSION_CONFLICT, { status: 409 });
    const unread = await openAgentEditor();
    answerRecord(agentFields.id, () => HttpResponse.json({ statusCode: 500, message: 'Internal server error' }, { status: 500 }));
    await user.clear(unread.prompt);
    await user.type(unread.prompt, TYPED);
    await user.click(within(unread.panel).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText(CONFLICT_HEAD)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сохранить мои правки' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Взять сохранённое' })).toBeNull();
    unread.view.unmount();

    // Row 3: a changed form -> the sidebar item and «Новый чат» each ask MC-11 first
    resetRow();
    const sidebar = (): HTMLElement => {
      const element = document.querySelector<HTMLElement>('[data-slot="sidebar"]');
      if (element === null) throw new Error('the sidebar is not rendered');
      return element;
    };
    const askedThenStay = async (): Promise<void> => {
      const dialog = await screen.findByRole('alertdialog', { name: 'Уйти без сохранения?' });
      const stay = within(dialog).getByRole('button', { name: 'Остаться' });
      await waitFor(() => expect(stay).toHaveFocus());
      await user.click(stay);
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    };
    const guarded = await openAgentEditor();
    await user.clear(guarded.prompt);
    await user.type(guarded.prompt, TYPED);

    await user.click(within(sidebar()).getByRole('link', { name: 'Агенты' }));
    await askedThenStay();
    await user.click(within(sidebar()).getByRole('button', { name: 'Новый чат' }));
    await askedThenStay();

    // Assert (row 3): «Остаться» keeps the route and the typed instruction
    expect(guarded.view.router.push).not.toHaveBeenCalled();
    expect(guarded.prompt).toHaveValue(TYPED);

    // Act (row 3): «Уйти без сохранения» goes
    await user.click(within(sidebar()).getByRole('button', { name: 'Новый чат' }));
    const leave = await screen.findByRole('alertdialog', { name: 'Уйти без сохранения?' });
    await user.click(within(leave).getByRole('button', { name: 'Уйти без сохранения' }));
    await waitFor(() => expect(guarded.view.router.push.mock.calls).toEqual([['/']]));
    guarded.view.unmount();

    // Row 3, a clean form: the same two go at once, without a question
    const clean = await openAgentEditor();
    await user.click(within(sidebar()).getByRole('link', { name: 'Агенты' }));
    await user.click(within(sidebar()).getByRole('button', { name: 'Новый чат' }));
    expect(clean.view.router.push.mock.calls.map(([href]) => href)).toEqual(['/agents', '/']);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    clean.view.unmount();
  });

  // INT-3 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-25.1 "Given агент Ани в беседе Бориса просит подтвердить изменяющее действие, then на карточке видно имя агента, автор «Аня» и роль
  //   «SRE»"; AC-27.1 "Given у workflow четыре исполнителя, а координатор позвал троих, when запуск закончился, then каждый шаг подписан именем
  //   исполнителя, а четвёртый показан как не вызванный"; AC-27.2 "…координатор позвал исполнителя сверх предела запуска, then этот вызов
  //   показан как отклонённый по пределу"; AC-27.3 "Given workflow стартовал на версии 3, when автор сохраняет версию 4, then запуск по-прежнему
  //   показывает версию 3"; AC-28.1 "…в запуске Борис видит, что агент изменился после старта, и может запустить его заново на версии 2";
  //   AC-29.1 (the card half: `firstRun`). Design: UC-1 (the card), UC-7, UC-9, UC-10 (render half), UC-E6, DC-7, DC-11, KD-2, KD-7, Flow 3.
  // Behavior: the conversation and `GET /api/library` are read on open -> the run labels take name, author and version from `origin` and the
  //   audience from the live data -> the deep agent card additionally reads `DeepAgentRunView` -> labels, step rows and restart hints follow.
  // Rows (`conversationView` with `agentNode.origin`, `confirmation`, `GET /api/agents/:id/run` -> `DeepAgentRunView`):
  //   1. Given Аня's agent that asks Борис to confirm an action, with `origin` (record, version 1, name) and the record in the live data for
  //      «SRE», and a second run whose record is absent from the live data; When Борис opens the conversation; Then the first decision card is
  //      labelled «… · Аня Смирнова SRE» (name and author from `origin`, audience from the live data), the second run's label is the state
  //      «Недоступна» with no link, and the `firstRun` card carries the explanation of MC-17.
  //   2. Given a finished deep agent of version 3 with a team of four, three step children and a `run_limit` refusal, the live data holding
  //      version 4; When Борис opens the conversation; Then the steps are labelled with the team's names, the refused call reads «предел
  //      вызовов исчерпан», the fourth subagent reads «не вызывался», the header says «версия 3» (not 4), and the card re-reads
  //      `DeepAgentRunView` when the deep agent's status changes.
  //   3. Given Аня's agent whose run started on version 1 and the live data at version 2; When Борис opens the conversation; Then the card says
  //      «изменён после запуска: сейчас версия 2» with «Запустить заново», and the running agent still shows version 1. On the agent page:
  //      the hint reads «Пойдёт на версии 2» and the page has the line of MC-17 and no button of its own. With the record absent from the
  //      live data the card's label is «Недоступна», there is no line and no button, and the page's «Запустить с нуля» is disabled with the
  //      hint of MC-17; pressing the enabled one while the restart answers 409 `START_REFUSED` `model_not_allowed` shows the notice with the
  //      reason, and the address does not change.
  //   4. `GET /api/library` fails; Then the labels render without audience and without the version line, the error is logged once with the
  //      route, the status and the reason, and nothing else on the screen breaks.
  // Catches: a label that takes author, version or name from the live record instead of `origin` (a run would claim a version it did not
  //   run, AC-27.3); a card that reads the template or definition fields the contract no longer has; steps labelled by the instruction
  //   instead of the subagent name, or the fourth subagent silently missing; an absent record rendered as a broken link or as a
  //   «changed» line; a refused restart that opens a new agent anyway.
  // @category: core-functionality
  // @dependency: toFeed, FeedStore, libraryIndex, RunCard, AgentTree, DecisionCard, AgentMeta, AgentHeader, RecordLabel, StateBadge, getRun, LiveStore (test live source), MSW, next/navigation mock
  // @complexity: high
  it('INT-3: run labels take name, author and version from the origin and the audience from the live data, a deep agent card names its steps, and a changed record offers a restart on the new version', async () => {
    const user = userEvent.setup();
    const tracked = trackRequests(server);
    const THREAD = threadSummary({ id: 'a', title: 'Выгрузка' });
    const anyaAuthor = { id: ANYA.id, name: ANYA.name };
    const forSre = { roles: [{ ...SRE, member: true }] };
    const colleagues = { mine: false, author: ANYA, audience: forSre, canEdit: false, canShare: false, canDelete: false };

    // Аня's agent: the runs started on version 1 «Разбор инцидентов»; the live row is version 2, renamed, open to «SRE»
    const agentId = fixtureId(71);
    const agentOrigin = {
      recordId: agentId,
      kind: 'agent',
      version: 1,
      name: 'Разбор инцидентов',
      author: anyaAuthor,
      builtinKey: null,
      subagent: null,
    } satisfies RunOrigin;
    const liveAgent = recordSummary({ id: agentId, name: 'Разбор инцидентов и сбоев', version: 2, ...colleagues });
    // A record the live list does not hold (deleted or closed for Борис)
    const goneOrigin = { ...agentOrigin, recordId: fixtureId(72), name: 'Сводка смены' } satisfies RunOrigin;
    // Аня's deep agent: the run started on version 3, the live row is version 4; a team of four
    const deepAgentId = fixtureId(81);
    const deepAgentRunOrigin = {
      ...agentOrigin,
      recordId: deepAgentId,
      kind: 'deep_agent',
      version: 3,
      name: 'Полный разбор инцидента',
    } satisfies RunOrigin;
    const liveDeepAgent = recordSummary({
      id: deepAgentId,
      kind: 'deep_agent',
      name: 'Полный разбор инцидента',
      version: 4,
      ...colleagues,
    });

    const step = (stepId: string, subagent: string, description: string, status: AgentNode['status'], at: number) =>
      agentNode({
        agentId: stepId,
        parentId: 'w1',
        depth: 2,
        origin: { ...deepAgentRunOrigin, subagent },
        description,
        status,
        createdAt: fixtureTime(at),
      });
    const deepAgentNode = (status: 'working' | 'completed') =>
      agentNode({
        agentId: 'w1',
        name: 'Полный разбор инцидента',
        description: 'Полный разбор инцидента',
        origin: deepAgentRunOrigin,
        status,
        createdAt: fixtureTime(5),
        children: [
          step('s1', 'Сбор логов', 'Собрать логи за неделю', 'completed', 5.1),
          step('s2', 'Сбор тикетов', 'Найти тикеты по сбою', 'completed', 5.2),
          step('s3', 'Сводка', 'Свести найденное', status, 5.4),
        ],
      });
    const team = ['Сбор логов', 'Сбор тикетов', 'Метрики', 'Сводка'].map((name) => ({
      name,
      maxRuns: 1,
      final: name === 'Сводка',
    }));
    const viewOf = (deepAgentStatus: 'working' | 'completed'): ConversationView =>
      conversationView({
        thread: THREAD,
        entries: [
          historyEntry({ kind: 'task', seq: 1, content: { text: 'Разберись с инцидентом 42' } }),
          historyEntry({ kind: 'model_answer', seq: 2, content: { text: 'Запускаю разбор.' } }),
        ],
        decisions: [
          confirmation({
            decisionId: 'd1',
            agentId: 'a1',
            description: 'Проверка инцидента 42',
            origin: agentOrigin,
            createdAt: fixtureTime(6),
          }),
        ],
        agents: [
          agentNode({
            agentId: 'a1',
            origin: agentOrigin,
            firstRun: true,
            description: 'Проверка инцидента 42',
            status: 'awaiting_confirmation',
            createdAt: fixtureTime(3),
          }),
          agentNode({ agentId: 'a2', origin: goneOrigin, description: 'Сводка за ночь', status: 'completed', createdAt: fixtureTime(4) }),
          deepAgentNode(deepAgentStatus),
        ],
      });

    /** Conversation `a` and the run of `w1` as the server holds them now; the agent page of `a3`, Аня's agent run again later. */
    let held = viewOf('working');
    const pageOfA3 = agentPageView({
      agent: {
        agentId: 'a3',
        origin: agentOrigin,
        description: 'Проверка инцидента 41',
        status: 'completed',
        threadId: 'a',
        threadTitle: 'Выгрузка',
      },
      entries: [historyEntry({ kind: 'task', seq: 1, content: { text: 'Проверь инцидент 41' } })],
    });
    const serveRuns = (list: RecordSummary[]): void => {
      serveLibrary({ roles: [SRE], list });
      server.use(
        http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([THREAD]))),
        http.get(`${API}/api/threads/a`, () => HttpResponse.json(THREAD)),
        http.get(`${API}/api/threads/a/history`, ({ request }) => {
          const afterSeq = Number(new URL(request.url).searchParams.get('afterSeq'));
          return HttpResponse.json({ ...held, entries: held.entries.filter((entry) => entry.seq > afterSeq) });
        }),
        http.get(`${API}/api/agents/w1/run`, () => {
          const current = held.agents.find((agent) => agent.agentId === 'w1') ?? deepAgentNode('working');
          return HttpResponse.json(
            deepAgentRunView({
              origin: deepAgentRunOrigin,
              deepAgent: current,
              team,
              steps: current.children,
              limitRefusals: [{ subagent: 'Сбор логов', at: fixtureTime(5.3) }],
            }),
          );
        }),
        http.get(`${API}/api/agents`, () => HttpResponse.json(agentListPage([]))),
        http.get(`${API}/api/agents/a3/history`, () => HttpResponse.json(pageOfA3)),
      );
    };
    const runCard = (name: string): Promise<HTMLElement> => screen.findByRole('group', { name });
    /** The record label a card shows: the element around the record's name link. */
    const labelOf = (scope: HTMLElement, name: string): HTMLElement => {
      const label = within(scope).getByRole('link', { name }).parentElement;
      if (label === null) throw new Error(`the label of «${name}» is not rendered`);
      return label;
    };
    /** The deep agent card's rows: a link (a step the deep agent started) or a plain row, by what a screen reader hears. */
    const runRows = (card: HTMLElement): string[] =>
      Array.from(card.querySelectorAll('li'), (row) => {
        const link = row.querySelector('a');
        return link === null ? `строка: ${row.querySelector('.sr-only')?.textContent ?? '?'}` : `ссылка: ${link.getAttribute('aria-label')}`;
      });
    const runReads = (): number => tracked.requests.filter((request) => request.path === '/api/agents/w1/run').length;
    const RECIPIENT_NOTE =
      'Аня Смирнова · для роли SRE: работает с вашими правами и аккаунтами, изменения — только после вашего подтверждения. Убрать может автор или администратор.';

    serveRuns([liveAgent, liveDeepAgent]);
    const live = createTestLiveSource();
    const view = renderWithRuntime({ pathname: '/chat/a', liveSource: live });
    await screen.findByText('Запускаю разбор.');
    await waitFor(() => expect(live.current()?.url).toBe(`${API}/api/events?watch=thread%3Aa`));

    // Assert (row 1): the decision card names the asking agent's record - name and author from `origin`, the role from the live data
    const agentCard = await runCard('Проверка инцидента 42: Ждёт подтверждения');
    await waitFor(() => expect(labelOf(agentCard, 'Разбор инцидентов')).toHaveTextContent(', автор Аня Смирнова, SRE'));
    const decision = view.container.querySelector<HTMLElement>('[data-decision-id="d1"]');
    if (decision === null) throw new Error('the decision card d1 is not rendered');
    const decisionLabel = labelOf(decision, 'Разбор инцидентов');
    expect(within(decision).getByRole('link', { name: 'Разбор инцидентов' })).toHaveAttribute('href', `/library/${agentId}`);
    expect(decisionLabel).toHaveTextContent(', автор Аня Смирнова, SRE');
    expect(decisionLabel).toHaveTextContent('· Аня Смирнова');
    expect(within(decisionLabel).getByText('SRE')).toBeInTheDocument();
    expect(decision).not.toHaveTextContent('Разбор инцидентов и сбоев');

    // Assert (row 1): the first run's card links the record by its origin name and carries the recipient's explanation (MC-17)
    expect(within(agentCard).getByRole('link', { name: 'Разбор инцидентов' })).toHaveAttribute('href', `/library/${agentId}`);
    expect(agentCard).not.toHaveTextContent('Разбор инцидентов и сбоев');
    expect(agentCard).toHaveTextContent(RECIPIENT_NOTE);

    // Assert (row 1): the run of a record the live list does not hold - the state without a link, no «changed» line, no restart
    const goneCard = await runCard('Сводка за ночь: Завершён');
    expect(within(goneCard).queryByRole('link', { name: 'Сводка смены' })).toBeNull();
    expect(within(goneCard).getByText('Сводка смены')).toBeInTheDocument();
    expect(within(goneCard).getByText('агент недоступен')).toBeInTheDocument();
    expect(goneCard).not.toHaveTextContent('изменён после запуска');
    expect(within(goneCard).queryByRole('button', { name: 'Запустить заново' })).toBeNull();

    // Assert (row 3, card): the live record is newer than the run - the MC-17 line with «Запустить заново»
    expect(within(agentCard).getByText('Агент изменён после запуска: сейчас версия 2')).toBeInTheDocument();
    expect(within(agentCard).getByRole('button', { name: 'Запустить заново' })).toBeInTheDocument();

    // Assert (row 2, running): the header carries the run's version 3, not the live 4; steps by subagent, the limit refusal among them
    const deepAgentCard = await runCard('Полный разбор инцидента: Работает');
    const deepAgentHeader = labelOf(deepAgentCard, 'Полный разбор инцидента');
    expect(deepAgentHeader).toHaveTextContent('версия 3');
    expect(deepAgentHeader).not.toHaveTextContent('версия 4');
    await waitFor(() =>
      expect(runRows(deepAgentCard)).toEqual([
        'ссылка: Сбор логов, Собрать логи за неделю, Завершён',
        'ссылка: Сбор тикетов, Найти тикеты по сбою, Завершён',
        'строка: Сбор логов, предел вызовов исчерпан',
        'ссылка: Сводка, Свести найденное, Работает',
      ]),
    );
    const readsWhileRunning = runReads();
    expect(readsWhileRunning).toBeGreaterThan(0);

    // Act (row 2): the deep agent finishes; the stream's `ready` re-reads the conversation
    held = viewOf('completed');
    live.emit('ready', {});

    // Assert (row 2, ended): the card re-read the run on the status change; the fourth subagent reads «не вызывался» and is no link
    const endedCard = await runCard('Полный разбор инцидента: Завершён');
    await waitFor(() =>
      expect(runRows(endedCard)).toEqual([
        'ссылка: Сбор логов, Собрать логи за неделю, Завершён',
        'ссылка: Сбор тикетов, Найти тикеты по сбою, Завершён',
        'строка: Сбор логов, предел вызовов исчерпан',
        'ссылка: Сводка, Свести найденное, Завершён',
        'строка: Метрики, не вызывался',
      ]),
    );
    await waitFor(() => expect(runReads()).toBeGreaterThan(readsWhileRunning));
    expect(labelOf(endedCard, 'Полный разбор инцидента')).toHaveTextContent('версия 3');
    expect(labelOf(endedCard, 'Полный разбор инцидента')).not.toHaveTextContent('версия 4');
    expect(within(endedCard).getByText('Глубокий агент изменён после запуска: сейчас версия 4')).toBeInTheDocument();

    // Act (row 3, card): «Запустить заново» puts the live record into this conversation's field through `useInChat`
    await user.click(within(agentCard).getByRole('button', { name: 'Запустить заново' }));
    expect(view.router.push).toHaveBeenLastCalledWith('/chat/a');
    expect(await screen.findByRole('button', { name: 'Убрать: Разбор инцидентов и сбоев' })).toBeInTheDocument();
    view.unmount();

    // Arrange (row 3, agent page): `a3` ran Аня's agent on version 1; the live record is at version 2
    resetRow();
    serveRuns([liveAgent, liveDeepAgent]);
    const pageView = renderWithRuntime({ pathname: '/agents/a3' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Проверка инцидента 41' })).toBeInTheDocument();
    const restart = screen.getByRole('button', { name: 'Запустить с нуля' });

    // Assert (row 3, agent page): the hint names the live version; the running agent keeps version 1; MC-17 without a button of its own
    await waitFor(() => expect(restart).toHaveAccessibleDescription('Пойдёт на версии 2'));
    expect(restart).toBeEnabled();
    const pageLabel = labelOf(document.body, 'Разбор инцидентов');
    expect(pageLabel).toHaveTextContent('версия 1');
    expect(pageLabel).not.toHaveTextContent('версия 2');
    expect(screen.getByText('Агент изменён после запуска: сейчас версия 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Запустить заново' })).toBeNull();

    // Act (row 3, agent page): «Запустить с нуля» while the restart answers 409 `START_REFUSED` `model_not_allowed`
    server.use(
      http.post(`${API}/api/agents/a3/restart`, () =>
        HttpResponse.json(
          { statusCode: 409, message: 'Start refused', errorCode: 'START_REFUSED', reason: 'model_not_allowed', model: SONNET },
          { status: 409 },
        ),
      ),
    );
    await user.click(restart);

    // Assert (row 3, agent page): the notice says why and offers the record; no new agent is opened, the address stays
    expect(
      await screen.findByText('Модель Sonnet вам недоступна — агент не запустился. Скопируйте его себе — копия получит вашу модель'),
    ).toBeInTheDocument();
    expect(tracked.requests.filter((request) => request.method === 'POST' && request.path === '/api/agents/a3/restart')).toHaveLength(1);
    expect(pageView.router.push).not.toHaveBeenCalled();
    expect(pageView.router.replace).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Открыть' }));
    expect(pageView.router.push.mock.calls).toEqual([[`/library/${agentId}`]]);
    pageView.unmount();

    // Row 3, the record absent from the live data: the page's «Запустить с нуля» is disabled with the MC-17 hint
    resetRow();
    serveRuns([liveDeepAgent]);
    const gonePage = renderWithRuntime({ pathname: '/agents/a3' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Проверка инцидента 41' })).toBeInTheDocument();
    const blocked = screen.getByRole('button', { name: 'Запустить с нуля' });
    await waitFor(() => expect(blocked).toBeDisabled());
    expect(blocked).toHaveAccessibleDescription('Агент недоступен — запустить с нуля нельзя');
    expect(screen.queryByRole('link', { name: 'Разбор инцидентов' })).toBeNull();
    expect(document.body).not.toHaveTextContent('изменён после запуска');
    gonePage.unmount();

    // Row 4: `GET /api/library` fails - the labels render without audience and without the «changed» line, logged once
    held = viewOf('working');
    resetRow();
    serveRuns([liveAgent, liveDeepAgent]);
    server.use(
      http.get(`${API}/api/library`, () =>
        HttpResponse.json({ statusCode: 500, message: 'Internal server error', reason: 'database_unavailable' }, { status: 500 }),
      ),
    );
    const listFailures = (): unknown[] => logRecords.filter((record) => record.message === 'library: list read failed');
    const failedView = renderWithRuntime({ pathname: '/chat/a' });
    await screen.findByText('Запускаю разбор.');
    await waitFor(() => expect(listFailures()).toHaveLength(1));

    // Assert (row 4): the labels keep name and author of the origin, with no audience, no «changed» line, no restart, no note
    const unreadCard = await runCard('Проверка инцидента 42: Ждёт подтверждения');
    expect(labelOf(unreadCard, 'Разбор инцидентов')).toHaveTextContent(', автор Аня Смирнова');
    expect(labelOf(unreadCard, 'Разбор инцидентов')).not.toHaveTextContent('SRE');
    expect(within(await runCard('Сводка за ночь: Завершён')).getByRole('link', { name: 'Сводка смены' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('изменён после запуска');
    expect(document.body).not.toHaveTextContent('недоступен');
    expect(document.body).not.toHaveTextContent('работает с вашими правами');
    expect(screen.queryByRole('button', { name: 'Запустить заново' })).toBeNull();
    // ...and nothing else breaks: the conversation, the decision card and the deep agent card are on screen
    expect(failedView.container.querySelector('[data-decision-id="d1"]')).toHaveTextContent('хочет выполнить:');
    expect(labelOf(await runCard('Полный разбор инцидента: Работает'), 'Полный разбор инцидента')).toHaveTextContent('версия 3');
    expect(screen.getByText('Разберись с инцидентом 42')).toBeInTheDocument();
    expect(listFailures()).toEqual([
      {
        level: 'warn',
        message: 'library: list read failed',
        fields: expect.objectContaining({ method: 'GET', path: '/api/library', status: 500, reason: 'database_unavailable' }),
      },
    ]);
    failedView.unmount();
  });

  // INT-4 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-23.2 "Given Аня открывает окно, then ей предложены только её роли"; AC-24.1 "Given у Ани есть личная и ролевая запись, when
  //   администратор открывает раздел, then видит только ролевую - с промптом, автором и ролями". Design: UC-5, UC-6, KD-1 (the section),
  //   DC-6 (the tab as an address is proven by the `parseShellRoute` unit table, not here).
  // Behavior: the audience dialog lists the employee's roles and turns the ticks into the body; the panel section reads its three lists, opens a
  //   record and closes access after a confirmation; a company record is saved and deleted through the panel's routes only.
  // Rows:
  //   1. Given Аня with roles «SRE» and «Оплаты», the record open to the role «Дежурный» which Аня has left; When she opens «Поделиться»;
  //      Then the boxes are her roles plus «Дежурный» ticked and marked as no longer hers; she ticks «SRE» and saves: `PUT …/audience`
  //      carries exactly the role numbers of «Дежурный» and «SRE» and `offerInChat`, the toast of MC-14 names the result, `libraryIndex`
  //      is re-read.
  //   2. Given the administrator and `GET /api/admin/library/shared` holding Аня's record for «SRE» (and `system`, `bans` answering their
  //      own lists); When he opens `/admin/library/shared`; Then the row shows the name, the author and the roles; he opens the record by
  //      its row link: the page shows the instruction (view AL-03 for an employee's record); «Закрыть доступ» asks a confirmation and,
  //      after it, sends one `POST /api/admin/library/:id/close` and the row is gone; before the confirmation no request is sent.
  //   3. Given a company record at `/admin/library/<id>`; When the administrator ticks «Все системы» and saves; Then exactly one
  //      `PUT /api/admin/library/<id>` carries the form's version and `servers: ['*']`, and no request goes to the employee's route.
  //   4. Given «Системные» with a company record and a built-in one; When he chooses «Удалить» on the company record; Then nothing is sent
  //      before the dialog is confirmed, then exactly one `DELETE`; the built-in row offers no «Удалить».
  // Catches: a dialog offering roles the employee does not hold, or dropping a role the record already has because the employee left it (a
  //   silent loss of access for its holders); an audience body without `offerInChat`; a panel action that closes access or deletes without a
  //   confirmation or on the wrong record; a company record saved through the employee's route (refused for it); a built-in record offered
  //   for deletion.
  // @category: core-functionality
  // @dependency: ShareDialog (employee variant), libraryApi, adminApi.library, AdminScreen section `library`, SystemRecordPage, RecordEditor (mode system), DataTable, ConfirmDialog, DeleteRecordDialog, parseShellRoute, MSW, next/navigation mock
  // @complexity: medium
  it('INT-5: the audience dialog offers the employee\'s roles and keeps a role she left, and the panel section lists shared records and closes access only after a confirmation', async () => {
    const user = userEvent.setup();
    const tracked = trackRequests(server);
    const PAYMENTS = { id: fixtureId(101), name: 'Оплаты' };
    const DUTY = { id: fixtureId(102), name: 'Дежурный' };

    /** Bodies of the `method path` requests since request number `from`. */
    const bodiesSince = (from: number, method: string, path: string): unknown[] =>
      tracked.requests
        .slice(from)
        .filter((request) => request.method === method && request.path === path)
        .map((request) => request.body);
    /** An audience body with its `roleIds` in a fixed order (the dialog does not promise one). */
    const withSortedRoles = (body: unknown): unknown =>
      typeof body === 'object' && body !== null && 'roleIds' in body && Array.isArray(body.roleIds)
        ? { ...body, roleIds: body.roleIds.map(String).sort() }
        : body;

    // Row 1: Аня (roles «SRE» and «Оплаты») owns an agent open to «Дежурный», a role she has left; library only
    const ownFields = {
      id: fixtureId(111),
      audience: { roles: [{ ...DUTY, member: false }] },
      offerInChat: false,
    } satisfies Partial<RecordSummary> & Pick<RecordSummary, 'id'>;
    const audiencePath = `/api/library/${ownFields.id}/audience`;
    serveLibrary({ viewer: currentUser(), roles: [SRE, PAYMENTS], list: [recordSummary(ownFields)] });
    server.use(
      http.put(`${API}${audiencePath}`, () =>
        HttpResponse.json(
          recordDetail({
            ...ownFields,
            audience: { roles: [{ ...DUTY, member: false }, { ...SRE, member: true }] },
            offerInChat: true,
          }),
        ),
      ),
    );
    const libraryView = renderWithRuntime({ pathname: '/library' });

    // Act (row 1): «Поделиться» from the row's menu; the dialog reads the viewer's roles on open
    const mine = await screen.findByRole('region', { name: 'Мои · 1' });
    await user.click(within(mine).getByRole('button', { name: 'Действия: Разбор логов' }));
    const beforeOpen = tracked.requests.length;
    await user.click(await screen.findByRole('menuitem', { name: 'Поделиться' }));
    const dialog = await screen.findByRole('dialog', { name: 'Поделиться «Разбор логов»' });
    const sre = await within(dialog).findByRole('checkbox', { name: 'SRE' });
    expect(libraryRequestsSince(tracked.requests, beforeOpen)).toContain('GET /api/auth/me/roles');

    // Assert (row 1): her two roles, unticked, and «Дежурный» ticked and marked as no longer hers - nothing else
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(3);
    expect(sre).not.toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Оплаты' })).not.toBeChecked();
    const duty = within(dialog).getByRole('checkbox', { name: 'Дежурный' });
    expect(duty).toBeChecked();
    expect(duty).toHaveAccessibleDescription('вы больше не в этой роли');

    // Act (row 1): tick «SRE», let the colleagues' chat offer it, save
    await user.click(sre);
    await user.click(within(dialog).getByRole('radio', { name: 'Их чат предлагает и запускает агента' }));
    const beforeSave = tracked.requests.length;
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    // Assert (row 1): one `PUT …/audience` with «Дежурный» kept, «SRE» added, «Оплаты» absent, and `offerInChat`; the toast of
    //   MC-14 names the saved audience; the dialog closes and `libraryIndex` is re-read
    expect(await screen.findByText('Теперь видят: Дежурный, SRE')).toBeInTheDocument();
    await waitFor(() => expect(bodiesSince(beforeSave, 'PUT', audiencePath)).toHaveLength(1));
    const [audienceBody] = bodiesSince(beforeSave, 'PUT', audiencePath);
    expect(withSortedRoles(audienceBody)).toEqual({ roleIds: [DUTY.id, SRE.id].sort(), offerInChat: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(libraryRequestsSince(tracked.requests, beforeSave)).toContain('GET /api/library'));
    libraryView.unmount();

    // Row 2: the administrator; «Открытые ролям» holds Аня's agent for «SRE» and Олег's for «Оплаты»; `system` and `bans` answer
    //   their own lists; the close takes the record off the server's list
    resetRow();
    const ADMIN = currentUser({ id: fixtureId(3), email: 'igor@corp.example', name: 'Игорь Петров', isAdmin: true });
    const colleagues = { mine: false, canEdit: false, canShare: false, canDelete: false };
    const anyaFields = {
      id: fixtureId(121),
      name: 'Разбор инцидентов',
      description: 'Ищет причины сбоев',
      author: ANYA,
      audience: { roles: [{ ...SRE, member: false }] },
      offerInChat: true,
      ...colleagues,
    } satisfies Partial<RecordSummary> & Pick<RecordSummary, 'id'>;
    const olegRecord = recordSummary({
      id: fixtureId(122),
      name: 'Сводка смены',
      description: 'Сводит события смены',
      author: { id: fixtureId(5), name: 'Олег Иванов', disabled: false },
      audience: { roles: [{ ...PAYMENTS, member: false }] },
      ...colleagues,
    });
    const INSTRUCTION = 'Разбери инцидент по логам и тикетам.';
    const anyaRecord = recordDetail({ ...anyaFields, content: agentContent({ prompt: INSTRUCTION }) });
    const closePath = `/api/admin/library/${anyaFields.id}/close`;
    let sharedList: RecordSummary[] = [recordSummary(anyaFields), olegRecord];
    // The company's records: one the administrator made, and the built-in one (the server would not offer its deletion; the flag
    //   is set here so that only the web decides)
    const companyFields = {
      id: fixtureId(131),
      name: 'Дежурный помощник',
      author: null,
      version: 5,
      canEdit: true,
      canDelete: true,
    } satisfies Partial<RecordSummary> & Pick<RecordSummary, 'id'>;
    const companyRecord = recordDetail({ ...companyFields, content: agentContent({ servers: ['logs'] }) });
    const builtin = recordSummary({
      id: fixtureId(130),
      name: 'general-purpose',
      builtinKey: 'general-purpose',
      author: null,
      ...colleagues,
      canDelete: true,
    });
    let systemList: RecordSummary[] = [recordSummary(companyFields), builtin];
    const companyPath = `/api/admin/library/${companyFields.id}`;
    const servePanel = (): void => {
      serveLibrary({ viewer: ADMIN });
      server.use(
        http.get(`${API}/api/admin/library/system`, () => HttpResponse.json(systemList)),
        http.get(`${API}/api/admin/library/shared`, () => HttpResponse.json(sharedList)),
        http.get(`${API}/api/admin/library/bans`, () => HttpResponse.json([] satisfies BannedRecord[])),
        http.get(`${API}/api/admin/library/settings`, () =>
          HttpResponse.json({ defaultMaxTurns: NEW_MAX_TURNS, updatedAt: null } satisfies LibrarySettings),
        ),
        http.get(`${API}/api/admin/library/:id`, ({ params }) => {
          if (params['id'] === anyaRecord.id) return HttpResponse.json(anyaRecord);
          if (params['id'] === companyRecord.id) return HttpResponse.json(companyRecord);
          return HttpResponse.json(RECORD_NOT_FOUND, { status: 404 });
        }),
        http.post(`${API}${closePath}`, () => {
          sharedList = [olegRecord];
          return new HttpResponse(null, { status: 204 });
        }),
        // What the company record's editor reads on open besides the record: the registry and the model catalogue
        http.get(`${API}/api/admin/mcp-servers`, () => HttpResponse.json([mcpServerSummary({ name: 'logs' })])),
        http.get(`${API}/api/admin/models`, () => HttpResponse.json([])),
        http.put(`${API}${companyPath}`, () =>
          HttpResponse.json(recordDetail({ ...companyFields, version: 6, content: agentContent({ servers: ['*'] }) })),
        ),
        http.delete(`${API}${companyPath}`, () => {
          systemList = [builtin];
          return new HttpResponse(null, { status: 204 });
        }),
      );
    };
    /** The panel's library requests since request number `from`, as «METHOD path». */
    const panelRequestsSince = (from: number): string[] =>
      tracked.requests
        .slice(from)
        .filter((request) => request.path.startsWith('/api/admin/library'))
        .map((request) => `${request.method} ${request.path}`);
    /** Where the rows of a panel table lead: one link per record row (a leaving row is hidden). */
    const rowHrefs = (table: HTMLElement): (string | null)[] =>
      within(table)
        .queryAllByRole('link')
        .map((link) => link.getAttribute('href'));

    servePanel();
    const panelView = renderWithRuntime({ pathname: '/admin/library/shared' });

    // Assert (row 2, list): the tab is chosen by the address; each row shows the name, the author and the roles
    const shared = await screen.findByRole('table', { name: 'Открытые ролям' });
    expect(screen.getByRole('tab', { name: 'Открытые ролям' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Системные' })).toHaveAttribute('href', '/admin/library');
    expect(screen.getByRole('tab', { name: 'Запреты' })).toHaveAttribute('href', '/admin/library/bans');
    const anyaRow = within(shared).getByRole('link', { name: /^Разбор инцидентов/ }).closest('tr');
    if (anyaRow === null) throw new Error('the row of «Разбор инцидентов» is not rendered');
    expect(Array.from(anyaRow.querySelectorAll('td'), (cell) => cell.textContent)).toEqual([
      'Разбор инцидентовИщет причины сбоев',
      'Аня Смирнова',
      'SRE',
      'да',
      '',
    ]);
    expect(rowHrefs(shared)).toEqual([`/admin/library/${anyaFields.id}`, `/admin/library/${olegRecord.id}`]);

    // Act (row 2): open Аня's record by its row link: the router goes there, then the address changes
    await user.click(within(anyaRow).getByRole('link', { name: /^Разбор инцидентов/ }));
    expect(panelView.router.push.mock.lastCall?.[0]).toBe(`/admin/library/${anyaFields.id}`);
    panelView.setPathname(`/admin/library/${anyaFields.id}`);

    // Assert (row 2, AL-03): the record with its author, its roles and the instruction
    expect(await screen.findByRole('heading', { level: 1, name: 'Разбор инцидентов' })).toBeInTheDocument();
    expect(screen.getByText(INSTRUCTION)).toBeInTheDocument();
    expect(screen.getByText('Роли:').parentElement).toHaveTextContent('Роли: SRE');
    expect(document.body).toHaveTextContent('Аня Смирнова');

    // Act (row 2): «Закрыть доступ» asks first; «Отмена» sends nothing
    const beforeClose = tracked.requests.length;
    await user.click(screen.getByRole('button', { name: 'Закрыть доступ' }));
    const asked = await screen.findByRole('alertdialog', { name: 'Закрыть доступ к «Разбор инцидентов»?' });
    expect(asked).toHaveTextContent('Агент станет личным у автора, Аня Смирнова: роль SRE перестанет его видеть.');
    await user.click(within(asked).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(panelRequestsSince(beforeClose)).toEqual([]);

    // Act (row 2): ask again and confirm
    await user.click(screen.getByRole('button', { name: 'Закрыть доступ' }));
    const confirmation = await screen.findByRole('alertdialog', { name: 'Закрыть доступ к «Разбор инцидентов»?' });
    expect(panelRequestsSince(beforeClose)).toEqual([]);
    await user.click(within(confirmation).getByRole('button', { name: 'Закрыть доступ' }));

    // Assert (row 2): exactly one close, of this record; the notice; the page returns to «Открытые ролям»
    expect(await screen.findByText('Доступ закрыт')).toBeInTheDocument();
    expect(panelRequestsSince(beforeClose)).toEqual([`POST ${closePath}`]);
    await waitFor(() => expect(panelView.router.push).toHaveBeenLastCalledWith('/admin/library/shared'));
    panelView.setPathname('/admin/library/shared');

    // Assert (row 2): the list is read again and Аня's row is gone, Олег's stays
    const reread = await screen.findByRole('table', { name: 'Открытые ролям' });
    await waitFor(() => expect(rowHrefs(reread)).toEqual([`/admin/library/${olegRecord.id}`]));
    expect(panelRequestsSince(beforeClose).filter((request) => request.startsWith('POST'))).toEqual([`POST ${closePath}`]);
    panelView.unmount();

    // Row 3: a company record (no author): the editor reads the choices, the registry and the catalogue on open
    resetRow();
    servePanel();
    const companyView = renderWithRuntime({ pathname: `/admin/library/${companyFields.id}` });
    const everything = await screen.findByRole('switch', { name: 'Все системы' });
    await waitFor(() => expect(everything).not.toBeChecked());
    const beforeCompany = tracked.requests.length;
    await user.click(everything);
    const companyPanel = screen.getByRole('region', { name: 'Сохранение' });
    await user.click(within(companyPanel).getByRole('button', { name: 'Сохранить' }));

    // Assert (row 3): one `PUT` of the panel's route with the form's version and «все системы»; the employee's route is not touched
    expect(await within(companyPanel).findByText('Сохранено')).toBeInTheDocument();
    expect(bodiesSince(beforeCompany, 'PUT', companyPath)).toEqual([
      expect.objectContaining({ version: 5, content: expect.objectContaining({ servers: ['*'] }) }),
    ]);
    expect(tracked.requests.filter((request) => request.path === `/api/library/${companyFields.id}`)).toEqual([]);
    companyView.unmount();

    // Row 4: «Системные»; «Удалить» is in the menu of the company record only
    resetRow();
    servePanel();
    const systemView = renderWithRuntime({ pathname: '/admin/library' });
    const system = await screen.findByRole('table', { name: 'Системные' });
    expect(within(system).queryByRole('button', { name: 'Действия: general-purpose' })).toBeNull();
    const beforeDelete = tracked.requests.length;
    await user.click(within(system).getByRole('button', { name: 'Действия: Дежурный помощник' }));
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Удалить']);
    await user.click(screen.getByRole('menuitem', { name: 'Удалить' }));

    // Assert (row 4): nothing is sent before the confirmation; then exactly one `DELETE`, and the row leaves
    const confirmDelete = await screen.findByRole('alertdialog', { name: 'Удалить «Дежурный помощник»?' });
    expect(panelRequestsSince(beforeDelete)).toEqual([]);
    await user.click(within(confirmDelete).getByRole('button', { name: 'Удалить' }));
    expect(await screen.findByText('Агент удалён')).toBeInTheDocument();
    expect(panelRequestsSince(beforeDelete).filter((request) => !request.startsWith('GET'))).toEqual([`DELETE ${companyPath}`]);
    await waitFor(() => expect(within(system).queryByRole('link', { name: 'Дежурный помощник' })).toBeNull());
    systemView.unmount();
  });
});
