// enterprise-access / admin (web) - integration tests
// Design Doc: docs/features/enterprise-access/design-admin.md (v1.5), Test Strategy UC-1..UC-10, UC-E1..UC-E9; UXRD: docs/features/enterprise-access/uxrd.md (v2.3)
//   Screens AD-01..AD-11, AD-14..AD-16, GR-01, GR-02; MC-19, MC-22..MC-30, MC-33, MC-34.
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom): six cases, INT-1..INT-6 (INT-4 — access-levels UC-8, INT-5 — the server's tabs, INT-6 — the employee's «Инструменты»), each a table of rows. No web E2E: the design's «L1-сценарии в
//   браузере» table is the manual real-browser acceptance.
//
// Harness (src/test/): `renderWithRuntime` mounts ChatRuntimeProvider + ChatShell + Toaster with mocked next/navigation (controlled pathname,
//   router spy). MSW server from '@/test/msw-server' (`onUnhandledRequest: 'error'`: a request the screen must NOT send fails the test); `deferred()` and
//   `currentUser({ isAdmin })` from '@/test/fixtures'. The test's own support is marked `[support]` in the rows below. Response bodies are built by
//   fixtures that pass the `@agent-os/contracts` schemas (grant holder `{ kind: 'role' | 'user' }`).
// Mock boundary: network (MSW: `GET /api/auth/me`, `/api/admin/*`, the reads the shell makes anyway), next/navigation, the same-tab navigation
//   (`location.assign`, jsdom does not navigate), the clipboard, and the logger module (a recording stand-in: the logger is the Sentry/console boundary).
//   Real: shell route parsing, AdminGate, the panel sidebar and user menu, `apiRequest` with its 401 / 403 handlers, `adminApi`, `useResource`,
//   `DataTable`, `AdminForm`, `SecretField`, `CopyValue`, toast, announcer, focus service. Do NOT mock any of them.
//
// Server-side proofs are NOT repeated: that a non-admin is refused on every admin route, the last-admin and quota rules, quotas rounded to cents,
//   that deleting a model deletes its grants and that no secret leaves the API are proven by the API tests of identity, mcp-connect and access. This
//   file proves only what the browser does with those answers: what it shows, what it sends, what it keeps.
//
// Proven by the unit tests next to the code, not here: `parseShellRoute` (lib/shell-route.test.ts), `useResource` (hooks/use-resource.test.tsx),
//   `apiRequest` (lib/api/api-request.test.ts), `describeAdminError` (lib/admin/admin-errors.test.ts), the form rules (lib/admin/form-rules.test.ts),
//   catalogue prices (i18n/formats.test.ts), `DataTable` focus after a removed row
//   (components/admin/data-table.test.tsx) and `AdminForm` focus on the first field with an error (components/admin/admin-form.test.tsx).
//
// `not automated`: density, tokens, contrast and the keyboard order across the panel (NFR-05, UC-N1) - the L1 browser table; the loss of a deleted
//   role's rights for running agents (AC-25.2, server half) - proven by `access`; FR-31 (audit journal) is out of the feature; delete-user does not
//   exist.
//
// AC proof map (one proof per AC):
//   AC-24.1 INT-1 | AC-24.2 INT-1 | AC-25.1 INT-2 | AC-25.2 INT-2 (panel half: confirmed DELETE, list, notice; rights loss - `access`) | AC-25.3 INT-2
//   AC-26.1 INT-3 | AC-26.3 INT-3 | AC-26.4 INT-3 | AC-27.1 INT-3 | AC-28.2 INT-2 | AC-29.2 INT-2 | NFR-02 (web half) INT-2 + INT-3 | NFR-05 not automated

import {
  AccessErrorCode,
  CreateGrantBodySchema,
  CreateLocalUserBodySchema,
  CreateProviderBodySchema,
  IdentityErrorCode,
  McpErrorCode,
  RegisterMcpServerBodySchema,
  ResetPasswordBodySchema,
  SaveRoleLevelsBodySchema,
  SaveServerAccessBodySchema,
  SaveUserLevelsBodySchema,
  SetPersonalAdminBodySchema,
  UpdateGrantBodySchema,
  UpdateMcpServerBodySchema,
  UpdateMcpToolBodySchema,
  UpdateProviderBodySchema,
  UpdateRoleBodySchema,
  UpdateSignInSettingsBodySchema,
  type AdminUserDetail,
  type CatalogModel,
  type Grant,
  type LevelTool,
  type McpServerView,
  type McpToolView,
  type ProviderView,
  type RoleDetail,
  type RoleServerLevel,
  type ServerAccess,
  type UserServerLevel,
} from '@agent-os/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import {
  expectNowhere,
  logRecords,
  stubClipboard,
  trackRequests,
  type TrackedRequests,
} from '@/test/admin-support';
import {
  adminUserDetail,
  adminUserPage,
  adminUserSummary,
  catalogModel,
  currentUser,
  deferred,
  fixtureId,
  grant,
  mcpServerSummary,
  mcpServerView,
  providerSummary,
  providerView,
  roleDetail,
  roleSummary,
  signInSettings,
  threadList,
  threadSummary,
} from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

vi.mock(
  '@/lib/logger',
  async () => (await import('@/test/admin-support')).loggerModule,
);

const API = 'http://api.test';
// Intl separates a Russian amount and its currency sign with U+00A0.
const NBSP = String.fromCharCode(0xa0);

/** `/api/admin/*` requests as «METHOD path», in the order they started. */
const adminRequests = ({ requests }: TrackedRequests): string[] =>
  requests
    .filter((request) => request.path.startsWith('/api/admin/'))
    .map((request) => `${request.method} ${request.path}`);

/** Opens the user menu, reads its items (the mode radios aside) and closes it again. */
async function userMenuItems(user: UserEvent): Promise<string[]> {
  await user.click(screen.getByRole('button', { name: /^Меню пользователя/ }));
  const items = (await screen.findAllByRole('menuitem')).map(
    (item) => item.textContent,
  );
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  return items;
}

/** next/navigation is emulated: a link click must not make jsdom follow the href; the test sets the pathname. */
async function followLink(
  user: UserEvent,
  link: HTMLElement,
  setPathname: (pathname: string) => void,
): Promise<void> {
  const href = link.getAttribute('href');
  expect(href).not.toBeNull();
  link.addEventListener('click', (event) => event.preventDefault());
  await user.click(link);
  setPathname(href ?? '');
}

// INT-2 support -----------------------------------------------------------------------------------------------------------------------------

type Sent = { method: string; path: string; body: unknown };

const isAdminRequest = (path: string): boolean =>
  path.startsWith('/api/admin/');

/** The changes (every method but GET) sent to `/api/admin/*` from request number `from` on, with their JSON bodies. */
const changesSince = ({ requests }: TrackedRequests, from: number): Sent[] =>
  requests
    .slice(from)
    .filter(
      (request) => isAdminRequest(request.path) && request.method !== 'GET',
    )
    .map(({ method, path, body }) => ({ method, path, body }));

/** The `/api/admin/*` reads («path?search») started after the last change since request number `from`. */
function readsAfterChange(
  { requests }: TrackedRequests,
  from: number,
): string[] {
  const recent = requests.slice(from);
  const lastChange = recent.findLastIndex(
    (request) => isAdminRequest(request.path) && request.method !== 'GET',
  );
  return recent
    .slice(lastChange + 1)
    .filter(
      (request) => isAdminRequest(request.path) && request.method === 'GET',
    )
    .map((request) => `${request.path}${request.search}`);
}

/**
 * Invariant 4 and «exactly the confirmed request»: since `from` the page sent exactly `sent` (method, path and body
 * literally), and afterwards read `reread` again.
 */
async function expectSent(
  tracked: TrackedRequests,
  from: number,
  sent: Sent[],
  reread: string,
): Promise<void> {
  await waitFor(() => expect(changesSince(tracked, from)).toEqual(sent));
  await waitFor(() =>
    expect(readsAfterChange(tracked, from)).toContain(reread),
  );
}

const apiError = (
  status: number,
  errorCode: string,
  message: string,
  reason?: string,
): Response =>
  HttpResponse.json(
    {
      statusCode: status,
      message,
      errorCode,
      ...(reason === undefined ? {} : { reason }),
    },
    { status },
  );

/** A contract schema, as far as the fake backends use it. */
type BodySchema<Body> = {
  safeParse: (
    value: unknown,
  ) => { success: true; data: Body } | { success: false };
};

/**
 * A change's body read as the API reads it, with the contract's own schema: a body of another shape is answered
 * `400 VALIDATION_FAILED`, so the row that sent it fails instead of the fake taking whatever came.
 */
async function withBody<Body>(
  request: Request,
  schema: BodySchema<Body>,
  answer: (body: Body) => Response,
): Promise<Response> {
  const body = schema.safeParse(await request.json());
  return body.success
    ? answer(body.data)
    : apiError(
        400,
        'VALIDATION_FAILED',
        'Request body does not match the contract',
      );
}

const ANYA = fixtureId(2);
const BORIS = fixtureId(3);
const BUILTIN_ROLE = fixtureId(10);
const SRE = fixtureId(100);
const DUTY = fixtureId(101);
const SONNET = 'anthropic/claude-sonnet-4-5';

/** A server's tools as a level tab reads them; `null` while it waits for the administrator's account. */
const levelTools = (view: McpServerView): LevelTool[] | null =>
  view.status === 'awaiting_admin_account'
    ? null
    : view.tools.map(({ name, title, readOnly, enabled, isNew }) => ({
        name,
        title,
        readOnly,
        enabled,
        isNew,
      }));

/** GET /api/admin/mcp-servers/:name/access of a server: its tools as a level tab reads them and the roles with access. */
const serverAccess = (
  view: McpServerView,
  roles: ServerAccess['roles'],
): ServerAccess => ({
  server: view.name,
  status: view.status,
  tools: levelTools(view),
  roles,
});

const roleRef = (role: RoleDetail): { id: string; name: string } => ({
  id: role.id,
  name: role.name,
});

/**
 * The admin API as an in-memory store behind MSW: every change answers from the store and every read returns
 * the store, so what the screen shows after a change can only come from its new read. A refusal or a held answer
 * is put in front of a route for one request with `server.use(..., { once: true })`.
 */
function adminBackend() {
  const sre = roleDetail({ id: SRE, name: 'SRE' });
  const duty = roleDetail({ id: DUTY, name: 'Дежурный' });
  const builtin = roleDetail({
    id: BUILTIN_ROLE,
    name: 'Супер-администратор',
    isAdmin: true,
    builtinKind: 'super_admin',
  });
  // The registry as a role's level tab reads it: `jira` has no tool list yet, `sentry` has two tools.
  const registryLevels = (): RoleServerLevel[] => [
    {
      server: 'jira',
      status: 'awaiting_admin_account',
      tools: null,
      level: 'none',
      picked: [],
    },
    {
      server: 'sentry',
      status: 'enabled',
      tools: [],
      level: 'none',
      picked: [],
    },
  ];
  const store = {
    /** A role's levels by its id; a role not here reads `registryLevels()`. */
    levels: new Map<string, RoleServerLevel[]>(),
    /** The tools of `sentry` with their settings; a PATCH of a tool changes them. */
    sentryTools: mcpServerView({ name: 'sentry' }).tools,
    /** The roles with access to `sentry` (ST-02). */
    sentryAccess: [] as ServerAccess['roles'],
    /** Personal levels by «<user id>/<server>»; a pair not here is `none`. */
    personal: new Map<string, UserServerLevel['personal']>(),
    users: [
      adminUserDetail({
        id: ANYA,
        name: 'Аня Смирнова',
        email: 'anya@corp.example',
        roles: [roleRef(sre), roleRef(duty)],
      }),
    ] as AdminUserDetail[],
    // The server's order: by name.
    roles: [sre, duty, builtin] as RoleDetail[],
    grants: [] as Grant[],
    models: [
      catalogModel({ id: SONNET, name: 'Claude Sonnet 4.5' }),
    ] as CatalogModel[],
  };
  let nextGrant = 300;

  const user = (id: unknown) => store.users.find((entry) => entry.id === id);
  const role = (id: unknown) => store.roles.find((entry) => entry.id === id);
  const userNotFound = () =>
    apiError(404, IdentityErrorCode.USER_NOT_FOUND, 'User not found');
  const roleNotFound = () =>
    apiError(404, IdentityErrorCode.ROLE_NOT_FOUND, 'Role not found');
  // The summary schemas drop the detail's extra fields (`adminRight`, `members`).
  const summaryOf = (detail: AdminUserDetail) => adminUserSummary(detail);
  const modelName = (id: string): string =>
    store.models.find((model) => model.id === id)?.name ?? '';
  const levelsOf = (id: string): RoleServerLevel[] =>
    store.levels.get(id) ?? registryLevels();
  // The registry: `jira` still waits for the administrator's account, so it has no tools.
  const serverOf = (name: unknown): McpServerView =>
    name === 'jira'
      ? mcpServerView({
          name: 'jira',
          status: 'awaiting_admin_account',
          tools: [],
        })
      : mcpServerView({ name: 'sentry', tools: store.sentryTools });
  // An employee's levels: his personal level on each server and the levels of his roles there that are not `none`.
  const userServers = (id: string): UserServerLevel[] =>
    ['jira', 'sentry'].map((name) => {
      const view = serverOf(name);
      return {
        server: name,
        status: view.status,
        tools: levelTools(view),
        personal: store.personal.get(`${id}/${name}`) ?? {
          level: 'none',
          marks: [],
        },
        roles: (user(id)?.roles ?? []).flatMap((ref) => {
          const held = role(ref.id);
          const row = levelsOf(ref.id).find((entry) => entry.server === name);
          return held === undefined || row === undefined || row.level === 'none'
            ? []
            : [
                {
                  id: held.id,
                  name: held.name,
                  builtinKind: held.builtinKind,
                  level: row.level,
                  picked: row.picked,
                },
              ];
        }),
      };
    });
  const withMemberCounts = (entry: RoleDetail): RoleDetail => {
    const members = store.users
      .filter((member) => member.roles.some((held) => held.id === entry.id))
      .map(({ id, name, email }) => ({ id, name, email }));
    return roleDetail({ ...entry, memberCount: members.length, members });
  };

  const handlers = [
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
    // Employees
    http.get(`${API}/api/admin/users`, () =>
      HttpResponse.json(adminUserPage(store.users.map(summaryOf))),
    ),
    http.post(`${API}/api/admin/users`, ({ request }) =>
      withBody(request, CreateLocalUserBodySchema, (body) => {
        const created = adminUserDetail({
          id: BORIS,
          login: body.login,
          name: body.name,
          email: body.email,
          lastSignInAt: null,
        });
        store.users.push(created);
        return HttpResponse.json(summaryOf(created), { status: 201 });
      }),
    ),
    http.get(`${API}/api/admin/users/:id`, ({ params }) => {
      const found = user(params.id);
      return found === undefined ? userNotFound() : HttpResponse.json(found);
    }),
    // Personal levels: the save replaces the named servers' levels and answers every server.
    http.get(`${API}/api/admin/users/:id/levels`, ({ params }) =>
      user(params.id) === undefined
        ? userNotFound()
        : HttpResponse.json({
            superAdmin: false,
            servers: userServers(String(params.id)),
          }),
    ),
    http.put(`${API}/api/admin/users/:id/levels`, ({ params, request }) =>
      withBody(request, SaveUserLevelsBodySchema, (body) => {
        const id = String(params.id);
        if (user(id) === undefined) return userNotFound();
        for (const { server: name, level, marks } of body.servers)
          store.personal.set(`${id}/${name}`, { level, marks });
        return HttpResponse.json({
          superAdmin: false,
          servers: userServers(id),
        });
      }),
    ),
    http.put(`${API}/api/admin/users/:id/password`, ({ params, request }) =>
      withBody(request, ResetPasswordBodySchema, () =>
        user(params.id) === undefined
          ? userNotFound()
          : new HttpResponse(null, { status: 204 }),
      ),
    ),
    http.post(`${API}/api/admin/users/:id/:action`, ({ params }) => {
      const found = user(params.id);
      if (found === undefined) return userNotFound();
      found.status = params.action === 'block' ? 'disabled' : 'active';
      return HttpResponse.json(summaryOf(found));
    }),
    http.put(`${API}/api/admin/users/:id/admin`, ({ params, request }) =>
      withBody(request, SetPersonalAdminBodySchema, ({ enabled }) => {
        const found = user(params.id);
        if (found === undefined) return userNotFound();
        found.adminRight = { ...found.adminRight, personal: enabled };
        return HttpResponse.json(found);
      }),
    ),
    http.put(`${API}/api/admin/users/:id/roles/:roleId`, ({ params }) => {
      const found = user(params.id);
      const assigned = role(params.roleId);
      if (found === undefined) return userNotFound();
      if (assigned === undefined) return roleNotFound();
      found.roles = [...found.roles, roleRef(assigned)];
      return HttpResponse.json(found);
    }),
    http.delete(`${API}/api/admin/users/:id/roles/:roleId`, ({ params }) => {
      const found = user(params.id);
      if (found === undefined) return userNotFound();
      found.roles = found.roles.filter((held) => held.id !== params.roleId);
      return HttpResponse.json(found);
    }),
    // Roles
    http.get(`${API}/api/admin/roles`, () =>
      HttpResponse.json(
        store.roles.map((entry) => roleSummary(withMemberCounts(entry))),
      ),
    ),
    http.get(`${API}/api/admin/roles/:id`, ({ params }) => {
      const found = role(params.id);
      return found === undefined
        ? roleNotFound()
        : HttpResponse.json(withMemberCounts(found));
    }),
    http.patch(`${API}/api/admin/roles/:id`, ({ params, request }) =>
      withBody(request, UpdateRoleBodySchema, (body) => {
        const found = role(params.id);
        if (found === undefined) return roleNotFound();
        Object.assign(found, body);
        return HttpResponse.json(withMemberCounts(found));
      }),
    ),
    http.delete(`${API}/api/admin/roles/:id`, ({ params }) => {
      if (role(params.id) === undefined) return roleNotFound();
      store.roles = store.roles.filter((entry) => entry.id !== params.id);
      for (const member of store.users)
        member.roles = member.roles.filter((held) => held.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    // Levels of a role: the save replaces the named servers' rows and answers every server.
    http.get(`${API}/api/admin/roles/:id/levels`, ({ params }) =>
      role(params.id) === undefined
        ? roleNotFound()
        : HttpResponse.json({ servers: levelsOf(String(params.id)) }),
    ),
    http.put(`${API}/api/admin/roles/:id/levels`, ({ params, request }) =>
      withBody(request, SaveRoleLevelsBodySchema, (body) => {
        const id = String(params.id);
        if (role(id) === undefined) return roleNotFound();
        const servers = levelsOf(id).map((row) => {
          const saved = body.servers.find(
            (entry) => entry.server === row.server,
          );
          return saved === undefined
            ? row
            : { ...row, level: saved.level, picked: saved.picked };
        });
        store.levels.set(id, servers);
        return HttpResponse.json({ servers });
      }),
    ),
    // Rights
    http.get(`${API}/api/admin/grants`, ({ request }) => {
      const search = new URL(request.url).searchParams;
      const holderId = search.get('roleId') ?? search.get('userId');
      return HttpResponse.json(
        store.grants.filter((entry) => entry.holder.id === holderId),
      );
    }),
    http.post(`${API}/api/admin/grants`, ({ request }) =>
      withBody(request, CreateGrantBodySchema, (body) => {
        const holderRole = role(body.roleId);
        const target = {
          ...body.target,
          modelName: modelName(body.target.model),
        };
        const created = grant({
          id: fixtureId((nextGrant += 1)),
          holder:
            holderRole === undefined
              ? { kind: 'user', id: body.userId ?? '' }
              : { kind: 'role', ...roleRef(holderRole) },
          effect: body.effect,
          target,
          quotaUsd: body.quotaUsd ?? null,
        });
        store.grants.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
    ),
    http.patch(`${API}/api/admin/grants/:id`, ({ params, request }) =>
      withBody(request, UpdateGrantBodySchema, ({ quotaUsd }) => {
        const found = store.grants.find((entry) => entry.id === params.id);
        if (found === undefined)
          return apiError(
            404,
            AccessErrorCode.GRANT_NOT_FOUND,
            'Grant not found',
          );
        found.quotaUsd = quotaUsd;
        return HttpResponse.json(found);
      }),
    ),
    http.delete(`${API}/api/admin/grants/:id`, ({ params }) => {
      store.grants = store.grants.filter((entry) => entry.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${API}/api/admin/mcp-servers`, () =>
      HttpResponse.json([
        mcpServerSummary({
          name: 'jira',
          status: 'awaiting_admin_account',
          toolCount: 0,
        }),
        mcpServerSummary({ name: 'sentry', toolCount: 2 }),
      ]),
    ),
    http.get(`${API}/api/admin/mcp-servers/:name`, ({ params }) =>
      HttpResponse.json(serverOf(params.name)),
    ),
    // A tool's settings: `readOnly: null` returns the class to the server's mark (access-levels «Настройки инструмента»).
    http.patch(
      `${API}/api/admin/mcp-servers/:name/tools/:tool`,
      ({ params, request }) =>
        withBody(request, UpdateMcpToolBodySchema, (body) => {
          const found = store.sentryTools.find(
            (entry) => entry.name === params.tool,
          );
          if (found === undefined)
            return apiError(404, 'MCP_TOOL_NOT_FOUND', 'Tool not found');
          const mark = found.serverReadOnly === true;
          const updated: McpToolView = {
            ...found,
            enabled: body.enabled ?? found.enabled,
            ...(body.readOnly === undefined
              ? {}
              : {
                  readOnly: body.readOnly ?? mark,
                  overridden: body.readOnly !== null,
                }),
          };
          store.sentryTools = store.sentryTools.map((entry) =>
            entry.name === updated.name ? updated : entry,
          );
          return HttpResponse.json(updated);
        }),
    ),
    // Access of roles to a server: the save replaces the named roles' levels and answers the roles with access.
    http.get(`${API}/api/admin/mcp-servers/:name/access`, ({ params }) =>
      HttpResponse.json(
        serverAccess(
          serverOf(params.name),
          params.name === 'sentry' ? store.sentryAccess : [],
        ),
      ),
    ),
    http.put(`${API}/api/admin/mcp-servers/:name/access`, ({ request }) =>
      withBody(request, SaveServerAccessBodySchema, (body) => {
        const named = new Set(body.roles.map((entry) => entry.roleId));
        store.sentryAccess = [
          ...store.sentryAccess.filter((entry) => !named.has(entry.id)),
          ...body.roles.flatMap(({ roleId, level, picked }) => {
            const held = role(roleId);
            return held === undefined || level === 'none'
              ? []
              : [
                  {
                    id: held.id,
                    name: held.name,
                    builtinKind: held.builtinKind,
                    memberCount: withMemberCounts(held).memberCount,
                    level,
                    picked,
                  },
                ];
          }),
        ];
        return HttpResponse.json(
          serverAccess(serverOf('sentry'), store.sentryAccess),
        );
      }),
    ),
    // Models
    http.get(`${API}/api/admin/models`, () => HttpResponse.json(store.models)),
  ];

  return { store, handlers };
}

/** Opens a drop-down field of a form and returns its options as their text («list_issues читает уже есть»). */
async function openSelect(
  user: UserEvent,
  scope: HTMLElement,
  label: string,
): Promise<HTMLElement[]> {
  await user.click(within(scope).getByRole('combobox', { name: label }));
  return screen.findAllByRole('option');
}

/** Chooses the option whose text starts with `option` in a drop-down field of a form. */
async function chooseOption(
  user: UserEvent,
  scope: HTMLElement,
  label: string,
  option: string,
): Promise<void> {
  const options = await openSelect(user, scope, label);
  const chosen = options.find(
    (candidate) => candidate.textContent?.startsWith(option) === true,
  );
  if (chosen === undefined) throw new Error(`«${label}» offers no «${option}»`);
  await user.click(chosen);
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

/** The cells of the table row whose first cell holds `text`, as their text. */
function rowCells(table: HTMLElement, text: string): string[] {
  const row = within(table)
    .getAllByRole('row')
    .find(
      (candidate) =>
        candidate.querySelector('td')?.textContent?.includes(text) === true,
    );
  if (row === undefined) throw new Error(`no row with «${text}»`);
  return Array.from(
    row.querySelectorAll('td'),
    (cell) => cell.textContent ?? '',
  );
}

// INT-3 support -----------------------------------------------------------------------------------------------------------------------------

const OKTA = fixtureId(400);
const GOOGLE = fixtureId(401);
/** Where the tab goes to connect the administrator's own account (Flow 2): a page address, never a `fetch`. */
const connectAddress = (server: string): string =>
  `/api/admin/mcp-servers/${server}/connect`;
/** The tools of `sentry` after the refresh: `update_issue` is gone, `create_issue` is new. */
const REFRESHED_TOOLS: McpToolView[] = [
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Заводит задачу',
    readOnly: false,
    enabled: true,
    isNew: true,
    serverReadOnly: false,
    overridden: false,
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'Список задач',
    readOnly: true,
    enabled: true,
    isNew: false,
    serverReadOnly: true,
    overridden: false,
  },
];

/**
 * Providers, sign-in settings and the MCP registry as an in-memory store behind MSW, like `adminBackend`: a
 * secret or a token sent in a change is kept only as «set», never answered back.
 */
function signInBackend() {
  const store = {
    providers: [] as ProviderView[],
    settings: signInSettings({ publicUrl: null }),
    // `jira` still waits for the administrator's account.
    servers: [
      mcpServerView({
        name: 'jira',
        status: 'awaiting_admin_account',
        tools: [],
      }),
    ] as McpServerView[],
  };
  let nextProvider = 400;
  let settingsSaves = 0;

  const provider = (id: unknown) =>
    store.providers.find((entry) => entry.id === id);
  const registered = (name: unknown) =>
    store.servers.find((entry) => entry.name === name);
  const providerNotFound = () =>
    apiError(404, IdentityErrorCode.PROVIDER_NOT_FOUND, 'Provider not found');
  const serverNotFound = () =>
    apiError(404, McpErrorCode.MCP_SERVER_NOT_FOUND, 'Server not found');

  const handlers = [
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
    // Providers
    http.get(`${API}/api/admin/providers`, () =>
      HttpResponse.json(
        store.providers.map(({ id, type, name, enabled }) =>
          providerSummary({ id, type, name, enabled }),
        ),
      ),
    ),
    http.post(`${API}/api/admin/providers`, ({ request }) =>
      withBody(request, CreateProviderBodySchema, ({ type, name }) => {
        const created = providerView({
          id: fixtureId(nextProvider),
          type: type === 'google' ? 'google' : 'oidc',
          name,
        });
        nextProvider += 1;
        store.providers.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
    ),
    http.get(`${API}/api/admin/providers/:id`, ({ params }) => {
      const found = provider(params.id);
      return found === undefined
        ? providerNotFound()
        : HttpResponse.json(found);
    }),
    http.patch(`${API}/api/admin/providers/:id`, ({ params, request }) =>
      withBody(
        request,
        UpdateProviderBodySchema,
        ({ name, enabled, options }) => {
          const found = provider(params.id);
          if (found === undefined) return providerNotFound();
          if (name !== undefined) found.name = name;
          if (enabled !== undefined) found.enabled = enabled;
          if (options?.issuer !== undefined)
            found.options.issuer = options.issuer;
          if (options?.clientId !== undefined)
            found.options.clientId = options.clientId;
          if (options?.clientSecret !== undefined)
            found.options.clientSecretSet = true;
          return HttpResponse.json(found);
        },
      ),
    ),
    // Sign-in settings: every save moves `updatedAt`, as the API does
    http.get(`${API}/api/admin/settings/sign-in`, () =>
      HttpResponse.json(store.settings),
    ),
    http.put(`${API}/api/admin/settings/sign-in`, ({ request }) =>
      withBody(request, UpdateSignInSettingsBodySchema, (body) => {
        settingsSaves += 1;
        store.settings = signInSettings({
          ...body,
          updatedAt: `2026-11-16T10:0${settingsSaves}:00.000Z`,
        });
        return HttpResponse.json(store.settings);
      }),
    ),
    // MCP servers
    http.get(`${API}/api/admin/mcp-servers`, () =>
      HttpResponse.json(
        store.servers.map(({ name, url, mode, status, toolCount }) =>
          mcpServerSummary({ name, url, mode, status, toolCount }),
        ),
      ),
    ),
    http.post(`${API}/api/admin/mcp-servers`, ({ request }) =>
      withBody(request, RegisterMcpServerBodySchema, ({ name, url, mode }) => {
        const created =
          mode === 'oauth'
            ? mcpServerView({
                name,
                url,
                mode,
                status: 'awaiting_admin_account',
                tools: [],
              })
            : mcpServerView({
                name,
                url,
                mode,
                status: 'enabled',
                sharedTokenSet: true,
              });
        store.servers.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
    ),
    http.get(`${API}/api/admin/mcp-servers/:name`, ({ params }) => {
      const found = registered(params.name);
      return found === undefined ? serverNotFound() : HttpResponse.json(found);
    }),
    http.patch(`${API}/api/admin/mcp-servers/:name`, ({ params, request }) =>
      withBody(
        request,
        UpdateMcpServerBodySchema,
        ({ enabled, sharedToken }) => {
          const found = registered(params.name);
          if (found === undefined) return serverNotFound();
          if (enabled !== undefined)
            found.status = enabled ? 'enabled' : 'disabled';
          if (sharedToken !== undefined) found.sharedTokenSet = true;
          return HttpResponse.json(found);
        },
      ),
    ),
    http.post(
      `${API}/api/admin/mcp-servers/:name/tools/refresh`,
      ({ params }) => {
        const found = registered(params.name);
        if (found === undefined) return serverNotFound();
        const before = found.tools.map((tool) => tool.name);
        found.tools = REFRESHED_TOOLS;
        found.toolCount = REFRESHED_TOOLS.length;
        const after = REFRESHED_TOOLS.map((tool) => tool.name);
        return HttpResponse.json({
          server: found,
          added: after.filter((name) => !before.includes(name)),
          removed: before.filter((name) => !after.includes(name)),
        });
      },
    ),
    // «Отметить просмотренными»: the new marks go and each tool takes the server's own mark again.
    http.post(
      `${API}/api/admin/mcp-servers/:name/tools/reviewed`,
      ({ params }) => {
        const found = registered(params.name);
        if (found === undefined) return serverNotFound();
        found.tools = found.tools.map((tool) => ({
          ...tool,
          isNew: false,
          readOnly: tool.overridden
            ? tool.readOnly
            : tool.serverReadOnly === true,
        }));
        return HttpResponse.json(found);
      },
    ),
    // The registration form shows the return address the API builds for the typed name, registered or not.
    http.get(`${API}/api/admin/mcp-servers/:name/callback-url`, ({ params }) =>
      HttpResponse.json({
        url: `https://agent-os.corp.example/api/mcp/oauth/callback/${String(params.name)}`,
      }),
    ),
    // The server page reads «Доступ» with the role list on open: no role has access here.
    http.get(`${API}/api/admin/mcp-servers/:name/access`, ({ params }) => {
      const found = registered(params.name);
      return found === undefined
        ? serverNotFound()
        : HttpResponse.json(serverAccess(found, []));
    }),
    http.get(`${API}/api/admin/roles`, () => HttpResponse.json([])),
    http.delete(`${API}/api/admin/mcp-servers/:name`, ({ params }) => {
      if (registered(params.name) === undefined) return serverNotFound();
      store.servers = store.servers.filter(
        (entry) => entry.name !== params.name,
      );
      return new HttpResponse(null, { status: 204 });
    }),
  ];

  return { store, handlers };
}

/** ST-01: each open group's name and the technical names of the tools it shows («Меняют: sentry: update_issue»). */
function toolGroups(server: string): string[] {
  const region = screen.getByRole('region', { name: `Инструменты ${server}` });
  return within(region)
    .getAllByRole('list')
    .map(
      (list) =>
        `${list.getAttribute('aria-label')}: ${within(list)
          .getAllByRole('listitem')
          .map((item) => item.dataset.tool)
          .join(', ')}`,
    );
}

/** The rows of a table below its header row, as their text. */
const bodyRows = (table: HTMLElement): string[] =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.textContent ?? '');

describe('enterprise-access / admin - web integration (jsdom + MSW)', () => {
  // INT-1 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-24.1 "Given администратор вошёл, when он открывает меню, then видит вход в панель, а в панели - все разделы, перечисленные в FR-24";
  //   AC-24.2 "Given у сотрудника нет права администратора, when он открывает адрес панели напрямую, then видит отказ, а не данные панели, и входа
  //   в панель в его меню нет". Design: DC-1, DC-2, KD-2, Flow 1; UC-1, UC-E1, UC-E2.
  // Behavior: the shell asks `GET /api/auth/me` once -> the panel and its requests exist only for an administrator; a 403 later takes the right
  //   away in place.
  // Rows (texts from uxrd.md MC-18, MC-19; `GET /api/auth/me` is held with `deferred()` in row 1):
  //   1. not an administrator (`isAdmin: false`) opens `/admin/roles`. Until `me` answers: the state «Право ещё не известно» (AD-01). Then «Нет
  //      доступа» / «Панель администратора открыта только администраторам Agent OS.» with «В чат»; the ORDINARY sidebar with the conversation list;
  //      no «Панель администратора» in the user menu; ZERO requests to `/api/admin/*` for the whole test ([support] request counter on
  //      `server.events` `request:start`, because the screen could swallow the unhandled-request error); «В чат» leaves without a chat restart
  //   2. an administrator (`isAdmin: true`) opens the user menu and chooses «Панель администратора»: «Сотрудники» is open, the sidebar shows «К чату»
  //      and exactly the sections «Сотрудники», «Роли», «Авторизация», «MCP-серверы», «Модели», «Агенты и глубокие агенты» (no «Журнал», no pauses), the focus is on the `h1`
  //      «Сотрудники», `document.title` is «Сотрудники — Панель — Agent OS»; the first request after `GET /api/auth/me` is `GET /api/admin/users`
  //   3. the administrator on `/admin/roles` presses «Создать роль» and creates one: `POST /api/admin/roles` answers `403 ADMIN_REQUIRED` - the SAME
  //      address now shows «Нет доступа», the ordinary sidebar, the menu without the panel item, no role row left on screen, and no further
  //      `/api/admin/*` request follows
  // Catches: the panel fetching `/api/admin/*` before `me` answers or for a non-admin (each such open writes `access_denied` to the audit) or showing
  //   its data until a 403 arrives; the 403 handler not wired into the shell, so an administrator whose right was withdrawn keeps a working-looking
  //   panel whose every action fails; a menu item shown to an employee who cannot use it.
  // @category: core-functionality
  // @dependency: parseShellRoute, AdminGate, CurrentUser store, AppSidebar, UserMenu, MainView, ThreadNotice, apiRequest 403 handler, adminApi, MSW, next/navigation mock
  // @complexity: medium
  it('INT-1 / UC-1 / UC-E1 / UC-E2: a non-administrator gets «Нет доступа» and sends no panel request; an administrator gets the panel with its six sections; a 403 ADMIN_REQUIRED turns the open panel into «Нет доступа» in place', async () => {
    // Arrange: the conversation list both employees have, the panel's reads and the refused «Создать роль»
    let threadReads = 0;
    server.use(
      http.get(`${API}/api/threads`, () => {
        threadReads += 1;
        return HttpResponse.json(
          threadList([threadSummary({ id: 'a', title: 'План релиза' })]),
        );
      }),
      http.get(`${API}/api/admin/users`, () =>
        HttpResponse.json(
          adminUserPage([
            adminUserSummary({
              id: fixtureId(2),
              name: 'Борис Ким',
              email: 'boris@corp.example',
            }),
          ]),
        ),
      ),
      http.get(`${API}/api/admin/roles`, () =>
        HttpResponse.json([
          roleSummary({
            id: fixtureId(10),
            name: 'Супер-администратор',
            isAdmin: true,
            builtinKind: 'super_admin',
            memberCount: 1,
          }),
          roleSummary({ id: fixtureId(100), name: 'SRE' }),
        ]),
      ),
      http.post(`${API}/api/admin/roles`, () =>
        HttpResponse.json(
          {
            statusCode: 403,
            message: 'Administrator right required',
            errorCode: IdentityErrorCode.ADMIN_REQUIRED,
          },
          { status: 403 },
        ),
      ),
    );
    const user = userEvent.setup({ delay: null });

    // Row 1 - not an administrator opens `/admin/roles`; `GET /api/auth/me` is held
    const employeeMe = deferred();
    server.use(
      http.get(`${API}/api/auth/me`, async () => {
        await employeeMe.promise;
        return HttpResponse.json(currentUser({ isAdmin: false }));
      }),
    );
    const employee = trackRequests(server);
    const employeeView = renderWithRuntime({ pathname: '/admin/roles' });

    // Assert (row 1, «Право ещё не известно»): the table's Loading named «Роли», six skeleton rows in place of the sections
    expect(
      await screen.findByRole('status', { name: 'Роли' }),
    ).toBeInTheDocument();
    const unknownNav = screen.getByRole('navigation', { name: 'Панель' });
    expect(
      unknownNav.querySelectorAll('[data-slot="sidebar-menu-skeleton"]'),
    ).toHaveLength(6);
    expect(
      within(unknownNav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['К чату']);
    await waitFor(() =>
      expect(employee.requests.map((request) => request.path)).toContain(
        '/api/auth/me',
      ),
    );
    expect(employee.adminCount()).toBe(0);

    // Act (row 1): `me` answers «not an administrator»
    employeeMe.resolve();

    // Assert (row 1): «Нет доступа» with «В чат», the ordinary sidebar with the conversations, no panel item in the menu
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Нет доступа' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Панель администратора открыта только администраторам Agent OS.',
      ),
    ).toBeInTheDocument();
    const toChat = screen.getByRole('link', { name: 'В чат' });
    expect(toChat).toHaveAttribute('href', '/');
    expect(screen.queryByRole('status', { name: 'Роли' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Панель' })).toBeNull();
    const employeeHistory = screen.getByRole('navigation', {
      name: 'История бесед',
    });
    expect(
      await within(employeeHistory).findByRole('link', { name: 'План релиза' }),
    ).toHaveAttribute('href', '/chat/a');
    expect(screen.getByRole('link', { name: 'Агенты' })).toBeInTheDocument();
    expect(await userMenuItems(user)).toEqual([
      'Мой доступ',
      'Тема: Графит',
      'Выйти',
    ]);

    // Act (row 1): «В чат»
    await followLink(user, toChat, employeeView.setPathname);

    // Assert (row 1): the chat opens in place - no reload of the tab, no second read of the list - and no panel request was ever sent
    await waitFor(() => expect(document.title).toBe('Новый чат — Agent OS'));
    expect(
      within(
        screen.getByRole('navigation', { name: 'История бесед' }),
      ).getByRole('link', { name: 'План релиза' }),
    ).toBeInTheDocument();
    expect(threadReads).toBe(1);
    expect(employeeView.assign).not.toHaveBeenCalled();
    expect(employee.adminCount()).toBe(0);
    employeeView.unmount();

    // Row 2 - an administrator on `/` chooses «Панель администратора» in the menu; `me` is held to mark when it answered
    threadReads = 0;
    const adminMe = deferred();
    let meAnsweredAfter = -1;
    server.use(
      http.get(`${API}/api/auth/me`, async () => {
        await adminMe.promise;
        meAnsweredAfter = administrator.requests.length;
        return HttpResponse.json(
          currentUser({
            isAdmin: true,
            name: 'Игорь Петров',
            email: 'igor@corp.example',
          }),
        );
      }),
    );
    const administrator = trackRequests(server);
    const adminView = renderWithRuntime({ pathname: '/' });
    await waitFor(() =>
      expect(administrator.requests.map((request) => request.path)).toContain(
        '/api/auth/me',
      ),
    );
    adminMe.resolve();

    // Act (row 2)
    await user.click(
      await screen.findByRole('button', {
        name: 'Меню пользователя Игорь Петров',
      }),
    );
    await followLink(
      user,
      await screen.findByRole('menuitem', { name: 'Панель администратора' }),
      adminView.setPathname,
    );

    // Assert (row 2): «Сотрудники» with its h1 focused and its tab title; «К чату», «Панель» and exactly the six sections
    const usersTitle = await screen.findByRole('heading', {
      level: 1,
      name: 'Сотрудники',
    });
    await waitFor(() => expect(usersTitle).toHaveFocus());
    await waitFor(() =>
      expect(document.title).toBe('Сотрудники — Панель — Agent OS'),
    );
    const panelNav = screen.getByRole('navigation', { name: 'Панель' });
    expect(within(panelNav).getByText('Панель')).toBeInTheDocument();
    expect(
      within(panelNav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'К чату',
      'Сотрудники',
      'Роли',
      'Авторизация',
      'MCP-серверы',
      'Модели',
      'Агенты и глубокие агенты',
    ]);
    expect(
      within(panelNav).getByRole('link', { name: 'Сотрудники' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      screen.queryByRole('navigation', { name: 'История бесед' }),
    ).toBeNull();
    expect(await screen.findByText('Борис Ким')).toBeInTheDocument();
    // The first panel request is the employees' list, and it started only after `me` had answered.
    expect(adminRequests(administrator)).toEqual(['GET /api/admin/users']);
    expect(meAnsweredAfter).toBeGreaterThan(0);
    expect(
      administrator.requests.findIndex(
        (request) => request.path === '/api/admin/users',
      ),
    ).toBeGreaterThanOrEqual(meAnsweredAfter);

    // Act (row 3): «Роли», then «Создать роль» «Дежурный»; the API has withdrawn the right
    await followLink(
      user,
      within(panelNav).getByRole('link', { name: 'Роли' }),
      adminView.setPathname,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Роли' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('SRE')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Создать роль' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новая роль' });
    await user.type(within(dialog).getByLabelText('Название роли'), 'Дежурный');
    await user.click(within(dialog).getByRole('button', { name: 'Создать' }));

    // Assert (row 3): the same address shows «Нет доступа», the ordinary sidebar and a menu without the panel item; no role is left
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Нет доступа' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('SRE')).toBeNull();
    expect(screen.queryByText('Супер-администратор')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Панель' })).toBeNull();
    const adminHistory = screen.getByRole('navigation', {
      name: 'История бесед',
    });
    expect(
      await within(adminHistory).findByRole('link', { name: 'План релиза' }),
    ).toBeInTheDocument();
    expect(await userMenuItems(user)).toEqual([
      'Мой доступ',
      'Тема: Графит',
      'Выйти',
    ]);
    expect(adminView.router.push).not.toHaveBeenCalled();
    expect(adminView.router.replace).not.toHaveBeenCalled();
    expect(adminView.assign).not.toHaveBeenCalled();
    // No panel request followed the 403; the dialog read the roles to copy from (AD-17).
    expect(adminRequests(administrator)).toEqual([
      'GET /api/admin/users',
      'GET /api/admin/roles',
      'GET /api/admin/roles',
      'POST /api/admin/roles',
    ]);
    await waitFor(() =>
      expect(
        administrator.requests.find((request) => request.method === 'POST')
          ?.body,
      ).toEqual({ name: 'Дежурный' }),
    );
  });

  // INT-2 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-25.1 "Given администратор назначил Ане роли «SRE» и «Дежурный», when он открывает Аню, then видит обе роли и может снять каждую";
  //   AC-25.2 (panel half) "Given администратор удалил роль, ..." - the panel sends the confirmed delete and returns to the refreshed list;
  //   AC-25.3 "Given администратор открывает список сотрудников, when он заводит локальную учётную запись или сбрасывает пароль, then вводит
  //   логин, имя, почту и пароль в панели, и сотрудник появляется в списке с пометкой «локальная»";
  //   AC-28.2 "Given администратор даёт право на инструмент, when он выбирает инструмент, then выбирает его из списка инструментов сервера в реестре";
  //   AC-29.2 "Given администратор задал роли «SRE» квоту на Sonnet 50 $, а Ане - личную квоту 30 $, when он снова открывает роль и Аню, then видит
  //   обе квоты такими, какими их задал"; NFR-02 (password half). Design: DC-4, DC-5, DC-6, DC-12, DC-13, DC-14; UC-2..UC-6, UC-E6, UC-E9 (orphan).
  // Behavior: the administrator changes who may do what -> each action sends the one request the screen names, shows the server's refusal at the
  //   action that caused it, and every list shows the NEW READ, never a patch of the old copy (invariant 4); a destructive action goes out only
  //   after the confirmation that names its effect.
  // Rows (texts from uxrd.md MC-22..MC-26, MC-30; every row asserts the request method, path and body literally):
  //   1. local account (AC-25.3): «Завести учётную запись» -> «Логин», «Имя», «Почта», «Начальный пароль»; a password of 8 characters sends nothing and
  //      the focus is on the field («Пароль — от 12 до 256 знаков»); then one `POST /api/admin/users` with `{ login, name, email, password }`, the
  //      list is read again and the row carries «локальная» and the login under the name; the toast names the login («Учётная запись boris
  //      заведена») and not the password; `409 LOGIN_TAKEN` shows «Такой логин уже есть» at «Логин» with the other fields kept
  //   2. password reset (AC-25.3, NFR-02): on the page of that employee «Сбросить пароль» -> «Новый пароль для {имя}» -> one
  //      `PUT /api/admin/users/:id/password` with `{ password }` (204) -> «Пароль сброшен — передайте новый сотруднику»; reopening the dialog shows an
  //      EMPTY field; an employee with `login: null` has no «Сбросить пароль»; the typed password is in no part of the document after the answer and in no
  //      record of the logger stand-in
  //   3. roles of an employee (AC-25.1): Аня shows both «SRE» and «Дежурный», each with «Снять роль»; pressing one sends
  //      `DELETE /api/admin/users/:id/roles/:roleId` and after the new read it is gone; «Назначить роль» offers only the roles she lacks and sends
  //      `PUT /api/admin/users/:id/roles/:roleId`; «Дать лично» asks first («Отмена» sends nothing), «Дать право» sends `PUT /api/admin/users/:id/admin` with `{ enabled: true }` and the row reads
  //      «есть: лично» after the new read; «Снять лично» sends `{ enabled: false }` and the row reads «нет» again
  //   4. built-in role (DC-5): the role list has «Супер-администратор» FIRST with «встроенная»; its page has no «Переименовать» and no «Удалить», and the
  //      «Право администратора» switch is on and disabled; on «Дежурный» the switch asks first (Escape sends nothing, it stays off), «Дать право» sends `PATCH /api/admin/roles/:id` with `{ isAdmin: true }`,
  //      then `{ isAdmin: false }`
  //   5. model rights (AC-29.2, DC-12, DC-14): the role «SRE» has none; «Разрешить модель» with «Модель» and «Квота за месяц, $» 50 sends
  //      `{ roleId, effect: 'allow', target: { kind: 'model', model }, quotaUsd: 50 }`; on Аня «Запретить модель» for the model sends
  //      `{ userId, effect: 'deny', ... }` (a deny is never sent as allow); a personal quota 30; reopening the role and Аня shows 50 and 30 exactly as set;
  //      «Изменить квоту» 80 sends `PATCH /api/admin/grants/:id` with `{ quotaUsd: 80 }` and the list shows 80 from the new `GET /api/admin/grants`;
  //      an emptied field sends `{ quotaUsd: null }`
  //   6. server refusals of a right (DC-12): `409 GRANT_EXISTS`, `422 GRANT_TARGET_UNKNOWN`, `422 GRANT_INVALID` (with its `reason`) each leave the dialog
  //      OPEN with the fields kept and the text of the refusal in the form error; no grant row appears or changes
  //   9. confirmed destructive and rights-changing actions (UC-4, UC-6; one table: block, delete role and delete grant — «Убрать» sends one DELETE without a dialog): the
  //      dialog names the object («Заблокировать {имя}?», «Удалить роль «{роль}»?»); «Отмена» and Escape send NOTHING; «Заблокировать» sends one
  //      `POST /api/admin/users/:id/block` and the page shows «Отключён» with «Разблокировать» and promises no instant stop of the agents; «Удалить» sends
  //      one `DELETE /api/admin/roles/:id`, opens the role list, toast «Роль удалена», focus on the `h1`; a `404` (`USER_NOT_FOUND`, `ROLE_NOT_FOUND`) or
  //      `409 BUILTIN_ROLE` answer is shown in words at the action and the resource is read again; while the request is open the confirm button
  //      is disabled (one request, not two)
  // Catches: a deny sent as an allow (or the reverse) or a right created on the wrong holder, the one mistake that silently opens or closes a server
  //   or model; a quota that the list shows from the client's own arithmetic instead of the new read; a destructive request sent without the
  //   confirmation, twice, or for another object than the dialog named; a refused action that still changes the screen; the password kept in the
  //   dialog after the reset or reaching a toast or a log record; a built-in role offered «Удалить».
  // @category: core-functionality
  // @dependency: employees, roles and rights screens, grant dialog (GR-01), adminApi (users, roles, grants, servers, models), useResource, DataTable, AdminForm, alert-dialog, toast, focus service, logger stand-in, MSW
  // @complexity: high
  it("INT-2 / UC-2..UC-6 / UC-E6 / UC-E9: local accounts and password reset, roles of an employee, the built-in role, rights and denies with their quotas, and the confirmed destructive actions send exactly the confirmed request and show the server's refusal", async () => {
    // Arrange: an administrator, the admin API as a store (Аня with «SRE» and «Дежурный», three roles, the rights of
    // «SRE», the registry with `jira` and `sentry`, the catalogue with Sonnet)
    const { store, handlers } = adminBackend();
    server.use(
      http.get(`${API}/api/auth/me`, () =>
        HttpResponse.json(
          currentUser({
            isAdmin: true,
            name: 'Игорь Петров',
            email: 'igor@corp.example',
          }),
        ),
      ),
      ...handlers,
    );
    const api = trackRequests(server);
    const user = userEvent.setup({ delay: null });
    const view = renderWithRuntime({ pathname: '/admin/users' });
    const navigationSpies = () => [
      view.router.push,
      view.router.replace,
      view.assign,
    ];
    const open = async (pathname: string, title: string): Promise<void> => {
      view.setPathname(pathname);
      expect(
        await screen.findByRole('heading', { level: 1, name: title }),
      ).toBeInTheDocument();
    };
    let mark = 0;
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Сотрудники' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Аня Смирнова')).toBeInTheDocument();

    // Row 3 - the roles of Аня (AC-25.1) on her «Роли»; she has no local account, so no «Сбросить пароль»
    await open(`/admin/users/${ANYA}/roles`, 'Аня Смирнова');
    const anyaRoles = await screen.findByRole('table', { name: 'Роли' });
    expect(
      within(anyaRoles)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual(['SREСнять роль', 'ДежурныйСнять роль']);
    expect(
      screen.queryByRole('button', { name: 'Сбросить пароль' }),
    ).toBeNull();
    mark = api.requests.length;
    await user.click(
      within(anyaRoles).getByRole('button', { name: 'Снять роль: Дежурный' }),
    );
    await expectSent(
      api,
      mark,
      [
        {
          method: 'DELETE',
          path: `/api/admin/users/${ANYA}/roles/${DUTY}`,
          body: null,
        },
      ],
      `/api/admin/users/${ANYA}`,
    );
    await waitFor(() =>
      expect(
        within(anyaRoles).queryByRole('button', {
          name: 'Снять роль: Дежурный',
        }),
      ).toBeNull(),
    );
    expect(
      within(anyaRoles).getByRole('button', { name: 'Снять роль: SRE' }),
    ).toBeInTheDocument();

    // Act (row 3): «Назначить роль» offers only the roles she lacks
    await user.click(screen.getByRole('button', { name: 'Назначить роль' }));
    const roleItems = await screen.findAllByRole('menuitem');
    expect(roleItems.map((item) => item.textContent)).toEqual([
      'Дежурный',
      'Супер-администратор',
    ]);
    mark = api.requests.length;
    await user.click(screen.getByRole('menuitem', { name: 'Дежурный' }));
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PUT',
          path: `/api/admin/users/${ANYA}/roles/${DUTY}`,
          body: null,
        },
      ],
      `/api/admin/users/${ANYA}`,
    );
    expect(
      await within(anyaRoles).findByRole('button', {
        name: 'Снять роль: Дежурный',
      }),
    ).toBeInTheDocument();

    // Act (row 3): «Дать лично» on her «Права»
    view.setPathname(`/admin/users/${ANYA}/rights`);
    expect(await screen.findByText('нет')).toBeInTheDocument();
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Дать лично' }));
    let confirm = await screen.findByRole('alertdialog', {
      name: 'Дать Аня Смирнова право администратора?',
    });
    expect(
      within(confirm).getByText(
        'Сотрудник сможет управлять учётными записями, ролями, правами, способами входа, MCP-серверами и моделями.',
      ),
    ).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(changesSince(api, mark)).toEqual([]);
    expect(screen.getByText('нет')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Дать лично' })).toHaveFocus(),
    );
    await user.click(screen.getByRole('button', { name: 'Дать лично' }));
    confirm = await screen.findByRole('alertdialog', {
      name: 'Дать Аня Смирнова право администратора?',
    });
    await user.click(
      within(confirm).getByRole('button', { name: 'Дать право' }),
    );
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PUT',
          path: `/api/admin/users/${ANYA}/admin`,
          body: { enabled: true },
        },
      ],
      `/api/admin/users/${ANYA}`,
    );
    expect(await screen.findByText('есть: лично')).toBeInTheDocument();
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Снять лично' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PUT',
          path: `/api/admin/users/${ANYA}/admin`,
          body: { enabled: false },
        },
      ],
      `/api/admin/users/${ANYA}`,
    );
    expect(await screen.findByText('нет')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Дать лично' }),
    ).toBeInTheDocument();

    // Row 5 - a personal deny and a personal quota of Аня on her «Модели» (AC-28.2, AC-29.2): a deny is sent as a deny, with no quota
    view.setPathname(`/admin/users/${ANYA}/models`);
    expect(
      await screen.findByText('Личных прав на модели нет'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Запретить модель' }));
    const denyDialog = await screen.findByRole('dialog', {
      name: 'Запретить модель',
    });
    expect(within(denyDialog).queryByLabelText('Квота за месяц, $')).toBeNull();
    await chooseOption(user, denyDialog, 'Модель', 'Claude Sonnet 4.5');
    mark = api.requests.length;
    await user.click(
      within(denyDialog).getByRole('button', { name: 'Запретить' }),
    );
    await expectSent(
      api,
      mark,
      [
        {
          method: 'POST',
          path: '/api/admin/grants',
          body: {
            userId: ANYA,
            effect: 'deny',
            target: { kind: 'model', model: SONNET },
          },
        },
      ],
      `/api/admin/grants?userId=${ANYA}`,
    );
    const personal = await screen.findByRole('table', {
      name: 'Модели',
    });
    expect(rowCells(personal, 'Claude Sonnet 4.5')).toEqual([
      'Claude Sonnet 4.5',
      'Запрет',
      '—',
      '',
    ]);

    await user.click(screen.getByRole('button', { name: 'Разрешить модель' }));
    const personalAllow = await screen.findByRole('dialog', {
      name: 'Разрешить модель',
    });
    await chooseOption(user, personalAllow, 'Модель', 'Claude Sonnet 4.5');
    await user.type(
      within(personalAllow).getByLabelText('Квота за месяц, $'),
      '30',
    );
    mark = api.requests.length;
    await user.click(
      within(personalAllow).getByRole('button', { name: 'Разрешить' }),
    );
    await expectSent(
      api,
      mark,
      [
        {
          method: 'POST',
          path: '/api/admin/grants',
          body: {
            userId: ANYA,
            effect: 'allow',
            target: { kind: 'model', model: SONNET },
            quotaUsd: 30,
          },
        },
      ],
      `/api/admin/grants?userId=${ANYA}`,
    );
    // The deny and the allow of the same model are two rows, in the server's order.
    await waitFor(() =>
      expect(within(personal).getAllByText('Claude Sonnet 4.5')).toHaveLength(
        2,
      ),
    );
    // The header row holds a `td` for the actions column: only rows with a key are grants.
    expect(
      within(personal)
        .getAllByRole('row')
        .filter((row) => row.hasAttribute('data-row-key'))
        .map((row) =>
          Array.from(row.querySelectorAll('td'), (cell) => cell.textContent),
        ),
    ).toEqual([
      ['Claude Sonnet 4.5', 'Запрет', '—', ''],
      ['Claude Sonnet 4.5', 'Право', `30${NBSP}$`, ''],
    ]);

    // Row 9 - blocking: «Отмена» and Escape send nothing; the confirmation sends one POST while its button is unavailable
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Заблокировать' }));
    confirm = await screen.findByRole('alertdialog', {
      name: 'Заблокировать Аня Смирнова?',
    });
    expect(
      within(confirm).getByText(
        'Сеансы сотрудника закроются сразу, а работающие агенты закончатся на своём следующем шаге. Беседы и данные сохранятся.',
      ),
    ).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Заблокировать' }));
    await screen.findByRole('alertdialog', {
      name: 'Заблокировать Аня Смирнова?',
    });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(changesSince(api, mark)).toEqual([]);

    const blockAnswer = deferred();
    server.use(
      http.post(
        `${API}/api/admin/users/:id/block`,
        async ({ params }) => {
          await blockAnswer.promise;
          const found = store.users.find((entry) => entry.id === params.id);
          if (found !== undefined) found.status = 'disabled';
          return HttpResponse.json(
            adminUserSummary({ id: ANYA, status: 'disabled' }),
          );
        },
        { once: true },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Заблокировать' }));
    confirm = await screen.findByRole('alertdialog', {
      name: 'Заблокировать Аня Смирнова?',
    });
    const blockButton = within(confirm).getByRole('button', {
      name: 'Заблокировать',
    });
    await user.click(blockButton);
    await waitFor(() => expect(blockButton).toBeDisabled());
    await user.click(blockButton);
    blockAnswer.resolve();
    await expectSent(
      api,
      mark,
      [{ method: 'POST', path: `/api/admin/users/${ANYA}/block`, body: null }],
      `/api/admin/users/${ANYA}`,
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(
      await screen.findByRole('button', { name: 'Разблокировать' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Отключён')).toBeInTheDocument();
    expect(
      await screen.findByText('Сотрудник заблокирован'),
    ).toBeInTheDocument();

    // Row 9 - a 404 of a page action: «Запись не найдена», no text at the action, the employee read again
    server.use(
      http.post(
        `${API}/api/admin/users/:id/unblock`,
        () => apiError(404, IdentityErrorCode.USER_NOT_FOUND, 'User not found'),
        {
          once: true,
        },
      ),
    );
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Разблокировать' }));
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Запись не найдена',
      }),
    ).toBeInTheDocument();
    await expectSent(
      api,
      mark,
      [
        {
          method: 'POST',
          path: `/api/admin/users/${ANYA}/unblock`,
          body: null,
        },
      ],
      `/api/admin/users/${ANYA}`,
    );
    expect(screen.queryByText(/Не удалось сохранить/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Разблокировать' })).toBeNull();

    // Row 4 - the built-in role (DC-5): first in the list, no «Переименовать» / «Удалить», its admin right cannot be switched off
    await open('/admin/roles', 'Роли');
    const roles = await screen.findByRole('table', { name: 'Роли' });
    expect(
      within(roles)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual(['Супер-администраторвстроенная0да', 'SRE1—', 'Дежурный1—']);
    await open(`/admin/roles/${BUILTIN_ROLE}/rights`, 'Супер-администратор');
    expect(screen.getByText('встроенная')).toBeInTheDocument();
    const builtinSwitch = await screen.findByRole('switch', {
      name: 'Право администратора',
    });
    expect(builtinSwitch).toBeChecked();
    expect(builtinSwitch).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.queryByRole('button', { name: 'Действия: Супер-администратор' }),
    ).toBeNull();
    expect(screen.queryByText('Переименовать')).toBeNull();
    expect(screen.queryByText('Удалить')).toBeNull();

    // Row 4: the switch of «Дежурный» sends `{ isAdmin }`
    await open(`/admin/roles/${DUTY}/rights`, 'Дежурный');
    const dutySwitch = await screen.findByRole('switch', {
      name: 'Право администратора',
    });
    expect(dutySwitch).not.toBeChecked();
    mark = api.requests.length;
    await user.click(dutySwitch);
    confirm = await screen.findByRole('alertdialog', {
      name: 'Дать роли «Дежурный» право администратора?',
    });
    expect(
      within(confirm).getByText(
        'Все сотрудники роли станут администраторами: 1.',
      ),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(changesSince(api, mark)).toEqual([]);
    expect(dutySwitch).not.toBeChecked();
    await waitFor(() => expect(dutySwitch).toHaveFocus());
    await user.click(dutySwitch);
    confirm = await screen.findByRole('alertdialog', {
      name: 'Дать роли «Дежурный» право администратора?',
    });
    await user.click(
      within(confirm).getByRole('button', { name: 'Дать право' }),
    );
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PATCH',
          path: `/api/admin/roles/${DUTY}`,
          body: { isAdmin: true },
        },
      ],
      `/api/admin/roles/${DUTY}`,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Право администратора' }),
      ).toBeChecked(),
    );
    mark = api.requests.length;
    await user.click(
      screen.getByRole('switch', { name: 'Право администратора' }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PATCH',
          path: `/api/admin/roles/${DUTY}`,
          body: { isAdmin: false },
        },
      ],
      `/api/admin/roles/${DUTY}`,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Право администратора' }),
      ).not.toBeChecked(),
    );

    // Row 9 - deleting a role: `409 BUILTIN_ROLE` is shown in the dialog and the role is read again; the confirmed
    // delete sends one DELETE, opens the list with the toast and the focus on its `h1`
    server.use(
      http.delete(
        `${API}/api/admin/roles/:id`,
        () =>
          apiError(
            409,
            IdentityErrorCode.BUILTIN_ROLE,
            'The built-in role cannot be changed',
          ),
        {
          once: true,
        },
      ),
    );
    mark = api.requests.length;
    await user.click(
      screen.getByRole('button', { name: 'Действия: Дежурный' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Удалить' }));
    confirm = await screen.findByRole('alertdialog', {
      name: 'Удалить роль «Дежурный»?',
    });
    expect(
      within(confirm).getByText(
        'Сотрудники роли сразу потеряют её доступ и права.',
      ),
    ).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Удалить' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'Не удалось сохранить: The built-in role cannot be changed',
    );
    await expectSent(
      api,
      mark,
      [{ method: 'DELETE', path: `/api/admin/roles/${DUTY}`, body: null }],
      `/api/admin/roles/${DUTY}`,
    );
    mark = api.requests.length;
    await user.click(within(confirm).getByRole('button', { name: 'Удалить' }));
    await waitFor(() =>
      expect(view.router.push).toHaveBeenCalledWith('/admin/roles'),
    );
    await waitFor(() =>
      expect(changesSince(api, mark)).toEqual([
        { method: 'DELETE', path: `/api/admin/roles/${DUTY}`, body: null },
      ]),
    );
    expect(await screen.findByText('Роль удалена')).toBeInTheDocument();
    view.setPathname('/admin/roles');
    const rolesTitle = await screen.findByRole('heading', {
      level: 1,
      name: 'Роли',
    });
    await waitFor(() => expect(rolesTitle).toHaveFocus());
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Роли' }))
          .getAllByRole('row')
          .slice(1)
          .map((row) => row.textContent),
      ).toEqual(['Супер-администраторвстроенная0да', 'SRE1—']),
    );
    expect(readsAfterChange(api, mark)).toContain('/api/admin/roles');

    // Row 5 - the rights of «SRE»: models only, none yet
    await open(`/admin/roles/${SRE}/models`, 'SRE');
    // No grant yet: the section shows its empty state, not a table; the tab's panel holds the section.
    expect(
      await screen.findByText('Роли не разрешена ни одна модель'),
    ).toBeInTheDocument();
    const sreGrants = screen.getByRole('tabpanel', { name: 'Модели' });

    // Row 5 and row 6 - a model with a quota of 50; each refusal of the server keeps the dialog open with its fields
    // and changes no row (DC-12)
    await user.click(screen.getByRole('button', { name: 'Разрешить модель' }));
    const modelDialog = await screen.findByRole('dialog', {
      name: 'Разрешить модель',
    });
    await chooseOption(user, modelDialog, 'Модель', 'Claude Sonnet 4.5');
    await user.type(
      within(modelDialog).getByLabelText('Квота за месяц, $'),
      '50',
    );
    const rightsBefore = sreGrants.textContent;
    const refusals: Array<{ answer: () => Response; text: string }> = [
      {
        answer: () =>
          apiError(409, AccessErrorCode.GRANT_EXISTS, 'Grant exists'),
        text: 'Такое право уже есть',
      },
      {
        answer: () =>
          apiError(
            422,
            AccessErrorCode.GRANT_TARGET_UNKNOWN,
            'Model unknown',
            'model_unknown',
          ),
        text: 'Этой модели больше нет. Закройте окно и выберите модель снова.',
      },
      {
        answer: () =>
          apiError(
            422,
            AccessErrorCode.GRANT_INVALID,
            'Quota not on a model allow',
            'quota_not_on_model_allow',
          ),
        text: 'Так нельзя: запрет даётся только лично, а квота — только у разрешения модели.',
      },
      {
        answer: () =>
          apiError(
            422,
            AccessErrorCode.GRANT_INVALID,
            'Quota out of range',
            'quota_out_of_range',
          ),
        text: 'Квота — от 0,01 до 1 000 000 $, не больше двух знаков после запятой',
      },
    ];
    mark = api.requests.length;
    for (const refusal of refusals) {
      server.use(
        http.post(`${API}/api/admin/grants`, refusal.answer, { once: true }),
      );
      await user.click(
        within(modelDialog).getByRole('button', { name: 'Разрешить' }),
      );
      expect(
        await within(modelDialog).findByText(refusal.text),
      ).toBeInTheDocument();
      expect(
        within(modelDialog).getByRole('combobox', { name: 'Модель' }),
      ).toHaveTextContent('Claude Sonnet 4.5');
      expect(
        within(modelDialog).getByLabelText('Квота за месяц, $'),
      ).toHaveValue('50');
    }
    expect(
      within(modelDialog).getByLabelText('Квота за месяц, $'),
    ).toHaveAttribute('aria-invalid', 'true');
    expect(sreGrants.textContent).toBe(rightsBefore);
    await user.click(
      within(modelDialog).getByRole('button', { name: 'Разрешить' }),
    );
    const modelGrantBody = {
      roleId: SRE,
      effect: 'allow',
      target: { kind: 'model', model: SONNET },
      quotaUsd: 50,
    };
    await expectSent(
      api,
      mark,
      refusals.concat(refusals.slice(0, 1)).map(() => ({
        method: 'POST',
        path: '/api/admin/grants',
        body: modelGrantBody,
      })),
      `/api/admin/grants?roleId=${SRE}`,
    );
    expect(changesSince(api, mark)).toHaveLength(5);
    expect(
      await within(sreGrants).findByText('Claude Sonnet 4.5'),
    ).toBeInTheDocument();
    expect(rowCells(sreGrants, 'Claude Sonnet 4.5')).toEqual([
      'Claude Sonnet 4.5',
      'Право',
      `50${NBSP}$`,
      '',
    ]);

    // Row 5 (AC-29.2): reopening Аня and the role shows 30 and 50 as they were set
    await open(`/admin/users/${ANYA}/models`, 'Аня Смирнова');
    const anyaRights = await screen.findByRole('table', {
      name: 'Модели',
    });
    // Her deny and her allow of the same model: the allow keeps its quota.
    await waitFor(() =>
      expect(within(anyaRights).getAllByText('Claude Sonnet 4.5')).toHaveLength(
        2,
      ),
    );
    expect(
      within(anyaRights)
        .getAllByRole('row')
        .filter((row) => row.hasAttribute('data-row-key'))
        .map((row) =>
          Array.from(row.querySelectorAll('td'), (cell) => cell.textContent),
        ),
    ).toContainEqual(['Claude Sonnet 4.5', 'Право', `30${NBSP}$`, '']);
    await open(`/admin/roles/${SRE}/models`, 'SRE');
    const rights = await screen.findByRole('table', { name: 'Модели' });
    expect(
      await within(rights).findByText('Claude Sonnet 4.5'),
    ).toBeInTheDocument();
    expect(rowCells(rights, 'Claude Sonnet 4.5')).toEqual([
      'Claude Sonnet 4.5',
      'Право',
      `50${NBSP}$`,
      '',
    ]);

    // Row 5 (DC-14): «Изменить квоту» 80, then an emptied field; the list shows what the new read returns
    const modelGrant = store.grants.find(
      (entry) => entry.holder.id === SRE && entry.target.kind === 'model',
    );
    const changeQuota = async (typed: string): Promise<void> => {
      await user.click(
        within(rights).getByRole('button', {
          name: 'Действия: Claude Sonnet 4.5',
        }),
      );
      expect(
        (await screen.findAllByRole('menuitem')).map(
          (item) => item.textContent,
        ),
      ).toEqual(['Изменить квоту', 'Убрать']);
      await user.click(
        screen.getByRole('menuitem', { name: 'Изменить квоту' }),
      );
      const quotaDialog = await screen.findByRole('dialog', {
        name: 'Изменить квоту',
      });
      await user.clear(within(quotaDialog).getByLabelText('Квота за месяц, $'));
      if (typed !== '')
        await user.type(
          within(quotaDialog).getByLabelText('Квота за месяц, $'),
          typed,
        );
      mark = api.requests.length;
      await user.click(
        within(quotaDialog).getByRole('button', { name: 'Сохранить' }),
      );
    };
    await changeQuota('80');
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PATCH',
          path: `/api/admin/grants/${modelGrant?.id}`,
          body: { quotaUsd: 80 },
        },
      ],
      `/api/admin/grants?roleId=${SRE}`,
    );
    await waitFor(() =>
      expect(rowCells(rights, 'Claude Sonnet 4.5')).toEqual([
        'Claude Sonnet 4.5',
        'Право',
        `80${NBSP}$`,
        '',
      ]),
    );
    await changeQuota('');
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PATCH',
          path: `/api/admin/grants/${modelGrant?.id}`,
          body: { quotaUsd: null },
        },
      ],
      `/api/admin/grants?roleId=${SRE}`,
    );
    await waitFor(() =>
      expect(rowCells(rights, 'Claude Sonnet 4.5')).toEqual([
        'Claude Sonnet 4.5',
        'Право',
        'без квоты',
        '',
      ]),
    );

    // Row 9 - «Убрать» sends one DELETE without a dialog (UC-E9)
    await user.click(
      within(rights).getByRole('button', {
        name: 'Действия: Claude Sonnet 4.5',
      }),
    );
    expect(
      (await screen.findAllByRole('menuitem')).map((item) => item.textContent),
    ).toEqual(['Изменить квоту', 'Убрать']);
    mark = api.requests.length;
    await user.click(screen.getByRole('menuitem', { name: 'Убрать' }));
    await expectSent(
      api,
      mark,
      [
        {
          method: 'DELETE',
          path: `/api/admin/grants/${modelGrant?.id}`,
          body: null,
        },
      ],
      `/api/admin/grants?roleId=${SRE}`,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // The last grant is gone: the section's empty state replaces its table.
    expect(
      await screen.findByText('Роли не разрешена ни одна модель'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Claude Sonnet 4.5')).toBeNull();

    // Row 1 - a local account (AC-25.3); the account rows come last, so a defect in them does not hide the rights rows
    await open('/admin/users', 'Сотрудники');
    expect(await screen.findByText('Аня Смирнова')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Завести учётную запись' }),
    );
    const accountDialog = await screen.findByRole('dialog', {
      name: 'Новая учётная запись',
    });
    await user.type(within(accountDialog).getByLabelText('Логин'), 'anya');
    await user.type(within(accountDialog).getByLabelText('Имя'), 'Борис Ким');
    await user.type(
      within(accountDialog).getByLabelText('Почта'),
      'boris@corp.example',
    );
    await user.type(
      within(accountDialog).getByLabelText('Начальный пароль'),
      'Kh7short',
    );
    mark = api.requests.length;
    await user.click(
      within(accountDialog).getByRole('button', { name: 'Завести' }),
    );

    // Assert (row 1): a password of 8 characters sends nothing; the focus is on its field with the rule
    const passwordField =
      within(accountDialog).getByLabelText('Начальный пароль');
    await waitFor(() => expect(passwordField).toHaveFocus());
    expect(
      within(accountDialog).getByText('Пароль — от 12 до 256 знаков'),
    ).toBeInTheDocument();
    expect(changesSince(api, mark)).toEqual([]);

    // Act (row 1): a valid password, but the login is taken
    server.use(
      http.post(
        `${API}/api/admin/users`,
        () => apiError(409, IdentityErrorCode.LOGIN_TAKEN, 'Login is taken'),
        {
          once: true,
        },
      ),
    );
    const password = 'Kh7short-Start-2026';
    await user.type(passwordField, '-Start-2026');
    await user.click(
      within(accountDialog).getByRole('button', { name: 'Завести' }),
    );

    // Assert (row 1): «Такой логин уже есть» at «Логин», every field kept
    expect(
      await within(accountDialog).findByText('Такой логин уже есть'),
    ).toBeInTheDocument();
    expect(within(accountDialog).getByLabelText('Логин')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(within(accountDialog).getByLabelText('Имя')).toHaveValue(
      'Борис Ким',
    );
    expect(within(accountDialog).getByLabelText('Почта')).toHaveValue(
      'boris@corp.example',
    );
    expect(passwordField).toHaveValue(password);

    // Act (row 1): another login
    await user.clear(within(accountDialog).getByLabelText('Логин'));
    await user.type(within(accountDialog).getByLabelText('Логин'), 'boris');
    await user.click(
      within(accountDialog).getByRole('button', { name: 'Завести' }),
    );

    // Assert (row 1): two POSTs with the typed fields, the list read again, the row «локальная» with the login, the toast names the login
    const accountBody = {
      login: 'anya',
      name: 'Борис Ким',
      email: 'boris@corp.example',
      password,
    };
    await expectSent(
      api,
      mark,
      [
        { method: 'POST', path: '/api/admin/users', body: accountBody },
        {
          method: 'POST',
          path: '/api/admin/users',
          body: { ...accountBody, login: 'boris' },
        },
      ],
      '/api/admin/users',
    );
    expect(
      await screen.findByText('Учётная запись boris заведена'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const users = screen.getByRole('table', { name: 'Сотрудники' });
    expect(
      await within(users).findByText('boris · boris@corp.example'),
    ).toBeInTheDocument();
    expect(rowCells(users, 'Борис Ким')[0]).toBe(
      'Борис Кимлокальнаяboris · boris@corp.example',
    );
    expect(rowCells(users, 'Аня Смирнова')[0]).toBe(
      'Аня Смирноваanya@corp.example',
    );
    // The dialog opened again starts empty: the password did not outlive the dialog that sent it (Invariant 3)
    await user.click(
      screen.getByRole('button', { name: 'Завести учётную запись' }),
    );
    const reopened = await screen.findByRole('dialog', {
      name: 'Новая учётная запись',
    });
    expect(within(reopened).getByLabelText('Начальный пароль')).toHaveValue('');
    expect(within(reopened).getByLabelText('Логин')).toHaveValue('');
    await user.click(within(reopened).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expectNowhere(password, { spies: navigationSpies() });

    // Row 2 - password reset of that employee (AC-25.3, NFR-02)
    await followLink(
      user,
      within(users).getByRole('link', { name: /Борис Ким/ }),
      view.setPathname,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Борис Ким' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Сбросить пароль' }));
    let resetDialog = await screen.findByRole('dialog', {
      name: 'Новый пароль для Борис Ким',
    });
    const newPassword = 'Reset-Pass-4471x';
    await user.type(
      within(resetDialog).getByLabelText('Новый пароль'),
      newPassword,
    );
    mark = api.requests.length;
    await user.click(
      within(resetDialog).getByRole('button', { name: 'Сбросить' }),
    );

    // Assert (row 2): one PUT with the password, the notice, a new read; the password is nowhere afterwards
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PUT',
          path: `/api/admin/users/${BORIS}/password`,
          body: { password: newPassword },
        },
      ],
      `/api/admin/users/${BORIS}`,
    );
    expect(
      await screen.findByText('Пароль сброшен — передайте новый сотруднику'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expectNowhere(newPassword, { spies: navigationSpies() });
    await user.click(screen.getByRole('button', { name: 'Сбросить пароль' }));
    resetDialog = await screen.findByRole('dialog', {
      name: 'Новый пароль для Борис Ким',
    });
    expect(within(resetDialog).getByLabelText('Новый пароль')).toHaveValue('');
    await user.click(
      within(resetDialog).getByRole('button', { name: 'Отмена' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }, 120_000);

  // INT-3 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-26.1 "Given администратор создаёт провайдера OIDC для Okta, when он открывает его, then видит данные Agent OS для Okta и может скопировать
  //   каждое значение"; AC-26.3 "Given администратор открывает настройки входа, when он смотрит сроки жизни сеанса, then видит действующие значения
  //   обоих сроков и может изменить каждый"; AC-26.4 "Given администратор добавляет провайдера, when он выбирает тип из списка первой версии (FR-03), then
  //   видит поля настроек именно этого типа"; AC-27.1 "Given администратор регистрирует Sentry MCP по адресу в режиме личного OAuth, when он подключает
  //   свой аккаунт Sentry, then видит список инструментов Sentry с пометками «читает» и «меняет»"; NFR-02 (web half) "ни секрет, ни токен не попадает
  //   в лог, уведомление, заголовок вкладки и сообщение об ошибке". Design: DC-7, DC-8, DC-9, DC-10, DC-11; UC-7..UC-10, UC-E3, UC-E4, UC-E5, UC-E8.
  // Behavior: the administrator configures how people sign in and which servers agents may reach -> a secret lives only in its field until sent and is
  //   never shown back; the screen does what it says when the server refuses; leaving for the owner's sign-in is a navigation of the tab.
  // Rows (texts from uxrd.md MC-27..MC-29, MC-33; `[support] expectNowhere(value)` sweeps the document text and every input value, `document.title`, the
  //   toasts, the announcer and the logger stand-in for a known value):
  //   1. providers (AC-26.4, AC-26.1): «Авторизация» shows the permanent row «Логин и пароль» «Всегда включён» (not in the response), then
  //      `GET /api/admin/providers`; creating OIDC sends `POST /api/admin/providers` with `{ type: 'oidc', name }` and opens the provider's page with
  //      «Issuer», «Client ID», «Client secret»; creating Google shows «Client ID», «Client secret» WITHOUT «Issuer» and the Google warning; «Данные для
  //      провайдера» lists «Адрес возврата» and «Scopes» from `providerData`, each with «Копировать: {подпись}» that puts the exact value on the
  //      clipboard and shows «Скопировано»
  //   2. enabling (DC-8): the switch «Включено» sends `PATCH /api/admin/providers/:id` with `{ enabled: true }`; `409 PROVIDER_INCOMPLETE` returns the
  //      switch to «выкл.» with «Нельзя включить: сначала заполните настройки провайдера.» under it (role `alert`); `409 PUBLIC_URL_REQUIRED` does the
  //      same with the server's text (no UXRD text exists, see the report); `422 PROVIDER_CHECK_FAILED` with `invalid_document` is a form error
  //      «Не удалось проверить настройки провайдера: по этому адресу нет описания OIDC для этого Issuer. Настройки не сохранены.» with the fields kept
  //   3. secret of a provider (NFR-02, UC-E3): with `options.clientSecretSet: true` the «Client secret» field reads «Задан» with no input; changing the
  //      name and «Сохранить» sends a `PATCH` whose body has NO `options.clientSecret` key; «Заменить» -> a known value -> «Сохранить» sends it in a
  //      second `PATCH`; afterwards «Задан» again and `expectNowhere(value)` finds it nowhere, also after a refused save (`422`) and a reload of the page
  //   4. sign-in settings (AC-26.3, DC-7): with `idleMinutes` 480 and `absoluteMinutes` 1440 the fields show «8» and «24»; entering «0,25» and «24» and
  //      «Сохранить» sends ONE `PUT /api/admin/settings/sign-in` with the shown address, `idleMinutes: 15`, `absoluteMinutes: 1440` (minutes, not the
  //      hours typed), then the fields show the new read and the toast «Настройки входа сохранены»; with `publicUrl: null` the address
  //      field shows the page address the administrator opened the web at; an out-of-range value («0,3» hours) sends no request and puts the focus on the field
  //   5. register a server, personal OAuth (AC-27.1, DC-9): «Зарегистрировать сервер» -> «Имя» sentry, «Адрес», «Личный OAuth» -> ONE
  //      `POST /api/admin/mcp-servers` with `{ name, url, mode: 'oauth' }` (no token key); `201 awaiting_admin_account` sends the TAB to
  //      `/api/admin/mcp-servers/sentry/connect` by navigation ([support] `location.assign` spy) and no `fetch` goes there; the tab returns at
  //      `/admin/servers/sentry?connected=1`: «Включён» and the tools in «Меняют» and «Читают» (ST-01), and `connected` is removed from the address (a
  //      reload does not repeat it); `?error=connect_failed` shows «Ждёт аккаунта администратора», «Подключить мой аккаунт» (the same connect address)
  //      and the MC-29 text once; `?error=tools_failed` shows its text above the table
  //   6. register a server, shared token (DC-10): «Общая учётная запись» -> «Токен доступа» -> `POST` with `{ mode: 'shared', sharedToken }`, the button
  //      reads «Проверяем сервер…»; `422 MCP_SERVER_CHECK_FAILED` with `unauthorized` is the form error «Не удалось зарегистрировать: сервер не принял
  //      токен доступа» with the fields kept; `409 MCP_SERVER_NAME_TAKEN` is the field error «Сервер с таким именем уже есть»
  //   7. server page (DC-10, UC-10): name, address and mode are read-only text (no input) with the hint to delete and register again; «Токен доступа»
  //      reads «Задан»; replacing it sends `PATCH /api/admin/mcp-servers/:name` with `{ sharedToken }` and `expectNowhere(value)` finds nothing; the
  //      switch «Включён» sends `{ enabled: false }`; on an awaiting server `409 MCP_SERVER_INCOMPLETE` returns the switch with «Нельзя включить: сначала
  //      подключите свой аккаунт и получите список инструментов.»; «Удалить» -> «Удалить сервер «{имя}»?» -> one `DELETE /api/admin/mcp-servers/:name`
  //      and the list
  //   8. refresh (DC-11, UC-E8): «Обновить список» sends `POST /api/admin/mcp-servers/:name/tools/refresh`, shows «Обновляем…», then «Список
  //      обновлён: новых {N}, убрано {M}» from `added` and `removed` and the new tools with the MC-36 warning, which «Отметить просмотренными» clears with one `POST .../tools/reviewed`; `409 MCP_ACCOUNT_REQUIRED` shows NO error text and sends
  //      the tab to the same connect address as «Подключить мой аккаунт»; `422 MCP_SERVER_CHECK_FAILED` keeps the old tool list and shows its reason
  // Catches: a provider secret or shared token kept in page state, a toast, a log record, a title or an error text after it was sent (the one defect
  //   that makes «не показывается обратно» a fiction); a replacement secret sent on every save or the stored one overwritten with an empty value; a
  //   switch that stays «вкл.» after the server refused, so the administrator thinks sign-in works; the session limit sent in hours where the server
  //   reads minutes (an idle limit of 0,25 minutes instead of 15); the connect step done by `fetch` (the tab never reaches the owner's sign-in and the server stays
  //   «Ждёт аккаунта»); `connected` / `error` left in the address and replayed on reload; fields shown for the wrong provider type; a tool list
  //   replaced by an empty one after a refused refresh.
  // @category: core-functionality
  // @dependency: sign-in (providers, settings) and MCP server screens, SecretField, CopyValue, AdminForm, adminApi (providers, signInSettings, servers), logger stand-in, clipboard stub, location.assign spy, toast, announcer, MSW, next/navigation mock
  // @complexity: high
  it("INT-3 / UC-7..UC-10 / UC-E3 / UC-E4 / UC-E5 / UC-E8: provider fields and copyable data per type, a refused enable returns the switch, a secret is never read back, session hours are sent as minutes, a server registers and returns from the owner's sign-in with its tools, and refresh without an administrator account goes to the connect address", async () => {
    // Arrange: an administrator, no providers yet, the default sign-in settings without an address, the registry with `jira`
    const { store, handlers } = signInBackend();
    server.use(
      http.get(`${API}/api/auth/me`, () =>
        HttpResponse.json(
          currentUser({
            isAdmin: true,
            name: 'Игорь Петров',
            email: 'igor@corp.example',
          }),
        ),
      ),
      ...handlers,
    );
    const api = trackRequests(server);
    const user = userEvent.setup({ delay: null });
    const writeText = stubClipboard();
    let view = renderWithRuntime({ pathname: '/admin/sign-in' });
    const navigationSpies = () => [
      view.router.push,
      view.router.replace,
      view.assign,
    ];
    const open = async (pathname: string, title: string): Promise<void> => {
      view.setPathname(pathname);
      expect(
        await screen.findByRole('heading', { level: 1, name: title }),
      ).toBeInTheDocument();
    };
    const connectRequests = (): string[] =>
      api.requests
        .filter((request) => request.path.endsWith('/connect'))
        .map((request) => request.path);
    const googleWarning =
      'Включённый Google пускает любого владельца аккаунта Google: первый вход создаёт учётную запись без ролей. Пока вы не дадите ей права, чат ей не отвечает.';
    let mark = 0;

    // Row 1 - «Авторизация»: the permanent password row comes first and is not from the response
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Авторизация' }),
    ).toBeInTheDocument();
    const methods = await screen.findByRole('table', { name: 'Способы входа' });
    expect(bodyRows(methods)).toEqual([
      'Логин и парольвстроенныйВсегда включён',
    ]);
    expect(within(methods).queryAllByRole('link')).toEqual([]);
    expect(readsAfterChange(api, 0)).toContain('/api/admin/providers');

    // Row 4 - sign-in settings (AC-26.3, DC-7): hours from the stored minutes, the page address while none is saved
    const address = await screen.findByLabelText('Публичный адрес Agent OS');
    expect(address).toHaveValue('http://api.test');
    const idle = screen.getByLabelText('Без активности');
    expect(idle).toHaveValue('8');
    expect(screen.getByLabelText('Всего с момента входа')).toHaveValue('24');

    // Act (row 4): 0,3 hours is off the 0,25 step - nothing is sent, the focus is on the field with the MC-33 rule
    await user.clear(idle);
    await user.type(idle, '0,3');
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(idle).toHaveFocus());
    expect(
      screen.getByText('Введите от 0,25 до 24 часов с шагом 0,25'),
    ).toBeInTheDocument();
    expect(changesSince(api, mark)).toEqual([]);

    // Act (row 4): the public address and 0,25 hours
    await user.clear(address);
    await user.type(address, 'https://agent-os.corp.example');
    await user.clear(idle);
    await user.type(idle, '0,25');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    // Assert (row 4): ONE PUT with both limits in minutes, then the fields show the new read
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PUT',
          path: '/api/admin/settings/sign-in',
          body: {
            publicUrl: 'https://agent-os.corp.example',
            idleMinutes: 15,
            absoluteMinutes: 1440,
          },
        },
      ],
      '/api/admin/settings/sign-in',
    );
    expect(
      await screen.findByText('Настройки входа сохранены'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Без активности')).toHaveValue('0,25'),
    );
    expect(screen.getByLabelText('Всего с момента входа')).toHaveValue('24');
    expect(screen.getByLabelText('Публичный адрес Agent OS')).toHaveValue(
      'https://agent-os.corp.example',
    );

    // Row 1 - a new provider (AC-26.4): Google by default with its warning; OIDC drops both and sends `{ type, name }`
    await followLink(
      user,
      screen.getByRole('link', { name: 'Добавить провайдера' }),
      view.setPathname,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Новый провайдер' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Google' })).toBeChecked();
    expect(screen.getByLabelText('Название кнопки')).toHaveValue('Google');
    expect(screen.getByText(googleWarning)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'OIDC' }));
    expect(screen.queryByText(googleWarning)).toBeNull();
    expect(screen.getByLabelText('Название кнопки')).toHaveValue('');
    await user.type(screen.getByLabelText('Название кнопки'), 'Okta');
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Создать' }));
    await waitFor(() =>
      expect(view.router.push).toHaveBeenCalledWith(`/admin/sign-in/${OKTA}`),
    );
    await waitFor(() =>
      expect(changesSince(api, mark)).toEqual([
        {
          method: 'POST',
          path: '/api/admin/providers',
          body: { type: 'oidc', name: 'Okta' },
        },
      ]),
    );

    // Assert (row 1): the OIDC page has «Issuer», «Client ID» and an empty «Client secret»; both values copy exactly (AC-26.1)
    await open(`/admin/sign-in/${OKTA}`, 'Okta');
    expect(screen.getByLabelText('Issuer')).toHaveValue('');
    expect(screen.getByLabelText('Client ID')).toHaveValue('');
    expect(screen.getByLabelText('Client secret')).toHaveAttribute(
      'type',
      'password',
    );
    const redirectUri = `https://agent-os.corp.example/api/auth/oauth/${OKTA}/callback`;
    expect(screen.getByText(redirectUri)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Копировать: Адрес возврата' }),
    );
    expect(writeText).toHaveBeenLastCalledWith(redirectUri);
    expect(await screen.findAllByText('Скопировано')).not.toHaveLength(0);
    await user.click(
      screen.getByRole('button', { name: 'Копировать: Scopes' }),
    );
    expect(writeText).toHaveBeenLastCalledWith('openid email profile');
    expect(writeText).toHaveBeenCalledTimes(2);

    // Row 3 - the client secret (NFR-02, UC-E3): the check refuses the settings (`422 PROVIDER_CHECK_FAILED`)
    const secret = 'okta-secret-9f3K2xQ';
    await user.type(screen.getByLabelText('Issuer'), 'https://corp.okta.com');
    await user.type(screen.getByLabelText('Client ID'), 'agent-os-client');
    await user.type(screen.getByLabelText('Client secret'), secret);
    server.use(
      http.patch(
        `${API}/api/admin/providers/:id`,
        () =>
          apiError(
            422,
            IdentityErrorCode.PROVIDER_CHECK_FAILED,
            'Provider check failed',
            'invalid_document',
          ),
        { once: true },
      ),
    );
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    // Assert (row 3): the form error, every field kept; the typed secret is only in its own field
    expect(
      await screen.findByText(
        'Не удалось проверить настройки провайдера: по этому адресу нет описания OIDC для этого Issuer. Настройки не сохранены.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Issuer')).toHaveValue(
      'https://corp.okta.com',
    );
    expect(screen.getByLabelText('Client ID')).toHaveValue('agent-os-client');
    expect(screen.getByLabelText('Client secret')).toHaveValue(secret);
    expectNowhere(secret, {
      exceptInput: 'Client secret',
      spies: navigationSpies(),
    });

    // Act (row 3): the same save accepted
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    const oktaOptions = {
      issuer: 'https://corp.okta.com',
      clientId: 'agent-os-client',
    };
    const oktaSave = {
      method: 'PATCH',
      path: `/api/admin/providers/${OKTA}`,
      body: { name: 'Okta', options: { ...oktaOptions, clientSecret: secret } },
    };
    await expectSent(
      api,
      mark,
      [oktaSave, oktaSave],
      `/api/admin/providers/${OKTA}`,
    );

    // Assert (row 3): «Задан» with «Заменить» and no input; the secret is nowhere
    expect(
      await screen.findByRole('button', { name: 'Заменить: Client secret' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Задан')).toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expectNowhere(secret, { spies: navigationSpies() });

    // Act (row 3): renaming without «Заменить» sends no secret key at all
    mark = api.requests.length;
    await user.clear(screen.getByLabelText('Название кнопки'));
    await user.type(screen.getByLabelText('Название кнопки'), 'Okta SSO');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PATCH',
          path: `/api/admin/providers/${OKTA}`,
          body: { name: 'Okta SSO', options: oktaOptions },
        },
      ],
      `/api/admin/providers/${OKTA}`,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Okta SSO' }),
    ).toBeInTheDocument();

    // Act (row 3): «Заменить» -> a new value -> «Сохранить» sends it once
    const replacement = 'okta-secret-rotated-7Qp';
    await user.click(
      screen.getByRole('button', { name: 'Заменить: Client secret' }),
    );
    await user.type(screen.getByLabelText('Client secret'), replacement);
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PATCH',
          path: `/api/admin/providers/${OKTA}`,
          body: {
            name: 'Okta SSO',
            options: { ...oktaOptions, clientSecret: replacement },
          },
        },
      ],
      `/api/admin/providers/${OKTA}`,
    );
    expect(
      await screen.findByRole('button', { name: 'Заменить: Client secret' }),
    ).toBeInTheDocument();
    expectNowhere(replacement, { spies: navigationSpies() });
    expectNowhere(secret, { spies: navigationSpies() });

    // Row 1 - a Google provider (AC-26.4): «Client ID» and «Client secret» without «Issuer», the warning, no «Scopes»
    await open('/admin/sign-in/new', 'Новый провайдер');
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Создать' }));
    await waitFor(() =>
      expect(view.router.push).toHaveBeenCalledWith(`/admin/sign-in/${GOOGLE}`),
    );
    await waitFor(() =>
      expect(changesSince(api, mark)).toEqual([
        {
          method: 'POST',
          path: '/api/admin/providers',
          body: { type: 'google', name: 'Google' },
        },
      ]),
    );
    await open(`/admin/sign-in/${GOOGLE}`, 'Google');
    expect(screen.getByLabelText('Client ID')).toHaveValue('');
    expect(screen.getByLabelText('Client secret')).toHaveAttribute(
      'type',
      'password',
    );
    expect(screen.queryByLabelText('Issuer')).toBeNull();
    expect(screen.getByText(googleWarning)).toBeInTheDocument();
    expect(
      screen.getByText(
        `https://agent-os.corp.example/api/auth/oauth/${GOOGLE}/callback`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Копировать: Адрес возврата' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Копировать: Scopes' }),
    ).toBeNull();

    // Row 2 - enabling (DC-8): each refusal puts the switch back with its text under it (role `alert`)
    await open('/admin/sign-in', 'Авторизация');
    const providers = await screen.findByRole('table', {
      name: 'Способы входа',
    });
    await waitFor(() =>
      expect(rowCells(providers, 'Okta SSO').slice(0, 2)).toEqual([
        'Okta SSO',
        'OIDC',
      ]),
    );
    expect(rowCells(providers, 'Google').slice(0, 2)).toEqual([
      'Google',
      'Google',
    ]);
    const refusedEnables = [
      {
        id: GOOGLE,
        name: 'Google',
        answer: () =>
          apiError(
            409,
            IdentityErrorCode.PROVIDER_INCOMPLETE,
            'Provider settings are incomplete',
          ),
        text: 'Нельзя включить: сначала заполните настройки провайдера.',
      },
      {
        id: OKTA,
        name: 'Okta SSO',
        answer: () =>
          apiError(
            409,
            IdentityErrorCode.PUBLIC_URL_REQUIRED,
            'Public URL is required',
          ),
        text: 'Сначала сохраните публичный адрес Agent OS в настройках входа.',
      },
    ];
    for (const refused of refusedEnables) {
      const toggle = within(providers).getByRole('switch', {
        name: `Включено: ${refused.name}`,
      });
      expect(toggle).not.toBeChecked();
      server.use(
        http.patch(`${API}/api/admin/providers/:id`, refused.answer, {
          once: true,
        }),
      );
      mark = api.requests.length;
      await user.click(toggle);
      const refusal = await within(providers).findByText(refused.text);
      expect(refusal).toHaveAttribute('role', 'alert');
      await waitFor(() => expect(toggle).not.toBeChecked());
      await waitFor(() =>
        expect(changesSince(api, mark)).toEqual([
          {
            method: 'PATCH',
            path: `/api/admin/providers/${refused.id}`,
            body: { enabled: true },
          },
        ]),
      );
    }
    expect(screen.queryByText('Public URL is required')).toBeNull();

    // Act (row 2): an accepted enable - the switch stands «вкл.» from the new read of the list
    mark = api.requests.length;
    await user.click(
      within(providers).getByRole('switch', { name: 'Включено: Okta SSO' }),
    );
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PATCH',
          path: `/api/admin/providers/${OKTA}`,
          body: { enabled: true },
        },
      ],
      '/api/admin/providers',
    );
    await waitFor(() =>
      expect(
        within(providers).getByRole('switch', { name: 'Включено: Okta SSO' }),
      ).toBeChecked(),
    );
    expect(
      within(providers).queryByText(
        'Сначала сохраните публичный адрес Agent OS в настройках входа.',
      ),
    ).toBeNull();

    // Row 3: a reload of the provider's page reads «Задан» and neither secret
    await open(`/admin/sign-in/${OKTA}`, 'Okta SSO');
    expect(
      await screen.findByRole('button', { name: 'Заменить: Client secret' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Issuer')).toHaveValue(
      'https://corp.okta.com',
    );
    expectNowhere(replacement, { spies: navigationSpies() });
    expectNowhere(secret, { spies: navigationSpies() });

    // Row 5 - register a personal-OAuth server (AC-27.1, Flow 2): no token key, the TAB goes to the connect address
    await open('/admin/servers', 'MCP-серверы');
    const registry = await screen.findByRole('table', { name: 'MCP-серверы' });
    expect(rowCells(registry, 'jira')).toEqual([
      'jirahttps://jira.example/mcp',
      'Личный OAuth',
      '0',
      'Ждёт аккаунта администратора',
    ]);
    await followLink(
      user,
      screen.getByRole('link', { name: 'Зарегистрировать сервер' }),
      view.setPathname,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Регистрация' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Имя'), 'sentry');
    await user.type(
      screen.getByLabelText('Адрес'),
      'https://mcp.sentry.dev/mcp',
    );
    expect(screen.getByLabelText('Токен доступа')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Личный OAuth' }));
    expect(screen.queryByLabelText('Токен доступа')).toBeNull();
    // The Redirect URI is the API's address for the name, not one the browser builds from its own origin.
    expect(
      await screen.findByText(
        'https://agent-os.corp.example/api/mcp/oauth/callback/sentry',
      ),
    ).toBeInTheDocument();
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Зарегистрировать' }));

    // Assert (row 5): one POST, then a navigation of the tab - not a request - to the connect address
    await waitFor(() =>
      expect(view.assign).toHaveBeenCalledWith(connectAddress('sentry')),
    );
    expect(view.assign).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(changesSince(api, mark)).toEqual([
        {
          method: 'POST',
          path: '/api/admin/mcp-servers',
          body: {
            name: 'sentry',
            url: 'https://mcp.sentry.dev/mcp',
            mode: 'oauth',
          },
        },
      ]),
    );
    expect(connectRequests()).toEqual([]);
    expect(view.router.push).not.toHaveBeenCalledWith('/admin/servers/sentry');

    // Act (row 5): the owner signs in at Sentry, the API reads the tools and sends the tab back with `?connected=1`
    store.servers = store.servers.map((entry) =>
      entry.name === 'sentry'
        ? mcpServerView({ name: 'sentry', url: 'https://mcp.sentry.dev/mcp' })
        : entry,
    );
    view.unmount();
    view = renderWithRuntime({
      pathname: '/admin/servers/sentry',
      search: '?connected=1',
    });

    // Assert (row 5): «Включён» and the tools with «читает» / «меняет»; `connected` is gone from the address
    expect(
      await screen.findByRole('heading', { level: 1, name: 'sentry' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/admin/servers/sentry');
    expect(window.location.search).toBe('');
    expect(screen.getByRole('switch', { name: 'Включён' })).toBeChecked();
    expect(toolGroups('sentry')).toEqual(['Меняют: sentry: update_issue']);
    expect(screen.getByText('Меняют · 1')).toBeInTheDocument();
    expect(screen.getByText('Читают · 1')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Читают: sentry' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('alert')).toBeNull();

    // Row 5 - `?error=connect_failed` on a server still waiting: its text once and «Подключить мой аккаунт» to the connect address
    view.unmount();
    view = renderWithRuntime({
      pathname: '/admin/servers/jira',
      search: '?error=connect_failed',
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'jira' }),
    ).toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(
      screen.getAllByText(
        'Не удалось подключить ваш аккаунт: вход отменён или не завершён. Попробуйте ещё раз.',
      ),
    ).toHaveLength(1);
    expect(
      screen.getByText('Ждёт аккаунта администратора'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Подключить мой аккаунт' }),
    ).toHaveAttribute('href', connectAddress('jira'));

    // Row 5 - `?error=tools_failed`: its text above the table, read once - the page opened again has none
    const toolsFailed =
      'Аккаунт подключён, но список инструментов получить не удалось. Нажмите «Обновить список».';
    view.unmount();
    view = renderWithRuntime({
      pathname: '/admin/servers/sentry',
      search: '?error=tools_failed',
    });
    expect(await screen.findByText(toolsFailed)).toBeInTheDocument();
    expect(window.location.search).toBe('');
    await open('/admin/servers', 'MCP-серверы');
    await open('/admin/servers/sentry', 'sentry');
    expect(
      screen.getByRole('region', { name: 'Инструменты sentry' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(toolsFailed)).toBeNull();

    // Row 8 - refresh (DC-11, UC-E8): «Обновляем…» while the answer is held, then the counts and the new read
    const refreshAnswer = deferred();
    server.use(
      http.post(
        `${API}/api/admin/mcp-servers/:name/tools/refresh`,
        async () => {
          // Held, then answered by the store's handler.
          await refreshAnswer.promise;
        },
        { once: true },
      ),
    );
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Обновить список' }));
    expect(
      await screen.findByRole('button', { name: 'Обновляем…' }),
    ).toBeDisabled();
    refreshAnswer.resolve();
    expect(
      await screen.findByText('Список обновлён: новых 1, убрано 1'),
    ).toBeInTheDocument();
    await expectSent(
      api,
      mark,
      [
        {
          method: 'POST',
          path: '/api/admin/mcp-servers/sentry/tools/refresh',
          body: null,
        },
      ],
      '/api/admin/mcp-servers/sentry',
    );
    const refreshedTools = ['Меняют: sentry: create_issue'];
    await waitFor(() => expect(toolGroups('sentry')).toEqual(refreshedTools));
    const newWarning =
      'Новые инструменты: 1. Пока вы их не просмотрели, они считаются меняющими: роли с уровнем «Только чтение» их не получают, а вызовы требуют подтверждения.';
    expect(screen.getByText(newWarning)).toBeInTheDocument();
    expect(screen.getByText('новый — считается меняющим')).toBeInTheDocument();

    // «Отметить просмотренными» sends the one request and the warning goes with the new marks
    mark = api.requests.length;
    await user.click(
      screen.getByRole('button', { name: 'Отметить просмотренными' }),
    );
    await expectSent(
      api,
      mark,
      [
        {
          method: 'POST',
          path: '/api/admin/mcp-servers/sentry/tools/reviewed',
          body: null,
        },
      ],
      '/api/admin/mcp-servers/sentry',
    );
    await waitFor(() => expect(screen.queryByText(newWarning)).toBeNull());
    expect(screen.queryByText('новый — считается меняющим')).toBeNull();

    // Row 8: a failed check keeps the old tools and shows its bare reason
    server.use(
      http.post(
        `${API}/api/admin/mcp-servers/:name/tools/refresh`,
        () =>
          apiError(
            422,
            McpErrorCode.MCP_SERVER_CHECK_FAILED,
            'Server check failed',
            'unreachable',
          ),
        { once: true },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Обновить список' }));
    expect(
      await screen.findByText('сервер не отвечает по этому адресу'),
    ).toBeInTheDocument();
    expect(toolGroups('sentry')).toEqual(refreshedTools);

    // Row 8: no administrator account - no error text, the tab goes to the same connect address, no request goes there
    server.use(
      http.post(
        `${API}/api/admin/mcp-servers/:name/tools/refresh`,
        () =>
          apiError(
            409,
            McpErrorCode.MCP_ACCOUNT_REQUIRED,
            'Connect your account first',
          ),
        { once: true },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Обновить список' }));
    await waitFor(() =>
      expect(view.assign).toHaveBeenCalledWith(connectAddress('sentry')),
    );
    expect(view.assign).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('сервер не отвечает по этому адресу')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(connectRequests()).toEqual([]);

    // Row 6 - register a shared-token server (DC-10): «Проверяем сервер…» while the check runs
    await open('/admin/register-server', 'Регистрация');
    expect(
      screen.getByRole('radio', { name: 'Общая учётная запись' }),
    ).toBeChecked();
    await user.type(screen.getByLabelText('Имя'), 'gitlab');
    await user.type(
      screen.getByLabelText('Адрес'),
      'https://gitlab.corp.example/mcp',
    );
    const token = 'glpat-shared-4Hk2mQz';
    await user.type(screen.getByLabelText('Токен доступа'), token);
    const checkAnswer = deferred();
    server.use(
      http.post(
        `${API}/api/admin/mcp-servers`,
        async () => {
          await checkAnswer.promise;
          return apiError(
            422,
            McpErrorCode.MCP_SERVER_CHECK_FAILED,
            'Server check failed',
            'unauthorized',
          );
        },
        { once: true },
      ),
    );
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Зарегистрировать' }));
    expect(
      await screen.findByRole('button', { name: 'Проверяем сервер…' }),
    ).toBeDisabled();
    checkAnswer.resolve();

    // Assert (row 6): the refusal with the registration's prefix, every field kept, the token only in its own field
    expect(
      await screen.findByText(
        'Не удалось зарегистрировать: сервер не принял токен доступа',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Имя')).toHaveValue('gitlab');
    expect(screen.getByLabelText('Адрес')).toHaveValue(
      'https://gitlab.corp.example/mcp',
    );
    expect(
      screen.getByRole('radio', { name: 'Общая учётная запись' }),
    ).toBeChecked();
    expect(screen.getByLabelText('Токен доступа')).toHaveValue(token);
    expectNowhere(token, {
      exceptInput: 'Токен доступа',
      spies: navigationSpies(),
    });

    // Act (row 6): the name is taken
    server.use(
      http.post(
        `${API}/api/admin/mcp-servers`,
        () =>
          apiError(
            409,
            McpErrorCode.MCP_SERVER_NAME_TAKEN,
            'Server name is taken',
          ),
        {
          once: true,
        },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Зарегистрировать' }));
    expect(
      await screen.findByText('Сервер с таким именем уже есть'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Имя')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText('Токен доступа')).toHaveValue(token);
    expectNowhere(token, {
      exceptInput: 'Токен доступа',
      spies: navigationSpies(),
    });
    // Nothing half-saved: the form stays, no page opened, no navigation
    expect(view.router.push).not.toHaveBeenCalled();
    expect(view.assign).toHaveBeenCalledTimes(1);

    // Act (row 6): another name is accepted
    await user.clear(screen.getByLabelText('Имя'));
    await user.type(screen.getByLabelText('Имя'), 'gitlab-prod');
    await user.click(screen.getByRole('button', { name: 'Зарегистрировать' }));
    await waitFor(() =>
      expect(view.router.push).toHaveBeenCalledWith(
        '/admin/servers/gitlab-prod',
      ),
    );
    const sharedBody = {
      name: 'gitlab',
      url: 'https://gitlab.corp.example/mcp',
      mode: 'shared',
      sharedToken: token,
    };
    await waitFor(() =>
      expect(changesSince(api, mark)).toEqual([
        { method: 'POST', path: '/api/admin/mcp-servers', body: sharedBody },
        { method: 'POST', path: '/api/admin/mcp-servers', body: sharedBody },
        {
          method: 'POST',
          path: '/api/admin/mcp-servers',
          body: { ...sharedBody, name: 'gitlab-prod' },
        },
      ]),
    );
    await waitFor(() => expectNowhere(token, { spies: navigationSpies() }));

    // Row 7 - the server's page (DC-10): name, address and mode are text with the hint, no field holds them
    await open('/admin/servers/gitlab-prod', 'gitlab-prod');
    expect(
      screen.getByText('https://gitlab.corp.example/mcp'),
    ).toBeInTheDocument();
    expect(screen.getByText('Общая учётная запись')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Чтобы сменить адрес или режим, удалите сервер и зарегистрируйте его заново.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(
      screen.queryByDisplayValue('https://gitlab.corp.example/mcp'),
    ).toBeNull();
    expect(screen.queryByDisplayValue('gitlab-prod')).toBeNull();
    expect(screen.getByText('Задан')).toBeInTheDocument();
    expectNowhere(token, { spies: navigationSpies() });

    // Act (row 7): «Сохранить» without a typed replacement is unavailable - no request, no read, no «saved» record
    mark = api.requests.length;
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(api.requests.slice(mark)).toEqual([]);
    expect(
      logRecords.filter((record) =>
        record.message.startsWith('admin: server token'),
      ),
    ).toEqual([]);

    // Act (row 7): a replacement refused by the check, then accepted
    const newToken = 'glpat-rotated-8Zr5VwK';
    await user.click(
      screen.getByRole('button', { name: 'Заменить: Токен доступа' }),
    );
    await user.type(screen.getByLabelText('Токен доступа'), newToken);
    server.use(
      http.patch(
        `${API}/api/admin/mcp-servers/:name`,
        () =>
          apiError(
            422,
            McpErrorCode.MCP_SERVER_CHECK_FAILED,
            'Server check failed',
            'unauthorized',
          ),
        { once: true },
      ),
    );
    mark = api.requests.length;
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(
      await screen.findByText(
        'Не удалось сохранить: сервер не принял токен доступа',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Токен доступа')).toHaveValue(newToken);
    expectNowhere(newToken, {
      exceptInput: 'Токен доступа',
      spies: navigationSpies(),
    });
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    const tokenSave = {
      method: 'PATCH',
      path: '/api/admin/mcp-servers/gitlab-prod',
      body: { sharedToken: newToken },
    };
    await expectSent(
      api,
      mark,
      [tokenSave, tokenSave],
      '/api/admin/mcp-servers/gitlab-prod',
    );
    expect(
      await screen.findByRole('button', { name: 'Заменить: Токен доступа' }),
    ).toBeInTheDocument();
    expectNowhere(newToken, { spies: navigationSpies() });
    expectNowhere(token, { spies: navigationSpies() });

    // Act (row 7): the switch «Включён» sends `{ enabled: false }` and stands as the new read says
    const enabledSwitch = screen.getByRole('switch', { name: 'Включён' });
    expect(enabledSwitch).toBeChecked();
    mark = api.requests.length;
    await user.click(enabledSwitch);
    await expectSent(
      api,
      mark,
      [
        {
          method: 'PATCH',
          path: '/api/admin/mcp-servers/gitlab-prod',
          body: { enabled: false },
        },
      ],
      '/api/admin/mcp-servers/gitlab-prod',
    );
    // The label beside the switch follows its position, like the badge in the header
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Выключен' }),
      ).not.toBeChecked(),
    );
    expect(screen.getAllByText('Выключен')).toHaveLength(2);

    // Row 7 - enabling a server still waiting for the administrator's account: `409 MCP_SERVER_INCOMPLETE` puts the switch back
    await open('/admin/servers/jira', 'jira');
    const jiraSwitch = screen.getByRole('switch', { name: 'Выключен' });
    expect(jiraSwitch).not.toBeChecked();
    server.use(
      http.patch(
        `${API}/api/admin/mcp-servers/:name`,
        () =>
          apiError(
            409,
            McpErrorCode.MCP_SERVER_INCOMPLETE,
            'Server has no tools yet',
          ),
        { once: true },
      ),
    );
    mark = api.requests.length;
    await user.click(jiraSwitch);
    const incomplete = await screen.findByText(
      'Нельзя включить: сначала подключите свой аккаунт и получите список инструментов.',
    );
    expect(incomplete).toHaveAttribute('role', 'alert');
    await waitFor(() => expect(jiraSwitch).not.toBeChecked());
    await waitFor(() =>
      expect(changesSince(api, mark)).toEqual([
        {
          method: 'PATCH',
          path: '/api/admin/mcp-servers/jira',
          body: { enabled: true },
        },
      ]),
    );

    // Row 7 - delete: the confirmation sends ONE DELETE and opens the list
    await open('/admin/servers/gitlab-prod', 'gitlab-prod');
    mark = api.requests.length;
    await user.click(
      screen.getByRole('button', { name: 'Действия: gitlab-prod' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Удалить' }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Удалить сервер «gitlab-prod»?',
    });
    expect(
      within(confirm).getByText(
        'Агенты сразу потеряют его инструменты. Это действие нельзя отменить. Подключённые аккаунты сотрудников на этом сервере будут удалены.',
      ),
    ).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Удалить' }));
    await waitFor(() =>
      expect(view.router.push).toHaveBeenCalledWith('/admin/servers'),
    );
    await waitFor(() =>
      expect(changesSince(api, mark)).toEqual([
        {
          method: 'DELETE',
          path: '/api/admin/mcp-servers/gitlab-prod',
          body: null,
        },
      ]),
    );
    expect(await screen.findByText('Сервер удалён')).toBeInTheDocument();
    await open('/admin/servers', 'MCP-серверы');
    const afterDelete = await screen.findByRole('table', {
      name: 'MCP-серверы',
    });
    await waitFor(() =>
      expect(within(afterDelete).queryByText('gitlab-prod')).toBeNull(),
    );
    expect(within(afterDelete).getByText('sentry')).toBeInTheDocument();
  }, 120_000);

  // INT-4 ---------------------------------------------------------------------------------------------------------------------------------
  // access-levels UC-8: AC-37.5 "«Сохранить» применяет все изменения или ни одно"; AC-37.7 "отмеченный инструмент, которого на сервере больше нет,
  //   стоит в группе «Нет на сервере»"; AC-36.3 "выключенный для всех инструмент можно отметить, в итог он не входит". Design: access-levels KD-7, C3 web.
  // Rows (texts from uxrd.md MC-37, MC-38): the role «SRE» has `github` on «Все», `jira` on «Выборочно» with an orphan mark and `notion` on
  //   «Выборочно» with a tool switched off for everyone; the page is opened by the deep link `?server=jira`.
  //   1. the deep link expands `jira` and puts the focus on its level; the orphan is checked under «Нет на сервере»
  //   2. `notion`: the switched-off tool is checked, badged «выключен для всех» and not counted in the total
  //   3. `github` to «Выборочно» starts with every tool checked; `jira` to «Все» and back to «Выборочно» is its saved value again: one change
  //   4. «Модели» and back keeps the change, and the tab «Инструменты» says it has unsaved changes
  //   5. a refused save sent exactly the one changed row and keeps it on screen with the form error; the next save passes
  // Catches: «Выборочно» starting empty instead of from the previous level; a row back at its saved value still counted or sent; the draft living
  //   in the tab, so a tab switch loses it; a refusal that drops the changes; an orphan or a switched-off mark hidden or counted.
  // @category: core-functionality
  // @dependency: role page, role tools tab, level draft, level editor parts, adminApi roles levels, MSW
  // @complexity: medium
  it('INT-4 / access-levels UC-8: the role levels draft starts «Выборочно» from the previous level, counts and sends only the changed row, survives a tab switch and a refused save', async () => {
    // Arrange
    const { store, handlers } = adminBackend();
    const tool = (
      name: string,
      title: string,
      readOnly: boolean,
      enabled = true,
    ): LevelTool => ({ name, title, readOnly, enabled, isNew: false });
    store.levels.set(SRE, [
      {
        server: 'github',
        status: 'enabled',
        tools: [
          tool('create_issue', 'Создать задачу', false),
          tool('list_issues', 'Список задач', true),
          tool('delete_issue', 'Удалить задачу', false),
        ],
        level: 'all',
        picked: [],
      },
      {
        server: 'jira',
        status: 'enabled',
        tools: [
          tool('search', 'Поиск', true),
          tool('create', 'Создать', false),
        ],
        level: 'pick',
        picked: ['search', 'old_search'],
      },
      {
        server: 'notion',
        status: 'enabled',
        tools: [
          tool('page_read', 'Прочитать страницу', true),
          tool('page_delete', 'Удалить страницу', false, false),
        ],
        level: 'pick',
        picked: ['page_read', 'page_delete'],
      },
    ]);
    server.use(
      http.get(`${API}/api/auth/me`, () =>
        HttpResponse.json(currentUser({ isAdmin: true })),
      ),
      ...handlers,
    );
    const api = trackRequests(server);
    const user = userEvent.setup({ delay: null });
    const view = renderWithRuntime({
      pathname: `/admin/roles/${SRE}`,
      search: '?server=jira',
    });
    const editor = async (): Promise<HTMLElement> =>
      screen.findByRole('table', { name: 'Доступ роли SRE к MCP-серверам' });
    const bar = (): HTMLElement =>
      screen.getByRole('region', { name: 'Сохранение' });
    let table = await editor();
    const levelOf = (name: string): HTMLElement =>
      within(table).getByRole('combobox', { name: `Доступ: ${name}` });

    // Assert (row 1): the linked row is expanded and focused; the orphan stays checked under «Нет на сервере»
    await waitFor(() => expect(levelOf('jira')).toHaveFocus());
    expect(
      within(table).getByRole('button', { name: 'Инструменты jira' }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(table).getByText('Нет на сервере', { selector: 'p' }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole('checkbox', { name: 'old_search (old_search)' }),
    ).toBeChecked();
    expect(levelOf('jira')).toHaveTextContent('Выборочно');
    expect(rowCells(table, 'jira')[2]).toBe('1 из 2');

    // Act and assert (row 2): the switched-off tool of `notion` is checked and not counted
    await user.click(
      within(table).getByRole('button', { name: 'Инструменты notion' }),
    );
    const switchedOff = within(table).getByRole('checkbox', {
      name: 'Удалить страницу (page_delete)',
    });
    expect(switchedOff).toBeChecked();
    expect(switchedOff).toHaveAccessibleDescription('выключен для всех');
    expect(rowCells(table, 'notion')[2]).toBe('1 из 2');
    expect(bar()).toHaveTextContent('Изменений нет');

    // Act (row 3): `github` to «Выборочно»; `jira` to «Все» and back
    await chooseOption(user, table, 'Доступ: github', 'Выборочно');
    for (const name of [
      'Создать задачу (create_issue)',
      'Удалить задачу (delete_issue)',
    ])
      expect(within(table).getByRole('checkbox', { name })).toBeChecked();
    expect(rowCells(table, 'github')[2]).toBe('3 из 3');
    await chooseOption(user, table, 'Доступ: jira', 'Все');
    expect(bar()).toHaveTextContent('Изменено серверов: 2');
    await chooseOption(user, table, 'Доступ: jira', 'Выборочно');

    // Assert (row 3): one change
    expect(bar()).toHaveTextContent('Изменено серверов: 1');

    // Act and assert (row 4): «Модели» and back keep the change
    expect(
      screen.getByRole('tab', {
        name: /^Инструменты\s*есть несохранённые изменения$/,
      }),
    ).toBeInTheDocument();
    await followLink(
      user,
      screen.getByRole('tab', { name: 'Модели' }),
      view.setPathname,
    );
    expect(
      await screen.findByText('Роли не разрешена ни одна модель'),
    ).toBeInTheDocument();
    expect(view.router.push).not.toHaveBeenCalled();
    await followLink(
      user,
      screen.getByRole('tab', { name: /^Инструменты/ }),
      view.setPathname,
    );
    table = await editor();
    expect(levelOf('github')).toHaveTextContent('Выборочно');
    expect(bar()).toHaveTextContent('Изменено серверов: 1');

    // Act (row 5): the save is refused once
    server.use(
      http.put(
        `${API}/api/admin/roles/:id/levels`,
        () => apiError(500, 'INTERNAL', 'Internal error'),
        { once: true },
      ),
    );
    const mark = api.requests.length;
    await user.click(within(bar()).getByRole('button', { name: 'Сохранить' }));

    // Assert (row 5): one PUT with the one changed row; the error above the bar, the change still on screen
    const sentRow = {
      method: 'PUT',
      path: `/api/admin/roles/${SRE}/levels`,
      body: {
        servers: [
          {
            server: 'github',
            level: 'pick',
            picked: ['create_issue', 'list_issues', 'delete_issue'],
          },
        ],
      },
    };
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось сохранить: попробуйте ещё раз. Ни одно изменение не применено — они остались на экране.',
    );
    await waitFor(() => expect(changesSince(api, mark)).toEqual([sentRow]));
    expect(levelOf('github')).toHaveTextContent('Выборочно');
    expect(bar()).toHaveTextContent('Изменено серверов: 1');

    // Act and assert (row 5): the next save passes and the bar is clean
    await user.click(within(bar()).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(bar()).toHaveTextContent('Сохранено'));
    expect(changesSince(api, mark)).toEqual([sentRow, sentRow]);
    expect(levelOf('github')).toHaveTextContent('Выборочно');
  });

  // INT-5 ---------------------------------------------------------------------------------------------------------------------------------
  // access-levels: AC-36.5 "перевод инструмента в «читает» спрашивает подтверждение, которое называет последствие"; AC-39.2 "роли получают доступ к
  //   серверу со страницы сервера одним сохранением". Design: access-levels C3 web «Вкладка «Инструменты» сервера», Flow 3; UXRD ST-01, ST-02.
  // Rows (texts from uxrd.md MC-36, MC-39): `sentry` has `update_issue` (server: changes); SRE has «Только чтение» on it.
  //   1. «Читает» for `update_issue` asks MC-36; «Отмена» sends nothing and keeps «Меняет»; «Перевести» sends ONE `PATCH` with `{ readOnly: true }`,
  //      and the tool stays in «Меняют» with «исправлено» and «Теперь в группе «Читают»»
  //   2. «Доступ»: «Супер-администратор» first with «Все · уровни не задаются»; «Дать доступ ролям» adds «Дежурный» at «Только чтение»; «Сохранить»
  //      sends ONE `PUT` with that role only — SRE, unchanged, is not sent
  // Catches: a move to «Читает» saved before or without the confirmation (calls of a changing tool would go without the employee's confirmation);
  //   a save of «Доступ» that rewrites roles the administrator did not touch.
  // @category: core-functionality
  // @dependency: server page, server tools tab, server access tab, level draft, adminApi servers, MSW
  // @complexity: medium
  it('INT-5 / access-levels ST-01, ST-02: a move to «Читает» is sent only after the confirmation; «Доступ» sends the changed roles only', async () => {
    // Arrange
    const { store, handlers } = adminBackend();
    store.sentryAccess = [
      {
        id: SRE,
        name: 'SRE',
        builtinKind: null,
        memberCount: 1,
        level: 'read',
        picked: [],
      },
    ];
    server.use(
      http.get(`${API}/api/auth/me`, () =>
        HttpResponse.json(currentUser({ isAdmin: true })),
      ),
      ...handlers,
    );
    const api = trackRequests(server);
    const user = userEvent.setup({ delay: null });
    const view = renderWithRuntime({ pathname: '/admin/servers/sentry' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'sentry' }),
    ).toBeInTheDocument();
    const tools = screen.getByRole('region', { name: 'Инструменты sentry' });
    let mark = api.requests.length;

    // Act (row 1): «Читает», then «Отмена»
    await chooseOption(user, tools, 'Класс: Update issue', 'Читает');
    let confirm = await screen.findByRole('alertdialog', {
      name: 'Перевести «Update issue» в читающие?',
    });
    expect(confirm).toHaveTextContent(
      'Его вызовы пойдут без подтверждения сотрудника, а роли с уровнем «Только чтение» получат его со следующего шага агента.',
    );
    await user.click(within(confirm).getByRole('button', { name: 'Отмена' }));

    // Assert (row 1): nothing sent, the class is still «Меняет»
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(changesSince(api, mark)).toEqual([]);
    expect(
      within(tools).getByRole('combobox', { name: 'Класс: Update issue' }),
    ).toHaveTextContent('Меняет');

    // Act and assert (row 1): «Перевести» sends the one PATCH; the tool stays where it was, corrected
    await chooseOption(user, tools, 'Класс: Update issue', 'Читает');
    confirm = await screen.findByRole('alertdialog', {
      name: 'Перевести «Update issue» в читающие?',
    });
    await user.click(
      within(confirm).getByRole('button', { name: 'Перевести' }),
    );
    await waitFor(() =>
      expect(changesSince(api, mark)).toEqual([
        {
          method: 'PATCH',
          path: '/api/admin/mcp-servers/sentry/tools/update_issue',
          body: { readOnly: true },
        },
      ]),
    );
    expect(
      await within(tools).findByText('Теперь в группе «Читают»'),
    ).toBeInTheDocument();
    expect(within(tools).getByText('исправлено')).toBeInTheDocument();
    expect(within(tools).getByText('сервер: меняет')).toBeInTheDocument();
    expect(toolGroups('sentry')).toEqual(['Меняют: sentry: update_issue']);

    // Act and assert (row 1): «Доступ» and back - the tab opens again with the saved class, the tool now in «Читают»
    await followLink(
      user,
      screen.getByRole('tab', { name: 'Доступ' }),
      view.setPathname,
    );
    await screen.findByRole('table', { name: 'Роли с доступом к sentry' });
    await followLink(
      user,
      screen.getByRole('tab', { name: 'Инструменты' }),
      view.setPathname,
    );
    const reopened = await screen.findByRole('region', {
      name: 'Инструменты sentry',
    });
    await user.click(
      within(reopened).getByRole('button', { name: 'Читают: sentry' }),
    );
    expect(toolGroups('sentry')).toEqual([
      'Читают: sentry: list_issues, update_issue',
    ]);
    expect(
      within(reopened).getByRole('combobox', { name: 'Класс: Update issue' }),
    ).toHaveTextContent('Читает');
    expect(within(reopened).getByText('исправлено')).toBeInTheDocument();
    expect(within(reopened).queryByText('Теперь в группе «Читают»')).toBeNull();

    // Act (row 2): «Доступ», «Дать доступ ролям» -> «Дежурный» -> «Добавить (1)»
    await followLink(
      user,
      screen.getByRole('tab', { name: 'Доступ' }),
      view.setPathname,
    );
    const table = await screen.findByRole('table', {
      name: 'Роли с доступом к sentry',
    });
    expect(bodyRows(table)[0]).toContain(
      'Супер-администраторВсе · уровни не задаются',
    );
    await user.click(screen.getByRole('button', { name: 'Дать доступ ролям' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Дежурный' }));
    await user.click(screen.getByRole('button', { name: 'Добавить (1)' }));
    const bar = screen.getByRole('region', { name: 'Сохранение' });
    expect(bar).toHaveTextContent('Изменено ролей: 1');
    expect(
      within(table).getByRole('combobox', { name: 'Доступ роли Дежурный' }),
    ).toHaveTextContent('Только чтение');
    mark = api.requests.length;
    await user.click(within(bar).getByRole('button', { name: 'Сохранить' }));

    // Assert (row 2): one PUT with the added role only
    await waitFor(() => expect(bar).toHaveTextContent('Сохранено'));
    expect(changesSince(api, mark)).toEqual([
      {
        method: 'PUT',
        path: '/api/admin/mcp-servers/sentry/access',
        body: { roles: [{ roleId: DUTY, level: 'read', picked: [] }] },
      },
    ]);
  });

  // INT-6 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-40.1 "Given у Ани роль даёт инструмент, when администратор запрещает его Ане лично в «Выборочно», then инструмент у Ани помечен
  //   «запрещён лично», а остальные по-прежнему от роли"; AC-40.3 - the save sends only the changed server. UXRD EA-01, MC-40.
  // Behavior: Аня's «SRE» has «Все» on `sentry` (two tools). Her personal level there goes to «Выборочно» - every tool starts at «—», the
  //   effective access stays the role's; «Update issue» set to «Запрещён» shows «запрещён лично», the total drops to «1 из 2» and «Откуда» still
  //   names «SRE — Все» with «лично»; «Сохранить» sends ONE `PUT` with `sentry` only and its deny mark.
  // Catches: a personal deny sent as an allow (or not sent), a save that rewrites servers the administrator did not touch, or an effective
  //   access that ignores the personal deny or loses the role as its source.
  // @category: core-functionality
  // @dependency: employee page, employee tools tab, level draft, coverage rule, adminApi users, MSW
  // @complexity: medium
  it('INT-6 / access-levels EA-01: a personal deny under «Выборочно» is shown at once, keeps the role as the source and is sent for the changed server only', async () => {
    // Arrange
    const { store, handlers } = adminBackend();
    store.levels.set(SRE, [
      {
        server: 'sentry',
        status: 'enabled',
        tools: [],
        level: 'all',
        picked: [],
      },
    ]);
    server.use(
      http.get(`${API}/api/auth/me`, () =>
        HttpResponse.json(currentUser({ isAdmin: true })),
      ),
      ...handlers,
    );
    const api = trackRequests(server);
    const user = userEvent.setup({ delay: null });
    renderWithRuntime({ pathname: `/admin/users/${ANYA}` });
    const table = await screen.findByRole('table', {
      name: 'Доступ Аня Смирнова к MCP-серверам',
    });
    expect(rowCells(table, 'sentry').slice(2, 4)).toEqual([
      '2 из 2',
      'SRE — Все',
    ]);

    // Act: personal «Выборочно» on `sentry`, then «Запрещён» for «Update issue»
    await chooseOption(user, table, 'Личный доступ: sentry', 'Выборочно');
    expect(
      within(table).getByRole('combobox', { name: 'Лично: Update issue' }),
    ).toHaveTextContent('—');
    await chooseOption(user, table, 'Лично: Update issue', 'Запрещён');

    // Assert: the deny shows at once; the other tool stays the role's
    expect(
      within(table).getByRole('combobox', { name: 'Лично: Update issue' }),
    ).toHaveAccessibleDescription('запрещён лично');
    await user.click(
      within(table).getByRole('button', { name: 'Читают: sentry' }),
    );
    expect(
      within(table).getByRole('combobox', { name: 'Лично: List issues' }),
    ).toHaveAccessibleDescription(/^доступен\s*SRE$/);
    expect(rowCells(table, 'sentry').slice(2, 4)).toEqual([
      '1 из 2',
      'SRE — Все · лично',
    ]);
    const bar = screen.getByRole('region', { name: 'Сохранение' });
    expect(bar).toHaveTextContent('Изменено серверов: 1');
    const mark = api.requests.length;
    await user.click(within(bar).getByRole('button', { name: 'Сохранить' }));

    // Assert: one PUT with `sentry` and its deny mark
    await waitFor(() => expect(bar).toHaveTextContent('Сохранено'));
    expect(changesSince(api, mark)).toEqual([
      {
        method: 'PUT',
        path: `/api/admin/users/${ANYA}/levels`,
        body: {
          servers: [
            {
              server: 'sentry',
              level: 'pick',
              marks: [{ tool: 'update_issue', effect: 'deny' }],
            },
          ],
        },
      },
    ]);
  });
});
