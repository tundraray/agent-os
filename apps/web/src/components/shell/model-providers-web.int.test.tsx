// model-providers / web - integration test skeletons (Vitest + RTL + MSW 2, jsdom)
// Design Doc: docs/features/model-providers/design-web.md (v1.0), Test Strategy UC-1, UC-2, UC-4, UC-E1, UC-E2;
//   upstream contract: docs/features/model-providers/design-core.md ("Для части web");
//   PRD: docs/features/model-providers/prd.md FR-12, FR-13, FR-14; UXRD: docs/features/model-providers/uxrd.md.
// Generated: 2026-11-20 | Budget Used: 5/5 integration skeletons (INT-1 .. INT-5): the default 3 plus 2 extra, each naming a defect no other
//   test catches (see "Catches"). The design lists six automated cases (UC-1, UC-2, UC-3, UC-4, UC-E1, UC-E2): UC-3 is dropped (below).
//   0/2 E2E: the repo has no browser tool, so the design's «L1-сценарии в браузере» table stays the manual real-browser acceptance, as in
//   custom-agents-web, self-learning-web and agent-platform-web.
// Test Type: Integration. All five cases are implemented (work plan Tasks 7.1-7.3).
//
// Harness (src/test/, same as self-learning-web.int.test.tsx and enterprise-access-admin.int.test.tsx):
//   `renderWithRuntime({ pathname })` from '@/test/render-with-runtime' mounts ChatRuntimeProvider + ChatShell + Toaster with mocked
//   next/navigation. MSW server from '@/test/msw-server' (`onUnhandledRequest: 'error'`: a request a screen must NOT send fails the test);
//   `trackRequests`, `expectNowhere` (sweeps the DOM, inputs, storage and `logRecords`), `loggerModule` from '@/test/admin-support'; fixtures of '@/test/fixtures' (the catalogue model fixture is
//   rebuilt by the response schema of `packages/contracts`, per the design's Fact Disposition P15).
// Mock boundary: network (MSW), next/navigation, the event source of LiveStore, `@/lib/logger`. Real: shell route parsing, `adminApi`,
//   `accessApi`, `libraryApi`, `apiRequest` with its handlers, `useResource`, `ModelsScreen` and its three blocks, `DataTable`, `AdminForm`,
//   `SecretField`, `ConfirmDialog`, `AlertDialog`, `RecordEditor`, toast. Do NOT mock any of them.
//
// Server-side proofs are NOT repeated here: the key is stored and masked (`apiKeyLast4`), a provider with models cannot be deleted
//   (409 MODEL_PROVIDER_HAS_MODELS), an embeddings model on an Anthropic provider is refused, a default must be a model of its purpose, a
//   disabled provider makes `unavailableReason`, the failure reason of an agent run. All belong to `core`'s API tests. Every server answer
//   below is a scripted MSW response; the tests prove what the browser shows, sends and re-reads for it.
//
// Proven by unit tests (NOT repeated here; named for the plan):
//   - `modelUnavailableReason` rows: provider absent / `disabled` / `key_missing` / working (lib/admin/model-providers.test.ts, one table).
//   - Option building of the model pickers and of MP-01 by purpose (chat vs embedding, sorted by provider name, then title) - the same file
//     (this is design UC-3: the filter rule, one table; the PUT of MP-01 is the manual row «Модель и умолчание»).
//   - `modelProviderRules` rows: name, key length 8..512, address (lib/admin/form-rules.test.ts, existing table; the `openai/x is rejected`
//     row is deleted with the rule).
//   - `describeAdminError` rows for `MODEL_PROVIDER_*`, `MODEL_DEFAULT_INVALID` (lib/admin/admin-errors.test.ts, existing table).
//   - `providerReasonText` / `failureReasonText` / `chatFailureText` / `startRefused` / `describeRefusal` / `refusalText`: one row per reason
//     in the existing reason-text tables (MC-9, MC-10, MC-11, MC-12 wording, design Test Strategy closing paragraph).
//   - `formatModel` rows incl. `null` -> «Модель по умолчанию» (lib/agents/format.test.ts, existing table).
//
// `not automated` (design UC-5, UC-6 and the L1 table): the connection check with its result row and announcements (AC-16.1, AC-15.1),
//   the MC-3 confirmation on disabling a provider and the «Нет провайдера» mark (AC-05.4, AC-06.2), focus after dialogs and delete, the MP-01
//   default save, 360 px width and touch targets, light/dark theme.
//
// Supersedes: the catalogue part of INT-2 in `enterprise-access-admin.int.test.tsx` (the row that opens the «Модели» table, creates a model
//   by a whole `anthropic/…` id and checks the `openai/x` rejection). When the work plan implements INT-3 below, that part of INT-2 is rewritten
//   into it and deleted from INT-2; this file does not edit the old test. The rest of INT-2 (accounts, roles, rights) stays.
//
// AC proof map (one proof per AC; DC rows of the design are listed beside):
//   AC-12.1 INT-1 | AC-12.2 INT-1 | AC-01.1 INT-1 | DC-1 INT-1 | AC-12.3 INT-2 | AC-01.3 INT-2 |
//   AC-13.1 INT-3 | AC-13.2 INT-3 | AC-05.1 INT-3 | AC-05.2 INT-3 | AC-05.3 INT-3 | DC-2 INT-3 |
//   AC-14.1 INT-4 | AC-14.2 INT-4 | AC-14.3 INT-4 | DC-3 INT-4 |
//   AC-09.2 INT-5 (wiring) + unit (words) | AC-09.3 INT-5 + unit | AC-09.4 INT-5 + unit | AC-09.5 INT-5 + unit | AC-04.2 INT-5 + unit |
//   AC-02.1 INT-5 + unit | AC-09.1 INT-5 + unit | DC-4 INT-5 | DC-5 INT-5 |
//   AC-13.3 unit (option building) + manual (MP-01 PUT) | AC-06.1 unit + manual |
//   AC-16.1, AC-15.1, AC-05.4, AC-06.2 not automated (design UC-5, UC-6, L1)

import {
  AccessErrorCode,
  CreateCatalogModelBodySchema,
  CreateModelProviderBodySchema,
  LibraryErrorCode,
  ModelProviderErrorCode,
  UpdateModelProviderBodySchema,
  type CatalogModel,
  type HistoryEntry,
  type LibraryChoices,
  type McpServerSummary,
  type ModelProviderKind,
  type ModelProviderView,
  type ModelUnavailableReason,
  type MyModel,
  type MyRoleList,
} from '@agent-os/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { expectNowhere, trackRequests, type TrackedRequests } from '@/test/admin-support';
import {
  agentContent,
  catalogModel,
  conversationView,
  currentUser,
  fixtureId,
  historyEntry,
  modelDefaults,
  modelProviderView,
  recordDetail,
  roleDetail,
  threadList,
  threadSummary,
} from '@/test/fixtures';
import { createTestLiveSource } from '@/test/live-source';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

vi.mock('@/lib/logger', async () => (await import('@/test/admin-support')).loggerModule);

const API = 'http://api.test';

// Support shared by the cases of this file -------------------------------------------------------------------------------------------------

/** Row boundary inside a long scenario: the toasts and the handlers the row stacked do not reach the next row. */
function resetRow(): void {
  toast.dismiss();
  server.resetHandlers();
}

type Sent = { method: string; path: string; body: unknown };

/** The changes (every method but GET) the page sent to `/api/admin/*` since request number `from`, with their JSON bodies. */
const changesSince = ({ requests }: TrackedRequests, from: number): Sent[] =>
  requests
    .slice(from)
    .filter((request) => request.path.startsWith('/api/admin/') && request.method !== 'GET')
    .map(({ method, path, body }) => ({ method, path, body }));

/** KD-1: the three reads of «Модели», sorted; after each change the page makes each of them exactly once. */
const SECTION_READS = ['/api/admin/model-defaults', '/api/admin/model-providers', '/api/admin/models'];

/** The reads of the three resources of «Модели» since request number `from`, sorted. */
const sectionReadsSince = ({ requests }: TrackedRequests, from: number): string[] =>
  requests
    .slice(from)
    .filter((request) => request.method === 'GET' && SECTION_READS.includes(request.path))
    .map((request) => request.path)
    .sort();

/** Since `from` the page sent exactly `sent` (method, path and body literally), then read each of the three resources once. */
async function expectSentThenReread(tracked: TrackedRequests, from: number, sent: Sent[]): Promise<void> {
  await waitFor(() => expect(changesSince(tracked, from)).toEqual(sent));
  await waitFor(() => expect(sectionReadsSince(tracked, from)).toEqual(SECTION_READS));
}

/** The property names of a sent JSON body, sorted: «no `apiKey`» is the absence of the property, not an empty or null value (KD-4). */
function bodyKeys(sent: Sent | undefined): string[] {
  const body = sent?.body;
  return typeof body === 'object' && body !== null ? Object.keys(body).sort() : [];
}

const apiError = (status: number, errorCode: string, message: string, extra: Record<string, unknown> = {}): Response =>
  HttpResponse.json({ statusCode: status, message, errorCode, ...extra }, { status });

/** A contract schema, as far as the fake backend uses it. */
type BodySchema<Body> = { safeParse: (value: unknown) => { success: true; data: Body } | { success: false } };

/** A change's body read with the contract's own schema: another shape is answered `400`, so the row that sent it fails. */
async function withBody<Body>(request: Request, schema: BodySchema<Body>, answer: (body: Body) => Response): Promise<Response> {
  const body = schema.safeParse(await request.json());
  return body.success ? answer(body.data) : apiError(400, 'VALIDATION_FAILED', 'Request body does not match the contract');
}

const DEFAULT_URL: Readonly<Record<ModelProviderKind, string>> = {
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  openai_compatible: 'https://api.openai.com/v1',
};

/**
 * The administrator, the «Модели» reads and the provider changes as an in-memory store behind MSW: a change answers from
 * the store and every read returns it, so what a row shows after a change can only come from the new read. A key is kept
 * only as «set» with its last four characters, as `core` keeps it. No DELETE handler: a case that expects one adds it.
 */
function modelsBackend(providers: ModelProviderView[], models: CatalogModel[] = []) {
  const store = { providers: [...providers], models };
  const handlers = [
    http.get(`${API}/api/auth/me`, () => HttpResponse.json(currentUser({ isAdmin: true, name: 'Игорь Петров' }))),
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
    http.get(`${API}/api/admin/model-defaults`, () => HttpResponse.json(modelDefaults())),
    http.get(`${API}/api/admin/models`, () => HttpResponse.json(store.models)),
    http.get(`${API}/api/admin/model-providers`, () => HttpResponse.json(store.providers)),
    http.post(`${API}/api/admin/model-providers`, ({ request }) =>
      withBody(request, CreateModelProviderBodySchema, (body) => {
        const keyRequired = body.kind !== 'openai_compatible';
        const created = modelProviderView({
          name: body.name,
          kind: body.kind,
          baseUrl: body.baseUrl ?? null,
          effectiveBaseUrl: body.baseUrl ?? DEFAULT_URL[body.kind],
          apiKeySet: body.apiKey !== undefined,
          apiKeyLast4: body.apiKey?.slice(-4) ?? null,
          keyRequired,
          state: keyRequired && body.apiKey === undefined ? 'key_missing' : 'ready',
        });
        store.providers.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
    ),
    http.patch(`${API}/api/admin/model-providers/:name`, ({ params, request }) =>
      withBody(request, UpdateModelProviderBodySchema, (body) => {
        const index = store.providers.findIndex((provider) => provider.name === params.name);
        const found = store.providers[index];
        if (found === undefined) return apiError(404, ModelProviderErrorCode.MODEL_PROVIDER_NOT_FOUND, 'Model provider not found');
        const baseUrl = body.baseUrl === undefined ? found.baseUrl : body.baseUrl;
        const key = body.apiKey === undefined ? {} : { apiKeySet: body.apiKey !== null, apiKeyLast4: body.apiKey?.slice(-4) ?? null };
        const changed = modelProviderView({
          ...found,
          ...key,
          baseUrl,
          effectiveBaseUrl: baseUrl ?? DEFAULT_URL[found.kind],
          enabled: body.enabled ?? found.enabled,
        });
        store.providers[index] = changed;
        return HttpResponse.json(changed);
      }),
    ),
  ];
  return { store, handlers };
}

/** The first four cells of the providers' row `name` as their text: provider and address, type, key, models. */
function providerCells(table: HTMLElement, name: string): string[] {
  const row = table.querySelector(`tr[data-row-key="${name}"]`);
  if (row === null) throw new Error(`no provider row «${name}»`);
  return Array.from(row.querySelectorAll('td'), (cell) => cell.textContent ?? '').slice(0, 4);
}

/** The cells of the catalogue row `id` as their text, the «⋯» cell aside: model and id, provider, purpose, four prices. */
function catalogCells(table: HTMLElement, id: string): string[] {
  const row = table.querySelector(`tr[data-row-key="${id}"]`);
  if (row === null) throw new Error(`no catalogue row «${id}»`);
  return Array.from(row.querySelectorAll('td'), (cell) => cell.textContent ?? '').slice(0, 7);
}

describe('model-providers / web - integration (jsdom + MSW)', () => {
  // AC: AC-12.1 "Администратор добавляет провайдера модели в панели"; AC-12.2 "Администратор меняет провайдера"; AC-01.1 "Ключ провайдера
  //   показывается только концовкой" (DC-1: изменение провайдера без введённого ключа шлёт PATCH без поля apiKey)
  // Behavior: administrator in «Модели» with no providers adds Google Gemini with a key ending `x9Qz` -> body of the first POST carries `apiKey`
  //   -> adds OpenAI-compatible `local` with an address and no key -> body of the second POST has no `apiKey` -> after each write the three
  //   resources of the screen are read again -> row `google` shows «…x9Qz», row `local` «без ключа», both on -> opens «Изменить» of `google`,
  //   changes only the address, presses «Сохранить» -> the dialog showed the group «Ключ» with «Задан», «…x9Qz» and «Заменить: Ключ», and no
  //   input holding the key -> the PATCH body has `baseUrl` and has no `apiKey`.
  // Verification items:
  // - POST 1 body contains `apiKey` equal to the typed value; POST 2 body has no `apiKey` key at all (not an empty string, not null)
  // - the PATCH body has `baseUrl` and no `apiKey` key; the scripted PATCH response is read back and the row keeps «…x9Qz»
  // - the full key text appears nowhere in the DOM after the dialog closes, and in no `logRecords` entry (literal key string in the assertion)
  // - after each of the three writes the log of requests shows one GET of each of the three resources (model-defaults, model-providers, models)
  // Catches: the key travelling in a PATCH the administrator never changed it in (an empty field sent as `apiKey: ""` erases the stored key, the
  //   design's main risk, KD-4), or the key shown back in the dialog; and a block left stale because only its own resource was re-read after a
  //   write (KD-1). No server test sees what the browser puts in the body, and no unit row sees the real `AdminForm` + `SecretField` wiring.
  // @category: core-functionality
  // @dependency: ModelsScreen, ModelProvidersTable, ModelProviderDialog, SecretField, AdminForm, adminApi.modelProviders, useResource, logger, trackRequests, MSW
  // @complexity: high
  it('INT-1: a provider is created with a key, then shown only by its ending; editing with an empty key field sends a PATCH without apiKey', async () => {
    // Arrange: an administrator in «Модели» with no providers and an empty catalogue
    const key = 'AIzaFAKE-int1-gemini-x9Qz';
    const { handlers } = modelsBackend([]);
    server.use(...handlers);
    const api = trackRequests(server);
    const user = userEvent.setup({ delay: null });
    const view = renderWithRuntime({ pathname: '/admin/models' });
    const spies = [view.router.push, view.router.replace, view.assign];
    expect(await screen.findByRole('heading', { level: 1, name: 'Модели' })).toBeInTheDocument();
    expect(await screen.findByText('Провайдеров пока нет')).toBeInTheDocument();

    // Act: «Добавить провайдера» -> Google Gemini (the type puts `google` into «Имя») -> the key -> «Добавить»
    await user.click(screen.getByRole('button', { name: 'Добавить провайдера' }));
    let dialog = await screen.findByRole('dialog', { name: 'Новый провайдер' });
    await user.click(within(dialog).getByRole('radio', { name: 'Google Gemini' }));
    expect(within(dialog).getByLabelText('Имя')).toHaveValue('google');
    await user.type(within(dialog).getByLabelText('Ключ (необязательно)'), key);
    let mark = api.requests.length;
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));

    // Assert: one POST whose body carries the typed key, then one read of each of the three resources
    await expectSentThenReread(api, mark, [
      { method: 'POST', path: '/api/admin/model-providers', body: { name: 'google', kind: 'gemini', apiKey: key } },
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Провайдер google добавлен')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Провайдеры' });
    await waitFor(() =>
      expect(providerCells(table, 'google')).toEqual([
        'googleадрес по умолчанию',
        'Google Gemini',
        '…x9Qzключ заканчивается на x9Qz',
        '0',
      ]),
    );
    expectNowhere(key, { spies });

    // Act: an OpenAI-compatible `local` with an address and an empty key field
    await user.click(screen.getByRole('button', { name: 'Добавить провайдера' }));
    dialog = await screen.findByRole('dialog', { name: 'Новый провайдер' });
    await user.click(within(dialog).getByRole('radio', { name: 'OpenAI-совместимый' }));
    await user.clear(within(dialog).getByLabelText('Имя'));
    await user.type(within(dialog).getByLabelText('Имя'), 'local');
    await user.type(within(dialog).getByLabelText('Адрес (необязательно)'), 'http://vllm.corp:8000/v1');
    mark = api.requests.length;
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));

    // Assert: the second POST has no `apiKey` property at all; the three resources are read again; both rows on
    await expectSentThenReread(api, mark, [
      {
        method: 'POST',
        path: '/api/admin/model-providers',
        body: { name: 'local', kind: 'openai_compatible', baseUrl: 'http://vllm.corp:8000/v1' },
      },
    ]);
    expect(bodyKeys(changesSince(api, mark)[0])).toEqual(['baseUrl', 'kind', 'name']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(providerCells(table, 'local')).toEqual(['localhttp://vllm.corp:8000/v1', 'OpenAI-совместимый', 'без ключа', '0']),
    );
    expect(within(table).getByRole('switch', { name: 'Включён: google' })).toBeChecked();
    expect(within(table).getByRole('switch', { name: 'Включён: local' })).toBeChecked();

    // Act: «Изменить» of `google`: the key is shown only as set with its ending, there is no field holding it
    await user.click(within(table).getByRole('button', { name: 'Действия: google' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Изменить' }));
    dialog = await screen.findByRole('dialog', { name: 'Провайдер google' });
    const keyGroup = within(dialog).getByRole('group', { name: 'Ключ' });
    expect(keyGroup).toHaveTextContent('Задан');
    expect(within(keyGroup).getByText('…x9Qz')).toBeInTheDocument();
    expect(within(keyGroup).getByRole('button', { name: 'Заменить: Ключ' })).toBeInTheDocument();
    expect(dialog.querySelector('input[type="password"]')).toBeNull();
    expectNowhere(key, { spies });

    // Act: only the address changes; «Сохранить» without «Заменить»
    await user.type(within(dialog).getByLabelText('Адрес (необязательно)'), 'https://gemini-proxy.corp.example/v1');
    mark = api.requests.length;
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    // Assert: the PATCH body is exactly `{ baseUrl }` - no `apiKey` property; the three resources are read again; the row keeps the ending
    await expectSentThenReread(api, mark, [
      { method: 'PATCH', path: '/api/admin/model-providers/google', body: { baseUrl: 'https://gemini-proxy.corp.example/v1' } },
    ]);
    expect(bodyKeys(changesSince(api, mark)[0])).toEqual(['baseUrl']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Провайдер google сохранён')).toBeInTheDocument();
    await waitFor(() =>
      expect(providerCells(table, 'google')).toEqual([
        'googlehttps://gemini-proxy.corp.example/v1',
        'Google Gemini',
        '…x9Qzключ заканчивается на x9Qz',
        '0',
      ]),
    );
    expectNowhere(key, { spies });
  });

  // AC: AC-12.3 "Провайдера с моделями каталога удалить нельзя"; AC-01.3 "Отказ удаления называет число моделей"
  // Behavior: rows, one test with `resetRow()` between them:
  //   row A: `google` has `catalogModels: 2` -> «Удалить» in its row menu opens the window «Нельзя удалить «google»» with «Моделей этого
  //     провайдера в каталоге: 2. …» and the single button «Понятно» -> «Понятно» closes it -> the provider row is still in the table.
  //   row B: `local` has `catalogModels: 0` but the server answers the DELETE 409 MODEL_PROVIDER_HAS_MODELS (a model added in another tab) ->
  //     the confirm dialog «Удалить провайдера «local»?» stays open with «Не удалось удалить: у провайдера есть модели в каталоге. Сначала
  //     уберите их.» (MC-5) -> the three resources are read again (the row now counts 1 model) -> the provider row is still there.
  // Verification items:
  // - row A: the request log has no DELETE at all (MSW `onUnhandledRequest: 'error'` would also fail one); the window has exactly one button
  // - row B: exactly one DELETE `/api/admin/model-providers/local`; the dialog is still open with the MC-5 text; one more GET of each resource
  // Catches: «Удалить» sending a DELETE for a provider the table already knows has models (and showing the raw server error instead of the
  //   «Нельзя удалить» window), or closing the confirm dialog on the 409 as if the provider were gone - the list state and the real error
  //   mapping meet only here; the server's 409 itself is proven by `core`.
  // @category: edge-case
  // @dependency: ModelProvidersTable, DataTable (row menu), AlertDialog, ConfirmDialog, describeAdminError, adminApi.modelProviders, useResource, trackRequests, MSW
  // @complexity: medium
  it('INT-2: deleting a provider with catalog models shows the «Нельзя удалить» window and sends no DELETE; a late 409 keeps the confirm dialog open', async () => {
    // Arrange: `google` with two catalogue models, `local` shown without models
    const providers = [
      modelProviderView({
        name: 'google',
        kind: 'gemini',
        effectiveBaseUrl: DEFAULT_URL.gemini,
        apiKeyLast4: 'Gm4k',
        catalogModels: 2,
      }),
      modelProviderView({
        name: 'local',
        kind: 'openai_compatible',
        baseUrl: 'http://vllm.corp:8000/v1',
        effectiveBaseUrl: 'http://vllm.corp:8000/v1',
        apiKeySet: false,
        apiKeyLast4: null,
        keyRequired: false,
      }),
    ];
    const models = [
      catalogModel({ id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }),
      catalogModel({ id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' }),
    ];
    const backend = modelsBackend(providers, models);
    server.use(...backend.handlers);
    const api = trackRequests(server);
    const user = userEvent.setup({ delay: null });
    renderWithRuntime({ pathname: '/admin/models' });
    const table = await screen.findByRole('table', { name: 'Провайдеры' });
    await waitFor(() => expect(providerCells(table, 'google')[3]).toBe('2'));

    // Row A: «Удалить» of `google` opens «Нельзя удалить» with the count and one button; no DELETE is sent
    let mark = api.requests.length;
    await user.click(within(table).getByRole('button', { name: 'Действия: google' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Удалить' }));
    const blocked = await screen.findByRole('alertdialog', { name: 'Нельзя удалить «google»' });
    expect(within(blocked).getByText('Моделей этого провайдера в каталоге: 2. Сначала уберите их из каталога.')).toBeInTheDocument();
    expect(within(blocked).getAllByRole('button').map((button) => button.textContent)).toEqual(['Понятно']);
    await user.click(within(blocked).getByRole('button', { name: 'Понятно' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.requests.slice(mark).filter((request) => request.method === 'DELETE')).toEqual([]);
    expect(changesSince(api, mark)).toEqual([]);
    expect(providerCells(table, 'google')[0]).toBe('googleадрес по умолчанию');

    resetRow();

    // Row B: `local` shows no models, but a model was added in another tab - the server refuses the DELETE with 409
    server.use(
      ...backend.handlers,
      http.delete(`${API}/api/admin/model-providers/:name`, ({ params }) => {
        const local = backend.store.providers.find((provider) => provider.name === params.name);
        if (local !== undefined) local.catalogModels = 1;
        return apiError(409, ModelProviderErrorCode.MODEL_PROVIDER_HAS_MODELS, 'Model provider has catalog models', { count: 1 });
      }),
    );
    mark = api.requests.length;
    await user.click(within(table).getByRole('button', { name: 'Действия: local' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Удалить' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Удалить провайдера «local»?' });
    expect(within(confirm).getByText('Ключ провайдера удалится вместе с ним. Вернуть нельзя.')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Удалить' }));

    // Assert (row B): exactly one DELETE, the dialog stays open with the MC-5 refusal, the three resources are read again
    expect(
      await within(confirm).findByText('Не удалось удалить: у провайдера есть модели в каталоге. Сначала уберите их.'),
    ).toBeInTheDocument();
    await expectSentThenReread(api, mark, [{ method: 'DELETE', path: '/api/admin/model-providers/local', body: null }]);
    expect(screen.getByRole('alertdialog', { name: 'Удалить провайдера «local»?' })).toBe(confirm);
    await waitFor(() =>
      expect(providerCells(table, 'local')).toEqual(['localhttp://vllm.corp:8000/v1', 'OpenAI-совместимый', 'без ключа', '1']),
    );
  });

  // AC: AC-13.1 "Администратор добавляет модель чата провайдера"; AC-13.2 "Модель эмбеддингов — только у провайдера, который их считает";
  //   AC-05.1, AC-05.2, AC-05.3 (модель эмбеддингов в каталоге: цена ввода и размерность) (DC-2)
  // Behavior: providers `anthropic` and `google` exist -> administrator picks `anthropic` in «Добавить модель» -> the purpose radio offers
  //   «Чат» and no «Эмбеддинги» -> picks `google`, «Чат», name `gemini-2.5-flash`, the four prices -> POST -> picks `google`, «Эмбеддинги»,
  //   name `gemini-embedding-001`, input price, dimensions 768 (the form shows no output or cache price field) -> POST -> the catalogue shows a
  //   row with provider `google` and «Эмбеддинги · 768» -> a third `google` model answered 422 MODEL_PROVIDER_INVALID `provider_unknown`, then
  //   `embeddings_not_supported` -> the dialog stays open with the MC-7 form error each time.
  // Verification items:
  // - for `anthropic` the radio has no «Эмбеддинги» option
  // - POST 1 body: `id: "google/gemini-2.5-flash"`, `purpose: "chat"`, the prices; POST 2 body: `id: "google/gemini-embedding-001"`,
  //   `purpose: "embedding"`, `inputUsdPerMTok`, `dimensions: 768`, and none of the output / cache price fields (literal values in the assertions)
  // - the new embedding row shows «Эмбеддинги · 768»; the chat row «Чат»; the list is parsed by the response schema (a fixture of both purposes)
  // - the two 422 answers show «провайдера google больше нет» and «провайдер этого типа не считает эмбеддинги»; the typed values stay in the form
  // Catches: the old whole-id dialog surviving (`anthropic/`-only id rule, a body with four chat prices on an embeddings model, or a bare name
  //   without the provider prefix) - the request body of the dialog is the contract with `core` and only this test sees the real form build it;
  //   and the catalogue list failing to parse an embeddings row. (Supersedes the catalogue part of INT-2 of enterprise-access-admin.)
  // @category: core-functionality
  // @dependency: CatalogSection, ModelDialog, AdminSelectField, adminApi.models, describeAdminError, useResource, trackRequests, MSW
  // @complexity: high
  it('INT-3: the model dialog creates a chat model and an embedding model with the right request bodies and shows the 422 reasons', async () => {
    // Arrange: providers `anthropic` and `google`, an empty catalogue; `POST /api/admin/models` builds the row with the response schema
    const providers = [
      modelProviderView(),
      modelProviderView({ name: 'google', kind: 'gemini', effectiveBaseUrl: DEFAULT_URL.gemini, apiKeyLast4: 'Gm4k' }),
    ];
    const backend = modelsBackend(providers);
    const createModel = http.post(`${API}/api/admin/models`, ({ request }) =>
      withBody(request, CreateCatalogModelBodySchema, (body) => {
        const created = catalogModel(body);
        backend.store.models.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    server.use(...backend.handlers, createModel);
    const api = trackRequests(server);
    const user = userEvent.setup({ delay: null });
    renderWithRuntime({ pathname: '/admin/models' });
    const providersTable = await screen.findByRole('table', { name: 'Провайдеры' });
    await waitFor(() => expect(providerCells(providersTable, 'google')[1]).toBe('Google Gemini'));

    const openDialog = async (): Promise<HTMLElement> => {
      await user.click(screen.getByRole('button', { name: 'Добавить модель' }));
      return screen.findByRole('dialog', { name: 'Добавить модель' });
    };
    const chooseProvider = async (dialog: HTMLElement, option: string): Promise<void> => {
      await user.click(within(dialog).getByRole('combobox', { name: 'Провайдер' }));
      await user.click(await screen.findByRole('option', { name: option }));
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    };
    const field = (dialog: HTMLElement, name: string): HTMLElement => within(dialog).getByRole('textbox', { name });

    // Act: «Добавить модель» -> `anthropic`: the purpose offers «Чат» only
    let dialog = await openDialog();
    await user.click(within(dialog).getByRole('combobox', { name: 'Провайдер' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'anthropic · Anthropic',
      'google · Google Gemini',
    ]);
    await user.click(screen.getByRole('option', { name: 'anthropic · Anthropic' }));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());

    // Assert (AC-13.2): no «Эмбеддинги» radio exists for an Anthropic provider; «Чат» is chosen, the caption says why
    expect(within(dialog).queryByRole('radio', { name: 'Эмбеддинги' })).toBeNull();
    expect(within(dialog).getByRole('radio', { name: 'Чат' })).toBeChecked();
    expect(within(dialog).getByText('У Anthropic нет моделей эмбеддингов.')).toBeInTheDocument();

    // Act: `google`, «Чат», `gemini-2.5-flash`, four prices typed with a comma, no long-request prices
    await chooseProvider(dialog, 'google · Google Gemini');
    expect(within(dialog).getByRole('radio', { name: 'Эмбеддинги' })).not.toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Чат' })).toBeChecked();
    await user.type(field(dialog, 'Имя модели у провайдера'), 'gemini-2.5-flash');
    await user.type(field(dialog, 'Название'), 'Gemini 2.5 Flash');
    await user.type(field(dialog, 'Вход'), '0,3');
    await user.type(field(dialog, 'Выход'), '2,5');
    await user.type(field(dialog, 'Запись в кэш'), '1');
    await user.type(field(dialog, 'Чтение из кэша'), '0,03');
    expect(within(dialog).getByRole('checkbox', { name: 'Другие цены для длинных запросов' })).not.toBeChecked();
    let mark = api.requests.length;
    await user.click(within(dialog).getByRole('button', { name: 'Добавить модель' }));

    // Assert (AC-13.1, DC-2): the chat body is the whole id, `purpose: 'chat'` and the prices - no embedding field; the three resources are read again
    await expectSentThenReread(api, mark, [
      {
        method: 'POST',
        path: '/api/admin/models',
        body: {
          id: 'google/gemini-2.5-flash',
          name: 'Gemini 2.5 Flash',
          purpose: 'chat',
          prices: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5, cacheWriteUsdPerMTok: 1, cacheReadUsdPerMTok: 0.03 },
          longContext: null,
        },
      },
    ]);
    expect(bodyKeys(changesSince(api, mark)[0])).toEqual(['id', 'longContext', 'name', 'prices', 'purpose']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Act: `google`, «Эмбеддинги»: one price and the dimensions, no output or cache price, no long-request prices
    dialog = await openDialog();
    await chooseProvider(dialog, 'google · Google Gemini');
    await user.click(within(dialog).getByRole('radio', { name: 'Эмбеддинги' }));
    for (const absent of ['Выход', 'Запись в кэш', 'Чтение из кэша']) {
      expect(within(dialog).queryByRole('textbox', { name: absent })).toBeNull();
    }
    expect(within(dialog).queryByRole('checkbox', { name: 'Другие цены для длинных запросов' })).toBeNull();
    await user.type(field(dialog, 'Имя модели у провайдера'), 'gemini-embedding-001');
    await user.type(field(dialog, 'Название'), 'Gemini Embedding 001');
    await user.type(field(dialog, 'Вход'), '0,15');
    await user.type(field(dialog, 'Размерность'), '768');
    mark = api.requests.length;
    await user.click(within(dialog).getByRole('button', { name: 'Добавить модель' }));

    // Assert (AC-05.1..AC-05.3, DC-2): the embedding body carries the input price and the dimensions and no chat price field
    await expectSentThenReread(api, mark, [
      {
        method: 'POST',
        path: '/api/admin/models',
        body: {
          id: 'google/gemini-embedding-001',
          name: 'Gemini Embedding 001',
          purpose: 'embedding',
          inputUsdPerMTok: 0.15,
          dimensions: 768,
        },
      },
    ]);
    expect(bodyKeys(changesSince(api, mark)[0])).toEqual(['dimensions', 'id', 'inputUsdPerMTok', 'name', 'purpose']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Assert: the catalogue read back (both purposes, built by the response schema) shows «Чат» and «Эмбеддинги · 768»
    const catalogue = await screen.findByRole('table', { name: 'Каталог моделей' });
    await waitFor(() =>
      expect(catalogCells(catalogue, 'google/gemini-embedding-001')).toEqual([
        'Gemini Embedding 001google/gemini-embedding-001',
        'google',
        'Эмбеддинги · 768',
        '0,15 $',
        '—',
        '—',
        '—',
      ]),
    );
    expect(catalogCells(catalogue, 'google/gemini-2.5-flash')).toEqual([
      'Gemini 2.5 Flashgoogle/gemini-2.5-flash',
      'google',
      'Чат',
      '0,3 $',
      '2,5 $',
      '1 $',
      '0,03 $',
    ]);

    // Act: a third `google` model, refused 422 MODEL_PROVIDER_INVALID with each reason in turn
    dialog = await openDialog();
    await chooseProvider(dialog, 'google · Google Gemini');
    await user.click(within(dialog).getByRole('radio', { name: 'Эмбеддинги' }));
    await user.type(field(dialog, 'Имя модели у провайдера'), 'text-embedding-004');
    await user.type(field(dialog, 'Название'), 'Text Embedding 004');
    await user.type(field(dialog, 'Вход'), '0,1');
    await user.type(field(dialog, 'Размерность'), '768');
    const refusals = [
      {
        reason: 'provider_unknown',
        text: 'Не удалось сохранить: провайдера google больше нет. Закройте окно и откройте его снова.',
      },
      { reason: 'embeddings_not_supported', text: 'Не удалось сохранить: провайдер этого типа не считает эмбеддинги' },
    ];
    for (const refusal of refusals) {
      server.use(
        http.post(
          `${API}/api/admin/models`,
          () => apiError(422, AccessErrorCode.MODEL_PROVIDER_INVALID, 'Model provider invalid', { reason: refusal.reason }),
          { once: true },
        ),
      );
      await user.click(within(dialog).getByRole('button', { name: 'Добавить модель' }));

      // Assert (MC-7): the dialog stays open with the form error, and every typed value is still there
      expect(await within(dialog).findByText(refusal.text)).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Добавить модель' })).toBe(dialog);
      expect(within(dialog).getByRole('combobox', { name: 'Провайдер' })).toHaveTextContent('google · Google Gemini');
      expect(within(dialog).getByRole('radio', { name: 'Эмбеддинги' })).toBeChecked();
      expect(field(dialog, 'Имя модели у провайдера')).toHaveValue('text-embedding-004');
      expect(field(dialog, 'Название')).toHaveValue('Text Embedding 004');
      expect(field(dialog, 'Вход')).toHaveValue('0,1');
      expect(field(dialog, 'Размерность')).toHaveValue('768');
    }
  });

  // AC: AC-14.1 "Выбор модели предлагает только модели чата, с именем провайдера"; AC-14.2 "Диалог права — только модели чата работающих
  //   провайдеров"; AC-14.3 "Запись на модели неработающего провайдера сохраняется" (DC-3)
  // Behavior: employee has rights on Claude Haiku 4.5 (`anthropic`) and Gemini 2.5 Flash (`google`, `unavailableReason: provider_disabled`);
  //   his agent is on Gemini 2.5 Flash -> author opens the editor, expands «Дополнительно» -> «Модель» lists Gemini first, not selectable, with
  //   provider `google` and «провайдер выключен», then Claude Haiku 4.5 with `anthropic`; the banner MC-12 with «Заменить на Claude Haiku 4.5»
  //   -> author edits the instruction, presses «Сохранить» -> the PUT keeps `google/gemini-2.5-flash` and the save succeeds -> administrator
  //   opens «Добавить право» on the role «SRE», «Модель» -> only chat models of working providers are offered, while the catalogue also holds
  //   a chat model of the disabled `google` and an embedding model of the working `local`.
  //   `GET /api/access/models` holds chat models only by its contract, so the web's own purpose filter is proven in the grant dialog.
  // Verification items:
  // - the editor list holds exactly Gemini (first, disabled, with the label) and Claude Haiku 4.5 (selectable, with provider caption)
  // - the PUT body has `model: "google/gemini-2.5-flash"` (the record did not silently switch to Haiku) and the panel reads «Сохранено»
  // - the grant dialog list has no embedding model and no model of the disabled provider
  // - a short row: a model with no right at all keeps today's label «у вас недоступна», a model of the disabled provider is not offered, and
  //   the save is refused 422 `model_not_allowed` at the field
  // Catches: the replaced-model dead end (a record on a disabled provider that cannot be saved until the author swaps the model, or is saved
  //   with a silently changed model), and embedding models leaking into a chat model picker. The readiness rule itself is the unit table
  //   `modelUnavailableReason`; the editor + `unavailableReason` of `GET /api/access/models` + the PUT meet only here.
  // @category: core-functionality
  // @dependency: RecordPage, RecordEditor, ModelField, ModelBanner, GrantForm, accessApi.models, libraryApi, adminApi.models, adminApi.modelProviders, MSW, next/navigation mock
  // @complexity: high
  it('INT-4: model pickers offer chat models with the provider name; a record on a disabled provider keeps its model and still saves', async () => {
    const user = userEvent.setup({ delay: null });
    const api = trackRequests(server);
    const HAIKU = 'anthropic/claude-haiku-4-5';
    const GEMINI = 'google/gemini-2.5-flash';
    const SONNET = 'anthropic/claude-sonnet-4-5';
    const TYPED = 'Собери сводку по инцидентам за неделю.';
    const recordId = fixtureId(51);
    const recordPath = `/api/library/${recordId}`;
    const myModel = (model: string, name: string, unavailableReason: ModelUnavailableReason | null): MyModel => ({
      model,
      name,
      unavailableReason,
      spentUsd: 0,
      quotaUsd: null,
      remainingUsd: null,
      exhausted: false,
    });

    /** The bodies of the `PUT` of the record since request number `from`. */
    const putBodiesSince = (from: number): unknown[] =>
      api.requests
        .slice(from)
        .filter((request) => request.method === 'PUT' && request.path === recordPath)
        .map((request) => request.body);
    /** The answer of the record's `PUT`, switched per row. */
    let putAnswer: () => Response = () => apiError(500, 'UNEXPECTED', 'No PUT expected yet');
    /** The employee's own agent on `model`, his models and choices; `/api/library/choices` comes before `/api/library/:id`. */
    const openEditor = async (model: string) => {
      server.use(
        http.get(`${API}/api/auth/me/roles`, () => HttpResponse.json([] satisfies MyRoleList)),
        http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
        http.get(`${API}/api/library/choices`, () =>
          HttpResponse.json({ servers: ['logs'], defaultModel: HAIKU, defaultMaxTurns: 20 } satisfies LibraryChoices),
        ),
        http.get(`${API}/api/library/:id`, ({ params }) =>
          params['id'] === recordId
            ? HttpResponse.json(recordDetail({ id: recordId, version: 3, content: agentContent({ model }) }))
            : undefined,
        ),
        http.get(`${API}/api/access/models`, () =>
          HttpResponse.json({
            month: '2026-11',
            models: [myModel(HAIKU, 'Claude Haiku 4.5', null), myModel(GEMINI, 'Gemini 2.5 Flash', 'provider_disabled')],
          }),
        ),
        http.put(`${API}/api/library/:id`, () => putAnswer()),
      );
      const view = renderWithRuntime({ pathname: `/library/${recordId}` });
      const prompt = await screen.findByRole('textbox', { name: 'Инструкция' });
      await user.click(screen.getByRole('button', { name: 'Дополнительно: модель, максимум шагов, кого может запускать' }));
      return { view, prompt, panel: screen.getByRole('region', { name: 'Сохранение' }) };
    };
    /** Opens «Модель» and returns its options (the list is in a portal). */
    const modelOptionsShown = async (): Promise<HTMLElement[]> => {
      await user.click(screen.getByRole('combobox', { name: 'Модель' }));
      return screen.findAllByRole('option');
    };
    const closeList = async (): Promise<void> => {
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    };

    // Arrange: his agent is on Gemini 2.5 Flash, whose provider `google` is off; the save answers the saved record
    putAnswer = () =>
      HttpResponse.json(recordDetail({ id: recordId, version: 4, content: agentContent({ model: GEMINI, prompt: TYPED }) }));
    const broken = await openEditor(GEMINI);

    // Assert (AC-14.3, MC-12): the banner names the reason and offers the working default; nothing is replaced by itself
    const banner = await screen.findByText('Провайдер модели Gemini 2.5 Flash выключен — агент не запустится');
    expect(banner.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Заменить на Claude Haiku 4.5' })).toBeInTheDocument();
    const field = screen.getByRole('combobox', { name: 'Модель' });
    await waitFor(() => expect(field).toHaveTextContent('Gemini 2.5 Flash · google'));

    // Assert (AC-14.1, MP-08): the record's own model first, not choosable, with provider and reason; then the working model with its provider
    let options = await modelOptionsShown();
    expect(options.map((option) => option.textContent)).toEqual([
      'Gemini 2.5 Flashgoogleпровайдер выключен',
      'Claude Haiku 4.5anthropic',
    ]);
    expect(options.map((option) => option.getAttribute('aria-label'))).toEqual([
      'Gemini 2.5 Flash, провайдер google, провайдер выключен',
      'Claude Haiku 4.5, провайдер anthropic',
    ]);
    expect(options[0]).toHaveAttribute('aria-disabled', 'true');
    expect(options[1]).not.toHaveAttribute('aria-disabled', 'true');
    await closeList();

    // Act (DC-3, Flow 4): only the instruction changes; «Сохранить»
    await user.clear(broken.prompt);
    await user.type(broken.prompt, TYPED);
    expect(broken.panel).toHaveTextContent('Есть несохранённые изменения');
    let mark = api.requests.length;
    await user.click(within(broken.panel).getByRole('button', { name: 'Сохранить' }));

    // Assert (DC-3): one PUT with the same model and the version the edit started from; the save went through, the form is clean
    expect(await within(broken.panel).findByText('Сохранено')).toBeInTheDocument();
    await waitFor(() =>
      expect(putBodiesSince(mark)).toEqual([
        expect.objectContaining({ version: 3, content: expect.objectContaining({ model: GEMINI, prompt: TYPED }) }),
      ]),
    );
    expect(broken.panel).not.toHaveTextContent('Есть несохранённые изменения');
    expect(screen.getByRole('combobox', { name: 'Модель' })).toHaveTextContent('Gemini 2.5 Flash · google');
    broken.view.unmount();

    // Short row: a model with no right at all keeps today's mark, and the server refuses the save at the field
    resetRow();
    putAnswer = () => apiError(422, LibraryErrorCode.RECORD_REJECTED, 'Record rejected', { reason: 'model_not_allowed' });
    const lost = await openEditor(SONNET);
    expect(await screen.findByText('Модель Sonnet вам больше недоступна — агент не запустится')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Модель' })).toHaveTextContent('Sonnet'));

    // Assert (short row): Sonnet first with «у вас недоступна»; the model of the disabled provider is not offered at all
    options = await modelOptionsShown();
    expect(options.map((option) => option.textContent)).toEqual(['Sonnetу вас недоступна', 'Claude Haiku 4.5anthropic']);
    expect(options[0]).toHaveAttribute('aria-disabled', 'true');
    await closeList();

    // Act (short row): the instruction changes, «Сохранить» -> 422 `model_not_allowed`
    await user.clear(lost.prompt);
    await user.type(lost.prompt, TYPED);
    mark = api.requests.length;
    await user.click(within(lost.panel).getByRole('button', { name: 'Сохранить' }));

    // Assert (short row): the refusal stands at «Модель», the typed instruction stays, the PUT carried Sonnet
    expect(await screen.findByText('Модель Sonnet вам недоступна — выберите другую')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Модель' })).toHaveAttribute('aria-invalid', 'true');
    expect(lost.prompt).toHaveValue(TYPED);
    expect(putBodiesSince(mark)).toEqual([expect.objectContaining({ content: expect.objectContaining({ model: SONNET }) })]);
    lost.view.unmount();

    // Arrange (AC-14.2): the administrator on the role «SRE»; the catalogue holds a chat model of each provider and an embedding model of
    //   the working `local`; `google` is off
    resetRow();
    const SRE = fixtureId(100);
    const providers = [
      modelProviderView(),
      modelProviderView({
        name: 'google',
        kind: 'gemini',
        effectiveBaseUrl: DEFAULT_URL.gemini,
        apiKeyLast4: 'Gm4k',
        enabled: false,
        state: 'disabled',
      }),
      modelProviderView({
        name: 'local',
        kind: 'openai_compatible',
        baseUrl: 'http://vllm.corp:8000/v1',
        effectiveBaseUrl: 'http://vllm.corp:8000/v1',
        apiKeySet: false,
        apiKeyLast4: null,
        keyRequired: false,
      }),
    ];
    const catalogue = [
      catalogModel({ id: HAIKU, name: 'Claude Haiku 4.5' }),
      catalogModel({ id: GEMINI, name: 'Gemini 2.5 Flash' }),
      catalogModel({ id: 'local/qwen-3', name: 'Qwen 3' }),
      catalogModel({ id: 'local/bge-m3', name: 'BGE M3', purpose: 'embedding', inputUsdPerMTok: 0.02, dimensions: 1024 }),
    ];
    server.use(
      http.get(`${API}/api/auth/me`, () => HttpResponse.json(currentUser({ isAdmin: true, name: 'Игорь Петров' }))),
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
      http.get(`${API}/api/admin/roles/:id`, () => HttpResponse.json(roleDetail({ id: SRE, name: 'SRE' }))),
      http.get(`${API}/api/admin/grants`, () => HttpResponse.json([])),
      http.get(`${API}/api/admin/mcp-servers`, () => HttpResponse.json([] satisfies McpServerSummary[])),
      http.get(`${API}/api/admin/models`, () => HttpResponse.json(catalogue)),
      http.get(`${API}/api/admin/model-providers`, () => HttpResponse.json(providers)),
    );
    const view = renderWithRuntime({ pathname: `/admin/roles/${SRE}` });
    expect(await screen.findByRole('heading', { level: 1, name: 'SRE' })).toBeInTheDocument();

    // Act (AC-14.2): «Добавить право» -> «Модель» -> open «Модель»
    await user.click(await screen.findByRole('button', { name: 'Добавить право' }));
    const grantDialog = await screen.findByRole('dialog', { name: 'Добавить право' });
    await user.click(within(grantDialog).getByRole('radio', { name: 'Модель' }));
    await user.click(within(grantDialog).getByRole('combobox', { name: 'Модель' }));

    // Assert (AC-14.2): chat models of working providers only - neither Gemini (provider off) nor BGE M3 (embedding)
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Claude Haiku 4.5 · anthropic',
        'Qwen 3 · local',
      ]),
    );
    await user.keyboard('{Escape}');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    view.unmount();

    // Arrange (company editor): the catalogue holds a chat model and an embedding model of the working `local`
    server.use(
      http.get(`${API}/api/library/choices`, () =>
        HttpResponse.json({ servers: ['logs'], defaultModel: HAIKU, defaultMaxTurns: 20 } satisfies LibraryChoices),
      ),
      http.get(`${API}/api/admin/models`, () =>
        HttpResponse.json([
          catalogModel({ id: HAIKU, name: 'Claude Haiku 4.5' }),
          catalogModel({ id: 'local/bge-m3', name: 'BGE M3', purpose: 'embedding', inputUsdPerMTok: 0.02, dimensions: 1024 }),
        ]),
      ),
    );
    renderWithRuntime({ pathname: '/admin/library/new/agent' });
    await user.click(await screen.findByRole('button', { name: 'Дополнительно: модель, максимум шагов, кого может запускать' }));
    options = await modelOptionsShown();

    // Assert: the company record editor offers chat models only - the embedding model is not among the options
    expect(options.map((option) => option.textContent)).toEqual(['Claude Haiku 4.5anthropic']);
  });

  // AC: AC-09.2, AC-09.3, AC-09.4, AC-09.5 "Сбой из-за провайдера называет причину"; AC-04.2, AC-02.1, AC-09.1 (первое сообщение без модели по
  //   умолчанию) (DC-4, DC-5)
  // Behavior: rows, one test with `resetRow()` between them:
  //   row A (running conversation, root agent on `anthropic/claude-haiku-5-5`): the root ends failed with `provider_disabled`, then in a second
  //     run with `provider_unavailable` -> the thread shows the reply error block «Провайдер модели Haiku выключен. Обратитесь к администратору
  //     Agent OS.», then «Провайдер модели Haiku не отвечает. Попробуйте перегенерировать позже.»; no event line is drawn for the failure.
  //   row B (new conversation on a deployment without a default chat model): the employee types the first message and sends -> the
  //     conversation is created and watched, the server answers the message 409 START_REFUSED `model_not_configured` (the empty conversation
  //     is removed, the address goes back to `/`) -> the typed text stays in the field and under it stands MC-11 «Модель для чата не
  //     настроена. Обратитесь к администратору Agent OS.» with `role="alert"`, describing the field; no reply error block exists.
  // Verification items:
  // - row A: the reply error block text equals the literal string above for each reason; the document has no event line for that failure
  // - row B: the field value equals the typed text; the MC-11 text is the field's error (visible under it), not a block in the thread
  // - the model is named by id («Haiku» short name), not by a catalogue title (the design's recorded difference from the UXRD)
  // Catches: a provider failure drawn as an event line instead of the reply error block (`CHAT_FAILURE_REASONS` missing the six `provider_*`
  //   reasons), and the first-message refusal wiped from the field or put where the thread has no row for it. The words per reason are a unit
  //   table; only this test sees the failure travel through the real feed -> thread -> block, and the 409 through the real message field.
  // @category: edge-case
  // @dependency: ChatRuntimeProvider, ChatShell, thread feed (event source mock), reply error block, message field, chatFailureText, startRefused, MSW, next/navigation mock
  // @complexity: high
  it('INT-5: a provider failure shows its words in the reply block inside a conversation and at the message field for a refused first message', async () => {
    const user = userEvent.setup({ delay: null });
    const api = trackRequests(server);
    const DISABLED = 'Провайдер модели Haiku выключен. Обратитесь к администратору Agent OS.';
    const UNAVAILABLE = 'Провайдер модели Haiku не отвечает. Попробуйте перегенерировать позже.';
    const NOT_CONFIGURED = 'Модель для чата не настроена. Обратитесь к администратору Agent OS.';

    /** The texts of the reply error blocks (TH-08) in the feed, in order. */
    const replyErrors = (): string[] =>
      Array.from(document.querySelectorAll('[data-slot="message-error"]'), (block) => block.textContent ?? '');
    /** DC-4: a provider failure of the root is no event line - neither the provider failure line nor any «Сбой: …». */
    const expectNoFailureLine = (): void => {
      expect(document.querySelector('[data-slot="provider-failure"]')).toBeNull();
      expect(document.body).not.toHaveTextContent('Сбой:');
    };

    // Arrange (row A): conversation `a`, its root on `anthropic/claude-haiku-5-5`; the first run ended `provider_disabled`
    const THREAD = threadSummary({ id: 'a', title: 'Сводка смены' });
    const failed = (seq: number, reason: string): HistoryEntry =>
      historyEntry({ kind: 'event', seq, content: { event: 'failed', reason } });
    const firstRun = [historyEntry({ kind: 'task', seq: 1, content: { text: 'Сводка по инцидентам за ночь' } }), failed(2, 'provider_disabled')];
    const viewOf = (entries: HistoryEntry[], failureReason: string) =>
      conversationView({
        thread: THREAD,
        chat: { status: 'idle', failureReason, rootAgentId: 'root', model: 'anthropic/claude-haiku-5-5' },
        entries,
      });
    let held = viewOf(firstRun, 'provider_disabled');
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([THREAD]))),
      http.get(`${API}/api/threads/a`, () => HttpResponse.json(THREAD)),
      http.get(`${API}/api/threads/a/history`, ({ request }) => {
        const afterSeq = Number(new URL(request.url).searchParams.get('afterSeq'));
        return HttpResponse.json({ ...held, entries: held.entries.filter((entry) => entry.seq > afterSeq) });
      }),
    );
    const live = createTestLiveSource();
    const conversation = renderWithRuntime({ pathname: '/chat/a', liveSource: live });
    await screen.findByText('Сводка по инцидентам за ночь');
    await waitFor(() => expect(live.current()?.url).toBe(`${API}/api/events?watch=thread%3Aa`));

    // Assert (row A, DC-4): the reply error block with the MC-11 words, read out as an alert; no event line for the failure
    await waitFor(() => expect(replyErrors()).toEqual([DISABLED]));
    expect(screen.getByText(DISABLED)).toHaveAttribute('role', 'alert');
    expectNoFailureLine();

    // Act (row A): a second run ends `provider_unavailable`; the stream's `ready` re-reads the conversation
    held = viewOf(
      [...firstRun, historyEntry({ kind: 'user_message', seq: 3, content: { text: 'Попробуй ещё раз' } }), failed(4, 'provider_unavailable')],
      'provider_unavailable',
    );
    live.emit('ready', {});

    // Assert (row A): each failure is its own reply error block with its own words; still no event line
    expect(await screen.findByText('Попробуй ещё раз')).toBeInTheDocument();
    await waitFor(() => expect(replyErrors()).toEqual([DISABLED, UNAVAILABLE]));
    expectNoFailureLine();
    conversation.unmount();

    // Arrange (row B, DC-5): no default chat model - the first message of a new conversation is refused 409 `model_not_configured`
    resetRow();
    const TYPED = 'Составь план на неделю';
    const fresh = createTestLiveSource();
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
      http.post(`${API}/api/threads`, () => HttpResponse.json(threadSummary({ id: 't-1', title: null }), { status: 201 })),
      http.get(`${API}/api/threads/:id`, ({ params }) => HttpResponse.json(threadSummary({ id: String(params.id), title: null }))),
      http.get(`${API}/api/threads/:id/history`, ({ params }) =>
        HttpResponse.json(
          conversationView({
            thread: threadSummary({ id: String(params.id), title: null }),
            chat: { status: 'new', failureReason: null, rootAgentId: null, model: null },
          }),
        ),
      ),
      http.post(`${API}/api/threads/:id/messages`, () =>
        apiError(409, 'START_REFUSED', 'Start refused', { reason: 'model_not_configured', model: null }),
      ),
      http.delete(`${API}/api/threads/:id`, () => new HttpResponse(null, { status: 204 })),
    );
    const newChat = renderWithRuntime({ pathname: '/', liveSource: fresh });
    const composer = (): HTMLElement => screen.getByRole('textbox', { name: 'Сообщение' });
    await screen.findByText('Чем могу помочь?');

    // Act (row B): type and send; the conversation is created, watched, the message refused, the empty conversation removed
    const mark = api.requests.length;
    await user.type(composer(), TYPED);
    await user.keyboard('{Enter}');
    const watchUrl = `${API}/api/events?watch=thread%3At-1`;
    await waitFor(() => expect(fresh.current()?.url).toBe(watchUrl));
    newChat.setPathname('/chat/t-1');
    await waitFor(() => expect(fresh.current()?.url).toBe(watchUrl));
    fresh.emit('ready', {});
    await waitFor(() => expect(newChat.router.replace).toHaveBeenCalledWith('/'));
    newChat.setPathname('/');

    // Assert (row B, DC-5): MC-11 under the field as an alert that describes it; the typed text is still there; no reply error block
    const refusal = await screen.findByText(NOT_CONFIGURED);
    expect(refusal).toHaveAttribute('role', 'alert');
    await waitFor(() => expect(composer()).toHaveValue(TYPED));
    expect(composer()).toHaveAccessibleDescription(NOT_CONFIGURED);
    expect(replyErrors()).toEqual([]);
    expect(
      api.requests
        .slice(mark)
        .filter((request) => request.method === 'POST' && request.path === '/api/threads/t-1/messages')
        .map((request) => request.body),
    ).toEqual([{ text: TYPED }]);
  });
});
