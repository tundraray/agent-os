// self-learning / web - integration test skeletons (Vitest + RTL + MSW 2, jsdom)
// Design Doc: docs/features/self-learning/design-web.md (v1.1), Test Strategy UC-1 .. UC-4, UC-E1;
//   upstream contract: docs/features/self-learning/design-core.md (v1.1, Contract Definitions);
//   PRD: docs/features/self-learning/prd.md FR-10..FR-13; UXRD: docs/features/self-learning/uxrd.md.
// Generated: 2026-11-20 | Budget Used: 4/3 integration skeletons (INT-1 .. INT-4), the default 3 plus 1 extra: the design lists five
//   automated cases, UC-2 and UC-E1 merge into INT-2 (one route, one screen, rows of the same table); each of the four names the defect no
//   other test catches (see "Catches"). 0/2 E2E: the repo has no browser tool, so the design's «L1-сценарии в браузере» table stays the
//   manual real-browser acceptance, as in custom-agents-web and agent-platform-web.
// Test Type: Integration. All four are implemented: INT-2 and INT-3 (work plan Task 4.1), INT-1 and INT-4 (Task 4.2).
//
// Harness (src/test/, same as custom-agents-web.int.test.tsx and enterprise-access-admin.int.test.tsx):
//   `renderWithRuntime({ pathname })` from '@/test/render-with-runtime' mounts ChatRuntimeProvider + ChatShell + Toaster with mocked
//   next/navigation (controlled pathname, router spy). MSW server from '@/test/msw-server' (`onUnhandledRequest: 'error'`: a request a
//   screen must NOT send fails the test); `trackRequests`, `logRecords`, `loggerModule` from '@/test/admin-support'; fixtures of
//   '@/test/fixtures' (`recordDetail`, `workflowContent` with the new `selfLearning`, ...), built to pass the schemas of
//   `packages/contracts`.
// Mock boundary: network (MSW), next/navigation, the event source of LiveStore, `@/lib/logger`. Real: shell route parsing, `libraryApi`,
//   `adminApi`, `apiRequest` with its handlers, `useResource`, `RecordEditor`, `useRecordForm`, `KnowledgePage`, `DataTable`,
//   `ConfirmDialog`, `AdminForm`, toast. Do NOT mock any of them.
//
// Server-side proofs are NOT repeated here: who may read or delete the graph (403 KNOWLEDGE_FORBIDDEN vs 404), the cascade of an entity's
//   fact relations, the settings bounds check and the audit row are proven by the API tests of `core`. Every server answer below is a
//   scripted MSW response; the test proves what the browser shows, sends and re-reads for it.
//
// Proven by unit tests (NOT repeated here; named for the plan):
//   - AC-10.1 rule half (provenAt: unit): `workflowChanges` row `selfLearning` + `RECORD_FIELD_LABELS` «Самообучение»
//     (lib/library/record-rules.test.ts, existing table; one new row).
//   - `parseShellRoute` rows `/library/<id>/knowledge` and `/admin/library/<id>/knowledge` (lib/shell-route.test.ts, existing table).
//   - `isKnowledgeHidden` rows 404 / 403 KNOWLEDGE_FORBIDDEN / 403 other / 500 (lib/library/library-errors.test.ts, existing table).
//   - `knowledge-view` pure functions (lib/library/knowledge-view.test.ts, one table-driven test = design UC-5): status lines 1-5 with
//     their numbers taken from `counts`; the selection line (`selection` off with `model_not_selected`, off with `provider_failed` + the
//     model, `preparing` with the number from `pending`); marks «только по теме» (`by_topic`) / «не помещается» (`does_not_fit`) /
//     «устарела» / «уроки выключены»; the fifth tab «Только по теме» (selection on) or «Не помещаются» (selection off) with its count; no
//     selection marks and no selection line when self-learning is off; cell text per kind; `reason` -> MC-3 wording. The «selection off»
//     screen is a row of this table, NOT an INT-2 row: the Test Strategy puts UC-5 at L1 (manual) and the branch is pure mapping.
//   - `knowledgeSettingsRules` bounds rows (lib/admin/form-rules.test.ts, existing table): the field rule of AC-12.1 («Место» outside
//     KNOWLEDGE_LIMIT_TOKENS_MIN..MAX or not an integer).
//
// `not automated` (manual, L1 table of the design): the card line MC-9 on the task card (AC-13.1, design UC-6), focus after delete and the
//   default focus «Отмена» of the dialog, 360 px width and touch targets, light/dark theme and contrast, the end-to-end run -> new records
//   -> status line 5 (Flow «Флажок и экран»), and the L1 row «Состояния» (lessons off in the panel, smaller cap, self-learning off, and the
//   selection-off / preparing lines with their reasons against the real API).
//
// AC proof map (one proof per AC; the DC rows of the design are listed beside):
//   AC-10.1 INT-1 + unit (the rule) | AC-11.1 INT-2 | AC-11.3 INT-2 | AC-11.4 INT-2 | AC-11.5 INT-2 | AC-11.2 INT-3 | AC-09.1 INT-2 |
//   AC-09.2 INT-3 | AC-09.3 INT-2 | AC-12.1 INT-4 (wiring) + unit (bounds) | AC-06.1 INT-2 | AC-16.1 INT-2 |
//   AC-02.2, AC-03.2, AC-03.4, AC-04.3, AC-06.2, AC-08.2, AC-11.6, AC-15.3, AC-17.1, AC-18.3, AC-18.4 unit (knowledge-view table) | AC-13.1 not automated (L1) |
//   DC-1 INT-1 | DC-2 INT-2 | DC-3 INT-3 | DC-5 INT-4 (wiring) + unit (the rule) | DC-4 not automated (L1)

import {
  LibraryErrorCode,
  type CurrentUser,
  type LibraryChoices,
  type LibrarySettings,
  type MyRoleList,
  type RecordDetail,
  type RecordSummary,
} from '@agent-os/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { logRecords, trackRequests, type TrackedRequests } from '@/test/admin-support';
import {
  currentUser,
  fixtureId,
  fixtureTime,
  knowledgeEntity,
  knowledgeFact,
  knowledgeLesson,
  knowledgeSearchedNothing,
  knowledgeSettings,
  knowledgeView,
  recordDetail,
  threadList,
  workflowContent,
} from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

vi.mock('@/lib/logger', async () => (await import('@/test/admin-support')).loggerModule);

const API = 'http://api.test';

// Support shared by the cases of this file -------------------------------------------------------------------------------------------------

/** The workflow whose knowledge the cases open; Аня (the fixtures' default viewer) is its author. */
const WORKFLOW_ID = fixtureId(61);
const WORKFLOW_NAME = 'Разбор ошибок оплаты';
const WORKFLOW = {
  id: WORKFLOW_ID,
  kind: 'workflow',
  name: WORKFLOW_NAME,
  description: 'Ищет причины ошибок оплаты',
  content: workflowContent({ selfLearning: true }),
} as const;
const KNOWLEDGE = `/api/library/${WORKFLOW_ID}/knowledge`;
const BILLING = { id: 1, name: 'billing-api' };
const TEAM = { id: 2, name: 'команда Платежи' };

/** Row boundary inside a long scenario: the toasts and the handlers the row stacked do not reach the next row. */
function resetRow(): void {
  toast.dismiss();
  server.resetHandlers();
}

const apiError = (status: number, message: string, errorCode?: string): Response =>
  HttpResponse.json({ statusCode: status, message, ...(errorCode === undefined ? {} : { errorCode }) }, { status });

type Answer = () => Response;

/** The viewer and the shell's thread list, read by every screen. */
function serveViewer(viewer: CurrentUser): void {
  server.use(
    http.get(`${API}/api/auth/me`, () => HttpResponse.json(viewer)),
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
  );
}

/**
 * The viewer, the shell's thread list and the two reads of the knowledge screen: the record by the route of its
 * place (`library` — the employee's, `panel` — the administrator's) and the graph by its one route (KD-1). The
 * editor reads only the record, so `graph` is left out there.
 */
function serveKnowledge({
  viewer = currentUser(),
  at = 'library',
  record,
  graph,
}: {
  viewer?: CurrentUser;
  at?: 'library' | 'panel';
  record: Answer;
  graph?: Answer;
}): void {
  serveViewer(viewer);
  server.use(http.get(`${API}${at === 'library' ? '/api/library' : '/api/admin/library'}/:id`, () => record()));
  if (graph !== undefined) server.use(http.get(`${API}/api/library/:id/knowledge`, () => graph()));
}

/** «METHOD path» of the record's and the graph's requests (both places) since request number `from`, in the order sent. */
const knowledgeRequestsSince = ({ requests }: TrackedRequests, from: number): string[] =>
  requests
    .slice(from)
    .filter((request) => request.path.startsWith('/api/library/') || request.path.startsWith('/api/admin/library/'))
    .map((request) => `${request.method} ${request.path}`);

/** The keys (`${type}:${id}`) of the table's rows in display order; a row collapsing after a re-read is not counted. */
const rowKeys = (table: HTMLElement): (string | null)[] =>
  Array.from(table.querySelectorAll('tbody tr[data-row-key]:not([data-leaving])'), (row) => row.getAttribute('data-row-key'));

/** The cells of row `key` as their text. */
function rowCells(table: HTMLElement, key: string): string[] {
  const row = table.querySelector(`tr[data-row-key="${key}"]`);
  if (row === null) throw new Error(`no knowledge row «${key}»`);
  return Array.from(row.querySelectorAll('td'), (cell) => cell.textContent ?? '');
}

/** The labels of the list's tabs, in order. */
const tabLabels = (): (string | null)[] =>
  within(screen.getByRole('main'))
    .getAllByRole('tab')
    .map((tab) => tab.textContent);

/** Texts of the records the «Не найдено» rows' graph holds: none may reach the screen. */
const ITEM_TEXTS = ['billing-api', 'команда Платежи', 'logs.search', 'ошибки оплаты', 'инциденты оплаты'];

/** DC-2, AC-11.3: the «Не найдено» screen names nothing of the workflow and shows none of its records. */
function expectNothingOfTheWorkflow(): void {
  for (const text of [WORKFLOW_NAME, ...ITEM_TEXTS]) {
    expect(document.body.textContent).not.toContain(text);
    expect(document.title).not.toContain(text);
  }
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
}

describe('self-learning / web - integration (jsdom + MSW)', () => {
  // AC: AC-10.1 "Автор workflow включает флажок «Самообучение» в редакторе и сохраняет его вместе с остальной формой"
  // Behavior: author opens the saved workflow with the flag off -> ticks only «Самообучение» -> the form turns «Изменено» and «Сохранить»
  //   becomes available -> «Сохранить» sends `PUT /api/library/:id` whose body has `selfLearning: true` and the version the edit started
  //   from -> the editor reopened shows the flag ticked with the link «Что узнал workflow» under it.
  // Verification items:
  // - before the click «Сохранить» is unavailable (`aria-disabled`); right after it the panel says «Есть несохранённые изменения» and
  //   «Сохранить» is available (nothing else was touched)
  // - exactly one PUT, its body is the whole definition with `content.selfLearning === true` and `version: 2`, the version the edit
  //   started from
  // - after the save the panel says «Сохранено» and no unsaved changes; a fresh open shows the checkbox ticked and the link to
  //   `/library/<id>/knowledge`; unticking it there shows the MC-1 note that the knowledge is kept
  // Catches: the flag silently not saved because the editor's explicit changed-fields list (`workflowChanges`) ignores it, so «Сохранить»
  //   stays disabled after the only change (DC-1, the design's main risk) - no unit row sees the real form wiring, and no server test
  //   sees a PUT that was never sent.
  // @category: core-functionality
  // @dependency: RecordEditor, useRecordForm, WorkflowFields, SelfLearningField, workflowChanges, libraryApi, ShellLink, MSW, next/navigation mock
  // @complexity: medium
  it('INT-1: ticking only «Самообучение» makes the form changed and the saved PUT carries selfLearning: true', async () => {
    const user = userEvent.setup({ delay: null });
    const api = trackRequests(server);
    const unsaved = 'Есть несохранённые изменения';
    const kept = 'Знания сохранятся: включите снова — запуски продолжат с них.';

    // Arrange: Аня's saved workflow at version 2 with the flag off; the record read answers what the last PUT saved
    let held: RecordDetail = recordDetail({ ...WORKFLOW, version: 2, content: workflowContent({ selfLearning: false }) });
    serveKnowledge({ record: () => HttpResponse.json(held) });
    server.use(
      http.get(`${API}/api/library/choices`, () =>
        HttpResponse.json({ servers: ['logs'], defaultModel: 'anthropic/claude-haiku-4-5', defaultMaxTurns: 40 } satisfies LibraryChoices),
      ),
      http.get(`${API}/api/auth/me/roles`, () => HttpResponse.json([] satisfies MyRoleList)),
      http.put(`${API}/api/library/:id`, () => {
        held = recordDetail({ ...WORKFLOW, version: 3, content: workflowContent({ selfLearning: true }) });
        return HttpResponse.json(held);
      }),
    );
    let view = renderWithRuntime({ pathname: `/library/${WORKFLOW_ID}` });
    const flag = await screen.findByRole('checkbox', { name: 'Самообучение' });
    const panel = screen.getByRole('region', { name: 'Сохранение' });
    const save = within(panel).getByRole('button', { name: 'Сохранить' });
    expect(flag).not.toBeChecked();
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(within(panel).queryByText(unsaved)).toBeNull();

    // Act: tick only «Самообучение»
    await user.click(flag);

    // Assert (DC-1): the only change makes the form changed and «Сохранить» available
    expect(flag).toBeChecked();
    expect(within(panel).getByText(unsaved)).toBeInTheDocument();
    expect(save).toHaveAttribute('aria-disabled', 'false');

    // Act: «Сохранить»
    const mark = api.requests.length;
    await user.click(save);

    // Assert (AC-10.1): one PUT with the whole definition, the flag on and the version the edit started from; the form is clean
    expect(await within(panel).findByText('Сохранено')).toBeInTheDocument();
    expect(within(panel).queryByText(unsaved)).toBeNull();
    await waitFor(() =>
      expect(
        api.requests
          .slice(mark)
          .filter((request) => request.method === 'PUT')
          .map(({ path, body }) => ({ path, body })),
      ).toEqual([
        {
          path: `/api/library/${WORKFLOW_ID}`,
          body: {
            kind: 'workflow',
            name: WORKFLOW_NAME,
            description: WORKFLOW.description,
            content: workflowContent({ selfLearning: true }),
            version: 2,
          },
        },
      ]),
    );
    view.unmount();

    // Act: open the editor again; the record read returns what was saved
    view = renderWithRuntime({ pathname: `/library/${WORKFLOW_ID}` });

    // Assert: the flag is ticked and the link leads to the library's knowledge screen
    const reopened = await screen.findByRole('checkbox', { name: 'Самообучение' });
    expect(reopened).toBeChecked();
    expect(screen.getByRole('link', { name: 'Что узнал workflow' })).toHaveAttribute('href', `/library/${WORKFLOW_ID}/knowledge`);
    expect(screen.queryByText(kept)).toBeNull();

    // Act + Assert (MC-1): unticking the saved flag tells that the knowledge is kept, and the change is saveable
    await user.click(reopened);
    expect(reopened).not.toBeChecked();
    expect(screen.getByText(kept)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Сохранение' })).getByRole('button', { name: 'Сохранить' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    view.unmount();
  });

  // AC: AC-11.1 "Автор открывает экран «Что узнал workflow» со списком записей и строками состояния"; AC-11.3 "Чужой или несуществующий
  //   workflow открывается как «Не найдено»"; AC-11.4, AC-11.5, AC-06.1, AC-16.1 (UC-2); AC-09.1, AC-09.3 (доступ к графу по праву на workflow)
  // Behavior: rows, one test with `resetRow()` between them:
  //   row A (author, library, self-learning on, `selection` `on`): open `/library/<id>/knowledge` -> the record and the graph are read in
  //     parallel -> `h1` «Что узнал «{имя}»» in focus; status line 1 names `always` out of `active` and `percent` taken from `counts`,
  //     status line 2 is the MC-3 variant about records shown only by topic with the number 2 (`counts.beyond`); no line about selection by
  //     meaning; tabs with counts, the table in the order `core` sent; the lesson shows `logs.search` and 3; the two `by_topic` records
  //     carry «только по теме» and the fifth tab «Только по теме · 2» shows them; no employee name, no run link.
  //   row B (library, graph 403 KNOWLEDGE_FORBIDDEN): the existing «Не найдено» screen RV-02, no workflow name, no record rows.
  //   row C (panel, record read 404): the existing «Не найдено» screen AD-15, no workflow name, no record rows.
  // Verification items:
  // - exactly two GETs on open: the record and `/api/library/:id/knowledge`, no admin-only route for the library variant
  // - row A: `h1` has focus; the status-line numbers (`always`, `active`, `percent`, 2), the tab counts and the «только по теме» marks come
  //   from the scripted `state` / `placement` / `counts` (literal numbers in the assertions); the document has no selection line and no
  //   «не помещается» mark (the selection-off branch is the unit table, not a row here)
  // - rows B and C render the same screen the app shows for a missing record, with no knowledge row text anywhere in the document
  // Catches: the screen taking the numbers of the status lines and tabs by counting the loaded items instead of reading `counts` (they
  //   differ when `core` sends a longer graph than the screen lists), or the new `state` / `placement` / `selection` fields dropped on the
  //   way from the real response through `libraryApi` and the `contracts` schema (marks and fifth tab then silently missing); and
  //   the graph screen drawn from a 403 as a generic error (naming the workflow or showing «Повторить») instead of the «Не найдено»
  //   screen, or opening the wrong screen at all because the new `knowledge` page kind is shadowed by the existing one-segment route
  //   (`/library/<id>/knowledge` used to open the library list) - the real route + two reads + error mapping meet only here.
  // @category: core-functionality
  // @dependency: parseShellRoute, MainView, LibrarySection, AdminScreen, KnowledgePage, KnowledgeList, knowledge-view, libraryApi, adminApi.library, isKnowledgeHidden, ThreadNotice, useResource, MSW, next/navigation mock
  // @complexity: high
  it('INT-2: the knowledge screen opens for the author with counts from the server, «только по теме» marks and tab and no selection line, and a 404 or 403 KNOWLEDGE_FORBIDDEN shows the existing «Не найдено» screen', async () => {
    const user = userEvent.setup({ delay: null });
    const api = trackRequests(server);

    // Arrange (row A): the author's workflow; `core` counts 126 active records while the screen lists five, so a number counted from
    //   `items` cannot pass; two records reach runs only by topic
    const graph = knowledgeView({
      selection: { state: 'on' },
      counts: { active: 126, always: 64, beyond: 2, outdated: 0, percent: 180 },
      items: [
        knowledgeEntity({ id: 1, confirmations: 4, placement: 'always' }),
        knowledgeEntity({ id: 2, name: TEAM.name, description: 'Владеет сервисом списаний', placement: 'by_topic' }),
        knowledgeFact({ id: 1, from: TEAM, to: BILLING, placement: 'always' }),
        knowledgeLesson({ id: 2, confirmations: 3, placement: 'always' }),
        knowledgeSearchedNothing({ id: 3, placement: 'by_topic' }),
      ],
    });
    serveKnowledge({ record: () => HttpResponse.json(recordDetail(WORKFLOW)), graph: () => HttpResponse.json(graph) });
    let mark = api.requests.length;
    let view = renderWithRuntime({ pathname: `/library/${WORKFLOW_ID}/knowledge` });

    // Assert (row A): the `h1` takes focus; exactly the record and the graph were read, and nothing of the panel
    const title = await screen.findByRole('heading', { level: 1, name: `Что узнал «${WORKFLOW_NAME}»` });
    await waitFor(() => expect(title).toHaveFocus());
    expect(knowledgeRequestsSince(api, mark).sort()).toEqual([`GET /api/library/${WORKFLOW_ID}`, `GET ${KNOWLEDGE}`]);
    expect(api.adminCount()).toBe(0);
    expect(screen.getByRole('link', { name: 'Открыть workflow' })).toHaveAttribute('href', `/library/${WORKFLOW_ID}`);

    // Assert (row A, MC-3): lines 1-2 carry `counts` as the server gave them; no selection line, no «не помещается» anywhere
    expect(
      screen.getByText('При любом вопросе запуски получают 64 из 126 записей · знания занимают 180% места'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Ещё 2 — только по теме вопроса: до половины места запуск отдаёт записям, ближайшим по смыслу к вопросу, остальное — самым подтверждённым, а среди равных — самым новым.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Отбор по смыслу/)).toBeNull();
    expect(screen.queryByText(/не помеща/)).toBeNull();

    // Assert (row A, MC-4): tabs with the counts of the listed records and the fifth «Только по теме»; rows in the order `core` sent;
    //   the lesson shows its tool and 3 confirmations; the two `by_topic` records carry «только по теме»
    expect(tabLabels()).toEqual(['Все · 5', 'Факты · 3', 'Уроки · 1', 'Искал — не нашёл · 1', 'Только по теме · 2']);
    const all = screen.getByRole('table', { name: 'Все · 5' });
    expect(rowKeys(all)).toEqual(['entity:1', 'entity:2', 'relation:1', 'relation:2', 'relation:3']);
    expect(rowCells(all, 'relation:2').slice(0, 3)).toEqual([
      'logs.search · ошибки оплатыИскать в логах billing-api — ошибки нашлись',
      'рабочий урок',
      '3',
    ]);
    expect(within(all).getAllByText('только по теме').map((badge) => badge.closest('tr')?.getAttribute('data-row-key'))).toEqual([
      'entity:2',
      'relation:3',
    ]);
    await user.click(screen.getByRole('tab', { name: 'Только по теме · 2' }));
    expect(rowKeys(await screen.findByRole('table', { name: 'Только по теме · 2' }))).toEqual(['entity:2', 'relation:3']);

    // Assert (row A, AC-11.4): neither the employee nor a run is named on the screen
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent('Аня Смирнова');
    expect(main.querySelectorAll('a[href^="/agents/"], a[href^="/chat/"]')).toHaveLength(0);
    view.unmount();

    // Arrange (row B): Борис sees the workflow (shared with his role), but its knowledge is closed to him: the graph answers 403
    resetRow();
    serveKnowledge({
      viewer: currentUser({ id: fixtureId(2), email: 'boris@corp.example', name: 'Борис Петров' }),
      record: () =>
        HttpResponse.json(
          recordDetail({
            ...WORKFLOW,
            mine: false,
            audience: { roles: [{ id: fixtureId(100), name: 'SRE', member: true }] },
            canEdit: false,
            canShare: false,
            canDelete: false,
          }),
        ),
      graph: () => apiError(403, 'Knowledge is closed to the viewer', LibraryErrorCode.KNOWLEDGE_FORBIDDEN),
    });
    mark = api.requests.length;
    view = renderWithRuntime({ pathname: `/library/${WORKFLOW_ID}/knowledge` });

    // Assert (row B): the library's RV-02 «Не найдено», focus on its `h1`; nothing of the workflow, no «Повторить»
    const libraryNotFound = await screen.findByRole('heading', { level: 1, name: 'Не найдено' });
    await waitFor(() => expect(libraryNotFound).toHaveFocus());
    expect(libraryNotFound.closest('section')?.textContent).toBe(
      'Не найденоТакого агента или workflow нет: его удалили, закрыли для вас или ссылка неверна.В библиотеку',
    );
    await waitFor(() =>
      expect(knowledgeRequestsSince(api, mark).sort()).toEqual([`GET /api/library/${WORKFLOW_ID}`, `GET ${KNOWLEDGE}`]),
    );
    expectNothingOfTheWorkflow();
    view.unmount();

    // Arrange (row C): the administrator in the panel; the record is gone (404) while the graph still answers with records
    resetRow();
    serveKnowledge({
      viewer: currentUser({ id: fixtureId(3), email: 'igor@corp.example', name: 'Игорь Петров', isAdmin: true }),
      at: 'panel',
      record: () => apiError(404, 'Record not found', LibraryErrorCode.RECORD_NOT_FOUND),
      graph: () => HttpResponse.json(graph),
    });
    mark = api.requests.length;
    view = renderWithRuntime({ pathname: `/admin/library/${WORKFLOW_ID}/knowledge` });

    // Assert (row C): the panel's AD-15 «Запись не найдена»; the record by the panel's route, the graph by the one library route
    const panelNotFound = await screen.findByRole('heading', { level: 1, name: 'Запись не найдена' });
    await waitFor(() => expect(panelNotFound).toHaveFocus());
    expect(panelNotFound.closest('section')?.textContent).toBe(
      'Запись не найденаВозможно, её удалили, или ссылка указана неверно.К списку',
    );
    expect(screen.getByRole('link', { name: 'К списку' })).toHaveAttribute('href', '/admin/library');
    await waitFor(() =>
      expect(knowledgeRequestsSince(api, mark).sort()).toEqual([`GET /api/admin/library/${WORKFLOW_ID}`, `GET ${KNOWLEDGE}`]),
    );
    expectNothingOfTheWorkflow();
    view.unmount();
  });

  // AC: AC-11.2 "Автор удаляет запись знаний, после подтверждения она уходит из списка"; AC-09.2 "Удаление записи знаний убирает её
  //   насовсем (сущность уносит свои связи-факты)"
  // Behavior: on the knowledge screen with one entity and two fact relations that have it as an end, the author picks «Удалить» in the
  //   entity's row menu -> the dialog names «2» relations -> confirms -> exactly one `DELETE …/knowledge/entities/:entityId`, answered
  //   204 -> the graph is read again (the scripted answer has neither the entity nor its relations, and holds a record another run added
  //   meanwhile, which only a re-read can show) -> the rows are gone, the toast says «Удалено вместе со связями: 2».
  // Verification items:
  // - the request log has exactly one DELETE (no per-relation DELETEs) and, after it, exactly one more GET of the graph
  // - the list after the re-read has no entity and no relation rows; tab counts follow the new answer
  // - the toast text equals «Удалено вместе со связями: 2» (count taken from the loaded relations)
  // - a DELETE answered 500 (separate short row, on the lesson: the relations' route) leaves the dialog open with «Не удалось удалить:
  //   {причина}», sends no re-read and leaves the row in place
  // Catches: removing the row locally without re-reading (showing what the server may not have), sending a DELETE per cascaded relation, or
  //   a wrong count in the toast (DC-3) - none of these is visible to the server's cascade test.
  // @category: core-functionality
  // @dependency: KnowledgeList, DataTable (row menu), ConfirmDialog, libraryApi.deleteKnowledgeEntity, knowledge-view (relation count), useResource, toast, trackRequests, MSW
  // @complexity: high
  it('INT-3: confirmed delete sends exactly one DELETE, re-reads the graph and drops the entity with its relations', async () => {
    const user = userEvent.setup({ delay: null });
    const api = trackRequests(server);

    // Arrange: «billing-api» is an end of two relation facts; the server's graph changes only when the DELETE arrives, and its next
    //   answer also holds «ledger-db», which another run added meanwhile - only a re-read can put that row on the screen
    const team = knowledgeEntity({ id: 2, name: TEAM.name, description: 'Владеет сервисом списаний' });
    const lesson = knowledgeLesson({ id: 3 });
    const before = knowledgeView({
      counts: { active: 5, always: 5, beyond: 0, outdated: 0, percent: 40 },
      items: [
        knowledgeEntity({ id: 1 }),
        team,
        knowledgeFact({ id: 1, from: TEAM, to: BILLING }),
        knowledgeFact({ id: 2, from: BILLING, to: TEAM, label: 'шлёт отчёты' }),
        lesson,
      ],
    });
    const after = knowledgeView({
      counts: { active: 3, always: 3, beyond: 0, outdated: 0, percent: 25 },
      items: [team, knowledgeEntity({ id: 4, name: 'ledger-db', description: 'База проводок' }), lesson],
    });
    let held = before;
    serveKnowledge({ record: () => HttpResponse.json(recordDetail(WORKFLOW)), graph: () => HttpResponse.json(held) });
    server.use(
      http.delete(`${API}/api/library/:id/knowledge/entities/:entityId`, () => {
        held = after;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithRuntime({ pathname: `/library/${WORKFLOW_ID}/knowledge` });
    const table = await screen.findByRole('table', { name: 'Все · 5' });
    expect(rowKeys(table)).toEqual(['entity:1', 'entity:2', 'relation:1', 'relation:2', 'relation:3']);

    // Act: «Удалить» in the entity's row menu; the dialog names the two relations; nothing is sent before the confirmation
    let mark = api.requests.length;
    await user.click(within(table).getByRole('button', { name: 'Действия: billing-api' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Удалить' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Удалить «billing-api»?' });
    expect(dialog).toHaveTextContent(
      'Вместе с ней удалятся связи: 2. Следующие шаги запусков их уже не получат. Вернуть нельзя — workflow может узнать это снова.',
    );
    expect(knowledgeRequestsSince(api, mark)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));

    // Assert (KD-5, DC-3): the notice counts the loaded relations; the rows are what the re-read returned
    expect(await screen.findByText('Удалено вместе со связями: 2')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(rowKeys(screen.getByRole('table', { name: 'Все · 3' }))).toEqual(['entity:2', 'entity:4', 'relation:3']));
    expect(tabLabels()).toEqual(['Все · 3', 'Факты · 2', 'Уроки · 1', 'Искал — не нашёл · 0']);

    // Assert (KD-5): exactly one DELETE to the entity's route (none per relation), then exactly one read of the graph, not of the record
    expect(knowledgeRequestsSince(api, mark)).toEqual([`DELETE ${KNOWLEDGE}/entities/1`, `GET ${KNOWLEDGE}`]);

    // Act (short row): the lesson's DELETE goes to the relations' route and is refused 500
    server.use(
      http.delete(`${API}/api/library/:id/knowledge/relations/:relationId`, () => apiError(500, 'Knowledge store unavailable')),
    );
    mark = api.requests.length;
    const reread = screen.getByRole('table', { name: 'Все · 3' });
    await user.click(within(reread).getByRole('button', { name: 'Действия: logs.search · ошибки оплаты' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Удалить' }));
    const refused = await screen.findByRole('alertdialog', { name: 'Удалить запись?' });
    expect(refused).toHaveTextContent(
      '«logs.search · ошибки оплаты». Следующие шаги запусков её уже не получат. Вернуть нельзя — workflow может узнать это снова.',
    );
    await user.click(within(refused).getByRole('button', { name: 'Удалить' }));

    // Assert (short row, Flow 3): the dialog stays open with MC-6; one DELETE and no re-read; the row is in place; the refusal is logged
    //   with numbers only
    expect(await within(refused).findByText('Не удалось удалить: Knowledge store unavailable')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog', { name: 'Удалить запись?' })).toBe(refused);
    expect(knowledgeRequestsSince(api, mark)).toEqual([`DELETE ${KNOWLEDGE}/relations/3`]);
    expect(rowKeys(reread)).toEqual(['entity:2', 'entity:4', 'relation:3']);
    expect(logRecords.filter((record) => record.message === 'library: knowledge delete: refused').map((record) => record.fields)).toEqual([
      expect.objectContaining({ recordId: WORKFLOW_ID, type: 'relation', id: 3, outcome: 'refused', method: 'DELETE', status: 500 }),
    ]);
  });

  // AC: AC-12.1 "Администратор задаёт место для знаний и включает или выключает уроки в панели"
  // Behavior: the administrator opens the «Системные» tab -> `GET /api/admin/knowledge/settings` fills the form -> enters 12000, unticks
  //   «Давать запускам уроки», presses «Сохранить» -> `PUT /api/admin/knowledge/settings` with `{ limitTokens: 12000, lessonsEnabled: false }`
  //   -> the notice MC-8 -> the form re-reads the settings and starts again from the saved values (its key is `updatedAt`).
  // Verification items:
  // - the PUT body is exactly `{ limitTokens: 12000, lessonsEnabled: false }`, one request, both values on one «Сохранить», then exactly
  //   one GET of the settings
  // - after the re-read the field shows 12000, the checkbox is unticked and «Сохранить» is unavailable again (the form compares with the
  //   re-read values, not the first ones)
  // - a short row: a server 400 VALIDATION_FAILED shows the form error «Не удалось сохранить: {причина}», keeps the typed values and reads
  //   nothing again (the out-of-bounds field rule itself is the unit table `knowledgeSettingsRules`, not repeated here)
  // Catches: the lessons switch not reaching the request (a checkbox held outside the form values, as `AdminForm` has no checkbox field),
  //   or the settings form saving only the cap - the one place the real `AdminForm`, the checkbox and the route meet.
  // @category: core-functionality
  // @dependency: KnowledgeSettingsForm, AdminForm, Checkbox, adminApi.knowledge, useResource, AdminScreen (tab «Системные»), toast, trackRequests, MSW
  // @complexity: medium
  it('INT-4: admin settings save the size cap and the lessons switch in one PUT and show the saved values', async () => {
    const user = userEvent.setup({ delay: null });
    const api = trackRequests(server);
    const SETTINGS = '/api/admin/knowledge/settings';

    // Arrange: the administrator on «Системные»; the settings stand at their defaults (8000, lessons on) until a PUT is accepted
    let held = knowledgeSettings();
    let putAnswer: Answer = () => {
      held = knowledgeSettings({ limitTokens: 12000, lessonsEnabled: false, updatedAt: fixtureTime(60) });
      return HttpResponse.json(held);
    };
    serveViewer(currentUser({ id: fixtureId(3), email: 'igor@corp.example', name: 'Игорь Петров', isAdmin: true }));
    server.use(
      http.get(`${API}/api/admin/library/system`, () => HttpResponse.json([] satisfies RecordSummary[])),
      http.get(`${API}/api/admin/library/settings`, () =>
        HttpResponse.json({ defaultMaxTurns: 40, updatedAt: null } satisfies LibrarySettings),
      ),
      http.get(`${API}${SETTINGS}`, () => HttpResponse.json(held)),
      http.put(`${API}${SETTINGS}`, () => putAnswer()),
    );
    /** The settings' requests since request number `from`, in the order sent; a GET carries no body (`null`). */
    const settingsSince = (from: number): { method: string; body: unknown }[] =>
      api.requests
        .slice(from)
        .filter((request) => request.path === SETTINGS)
        .map(({ method, body }) => ({ method, body }));
    renderWithRuntime({ pathname: '/admin/library' });

    // Two forms of the tab have «Сохранить»: everything is looked up inside this section
    const section = await screen.findByRole('region', { name: 'Самообучение workflow' });
    const form = within(section);
    expect(screen.getByRole('tab', { name: 'Системные' })).toHaveAttribute('aria-selected', 'true');
    const limit = await form.findByRole('textbox', { name: 'Место для знаний в запуске, токенов' });
    expect(limit).toHaveValue('8000');
    expect(form.getByRole('checkbox', { name: 'Давать запускам уроки' })).toBeChecked();
    expect(form.getByRole('button', { name: 'Сохранить' })).toBeDisabled();

    // Act: 12000, lessons off, one «Сохранить»
    await user.clear(limit);
    await user.type(limit, '12000');
    await user.click(form.getByRole('checkbox', { name: 'Давать запускам уроки' }));
    let mark = api.requests.length;
    await user.click(form.getByRole('button', { name: 'Сохранить' }));

    // Assert (AC-12.1, DC-5): MC-8; one PUT with both values, then one re-read
    expect(await screen.findByText('Настройки самообучения сохранены')).toBeInTheDocument();
    await waitFor(() =>
      expect(settingsSince(mark)).toEqual([
        { method: 'PUT', body: { limitTokens: 12000, lessonsEnabled: false } },
        { method: 'GET', body: null },
      ]),
    );

    // Assert (Flow 4): the form starts again from the re-read values, so nothing is left to save
    await waitFor(() => expect(form.getByRole('button', { name: 'Сохранить' })).toBeDisabled());
    expect(form.getByRole('textbox', { name: 'Место для знаний в запуске, токенов' })).toHaveValue('12000');
    expect(form.getByRole('checkbox', { name: 'Давать запускам уроки' })).not.toBeChecked();

    // Act (short row): 20000 passes the form's rule, the server refuses it 400 VALIDATION_FAILED
    putAnswer =() => apiError(400, 'limitTokens exceeds the model context', 'VALIDATION_FAILED');
    const refusedLimit = form.getByRole('textbox', { name: 'Место для знаний в запуске, токенов' });
    await user.clear(refusedLimit);
    await user.type(refusedLimit, '20000');
    mark = api.requests.length;
    await user.click(form.getByRole('button', { name: 'Сохранить' }));

    // Assert (short row): the reason in the form's error; the typed value stays; one PUT and no re-read
    expect(await form.findByRole('alert')).toHaveTextContent('Не удалось сохранить: limitTokens exceeds the model context');
    expect(refusedLimit).toHaveValue('20000');
    expect(form.getByRole('checkbox', { name: 'Давать запускам уроки' })).not.toBeChecked();
    await waitFor(() =>
      expect(settingsSince(mark)).toEqual([{ method: 'PUT', body: { limitTokens: 20000, lessonsEnabled: false } }]),
    );
  });
});
