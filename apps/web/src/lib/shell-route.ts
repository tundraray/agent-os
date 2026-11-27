export const CHAT_PATH_PREFIX = '/chat/';
export const AGENTS_PATH = '/agents';
/** «Мой доступ» (UXRD Screen 3). */
export const ACCOUNT_PATH = '/account';

const AGENT_PATH_PREFIX = `${AGENTS_PATH}/`;
const LIBRARY_PATH = '/library';
const LIBRARY_PATH_PREFIX = `${LIBRARY_PATH}/`;
/** Under the library but parsed before a record id, so no record id can take this address. A deep agent has no form (UXRD KD-1). */
const NEW_AGENT_PATH = `${LIBRARY_PATH_PREFIX}new/agent`;
const ADMIN_PATH = '/admin';
const ADMIN_PATH_PREFIX = `${ADMIN_PATH}/`;
/** Outside `/admin/servers/…` because a server may be named `new`. */
const REGISTER_SERVER_PATH = `${ADMIN_PATH_PREFIX}register-server`;
const NEW_SIGN_IN_PATH = `${ADMIN_PATH_PREFIX}sign-in/new`;
const SCHEDULES_PATH = '/schedules';
const SCHEDULES_PATH_PREFIX = `${SCHEDULES_PATH}/`;
/** After a record id: a deep agent's memory (self-learning UXRD ME-01). */
const MEMORY_SUFFIX = '/memory';
/** After an agent id: the deep agent page's tab «Задачи» (deep-agents UXRD DA-04); «Ход работы» is the page's own address. */
const TASKS_SUFFIX = '/tasks';

/** The panel's sections in screen order; titles and icons live in `components/admin/admin-sections.ts`. */
export const ADMIN_SECTION_IDS = [
  'users',
  'roles',
  'sign-in',
  'servers',
  'models',
  'library',
] as const;
export type AdminSection = (typeof ADMIN_SECTION_IDS)[number];
/** The model catalogue is edited in dialogs on its list; every other section's records have their own page. */
const hasRecordPages = (section: AdminSection): boolean => section !== 'models';

/** The tabs of the panel's «Агенты и глубокие агенты» (design-web.md KD-1); «Системные» is the section's own address. */
export const LIBRARY_TABS = ['system', 'shared', 'bans'] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];

/**
 * The tabs of a record page after its first one (access-levels KD-7): the first tab — «Инструменты» of a role or an
 * employee, «Инструменты» of a server — lives at the record's own address.
 */
export const ADMIN_RECORD_TABS = {
  roles: ['models', 'rights', 'members'],
  users: ['models', 'rights', 'roles'],
  servers: ['access'],
} as const;
type TabbedSection = keyof typeof ADMIN_RECORD_TABS;
export type AdminRecordTab<S extends TabbedSection = TabbedSection> =
  (typeof ADMIN_RECORD_TABS)[S][number];

const isTabbedSection = (section: AdminSection): section is TabbedSection =>
  section in ADMIN_RECORD_TABS;

/** A list carries its tab in the section `library` only; a new record there is a new agent; a record its tab. */
export type AdminPage =
  | { kind: 'list'; tab?: LibraryTab }
  | { kind: 'new' }
  | { kind: 'record'; key: string; tab?: AdminRecordTab }
  | { kind: 'memory'; key: string };

/** An employee's library page (design-web.md KD-1): the list, a record by its id, a new agent or a deep agent's memory. */
export type LibraryPage =
  | { kind: 'list' }
  | { kind: 'record'; id: string }
  | { kind: 'new' }
  | { kind: 'memory'; id: string };

/** The tab of a deep agent's page carried in its address; absent — «Ход работы» (deep-agents UXRD DA-04). */
export type AgentTab = 'tasks';

/** The screen a shell path opens; `/` and any unknown path open a new chat. */
export type ShellRoute =
  | { kind: 'chat'; threadId?: string }
  | { kind: 'agents' }
  | { kind: 'agent'; agentId: string; tab?: AgentTab }
  | { kind: 'account' }
  | { kind: 'library'; page: LibraryPage }
  | { kind: 'schedules' }
  | { kind: 'schedule'; scheduleId: string }
  | { kind: 'admin'; section: AdminSection; page: AdminPage };

/**
 * A screen with its own `PageHeader` and no composer: the panel, the library and the schedules. The shell header
 * gives it the header slot, the skip link leads to its `h1`, and it titles the tab itself.
 */
export const isPageRoute = (route: ShellRoute): boolean =>
  route.kind === 'admin' ||
  route.kind === 'library' ||
  route.kind === 'schedules' ||
  route.kind === 'schedule';

/** The only way a thread path is built: Link href, replaceState, pathname comparison. */
export const threadPath = (threadId: string): string =>
  `${CHAT_PATH_PREFIX}${encodeURIComponent(threadId)}`;

/** The only way an agent page path is built; `tab` — a deep agent's «Задачи». */
export const agentPath = (agentId: string, tab?: AgentTab): string =>
  `${AGENT_PATH_PREFIX}${encodeURIComponent(agentId)}${tab === undefined ? '' : TASKS_SUFFIX}`;

/** The only way the library list path is built. */
export const libraryPath = (): string => LIBRARY_PATH;

/** The only way an employee's record page path is built. */
export const recordPath = (id: string): string =>
  `${LIBRARY_PATH_PREFIX}${encodeURIComponent(id)}`;

/** The only way an employee's memory page path of a deep agent is built. */
export const memoryPath = (id: string): string =>
  `${recordPath(id)}${MEMORY_SUFFIX}`;

/** The only way an employee's "new agent" path is built. */
export const newAgentPath = (): string => NEW_AGENT_PATH;

/** The only way the schedules list path is built (UXRD SH-04). */
export const schedulesPath = (): string => SCHEDULES_PATH;

/** The only way a schedule page path is built (UXRD SH-05); an unknown or foreign id shows SH-08 there. */
export const schedulePath = (id: string): string =>
  `${SCHEDULES_PATH_PREFIX}${encodeURIComponent(id)}`;

/** The only way a panel section list path is built. */
export const adminPath = (section: AdminSection): string =>
  `${ADMIN_PATH_PREFIX}${section}`;

/** The only way a panel record path is built; a server is addressed by its name (ADR-0014). */
export const adminRecordPath = (section: AdminSection, key: string): string =>
  `${adminPath(section)}/${encodeURIComponent(key)}`;

/** The only way a record tab after the first is addressed: `/admin/roles/<id>/models`. */
export const adminRecordTabPath = <S extends TabbedSection>(
  section: S,
  key: string,
  tab: AdminRecordTab<S>,
): string => `${adminRecordPath(section, key)}/${tab}`;

/** The only way the panel's memory page path of a company deep agent is built. */
export const adminMemoryPath = (key: string): string =>
  `${adminRecordPath('library', key)}${MEMORY_SUFFIX}`;

/** The only way a panel "new record" path is built. */
export const adminNewPath = (section: 'sign-in' | 'servers'): string =>
  section === 'sign-in' ? NEW_SIGN_IN_PATH : REGISTER_SERVER_PATH;

/** The only way a tab of the panel's «Агенты и глубокие агенты» is addressed. */
export const adminLibraryTabPath = (tab: LibraryTab): string =>
  tab === 'system' ? adminPath('library') : `${adminPath('library')}/${tab}`;

/** The only way the panel's "new company agent" path is built. */
export const adminNewAgentPath = (): string =>
  `${adminPath('library')}/new/agent`;

/** One non-empty segment between `prefix` and `suffix`, decoded; undefined when the path has none or more. */
function singleSegment(
  pathname: string,
  prefix: string,
  suffix = '',
): string | undefined {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix))
    return undefined;
  const segment = pathname.slice(
    prefix.length,
    pathname.length - suffix.length,
  );
  if (segment === '' || segment.includes('/')) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding: keep the raw segment so the API answers 404 and the user sees "not found".
    return segment;
  }
}

/** A tab, the new-agent or a memory address of «Агенты и глубокие агенты»; checked before a record id, which is a UUID. */
function libraryAdminPage(pathname: string): AdminPage | undefined {
  const tab = LIBRARY_TABS.find(
    (candidate) => pathname === adminLibraryTabPath(candidate),
  );
  if (tab !== undefined) return { kind: 'list', tab };
  if (pathname === adminNewAgentPath()) return { kind: 'new' };
  const key = singleSegment(
    pathname,
    `${adminPath('library')}/`,
    MEMORY_SUFFIX,
  );
  return key === undefined ? undefined : { kind: 'memory', key };
}

/** `/admin/<section>/<key>/<tab>` of a section whose record page has tabs. */
function recordTabPage(
  pathname: string,
  section: AdminSection,
): AdminPage | undefined {
  if (!isTabbedSection(section)) return undefined;
  for (const tab of ADMIN_RECORD_TABS[section]) {
    const key = singleSegment(pathname, `${adminPath(section)}/`, `/${tab}`);
    if (key !== undefined) return { kind: 'record', key, tab };
  }
  return undefined;
}

/** `/admin` and any unknown path under it open «Сотрудники». */
function parseAdminPage(pathname: string): {
  section: AdminSection;
  page: AdminPage;
} {
  if (pathname === NEW_SIGN_IN_PATH)
    return { section: 'sign-in', page: { kind: 'new' } };
  if (pathname === REGISTER_SERVER_PATH)
    return { section: 'servers', page: { kind: 'new' } };
  const libraryPage = libraryAdminPage(pathname);
  if (libraryPage !== undefined)
    return { section: 'library', page: libraryPage };
  for (const section of ADMIN_SECTION_IDS) {
    if (pathname === adminPath(section))
      return { section, page: { kind: 'list' } };
    const key = hasRecordPages(section)
      ? singleSegment(pathname, `${adminPath(section)}/`)
      : undefined;
    if (key !== undefined) return { section, page: { kind: 'record', key } };
    const tabPage = recordTabPage(pathname, section);
    if (tabPage !== undefined) return { section, page: tabPage };
  }
  return { section: 'users', page: { kind: 'list' } };
}

/** `/library`, an id after it, the new-agent address or an id's memory; any other path under it opens the list. */
function parseLibraryPage(pathname: string): LibraryPage {
  if (pathname === NEW_AGENT_PATH) return { kind: 'new' };
  const memoryId = singleSegment(pathname, LIBRARY_PATH_PREFIX, MEMORY_SUFFIX);
  if (memoryId !== undefined) return { kind: 'memory', id: memoryId };
  const id = singleSegment(pathname, LIBRARY_PATH_PREFIX);
  return id === undefined ? { kind: 'list' } : { kind: 'record', id };
}

export function parseShellRoute(pathname: string | null): ShellRoute {
  if (pathname === null) return { kind: 'chat' };
  if (pathname === AGENTS_PATH) return { kind: 'agents' };
  if (pathname === ACCOUNT_PATH) return { kind: 'account' };
  if (pathname === LIBRARY_PATH || pathname.startsWith(LIBRARY_PATH_PREFIX)) {
    return { kind: 'library', page: parseLibraryPage(pathname) };
  }
  // `/schedules`, an id after it; any other path under it opens the list.
  if (
    pathname === SCHEDULES_PATH ||
    pathname.startsWith(SCHEDULES_PATH_PREFIX)
  ) {
    const scheduleId = singleSegment(pathname, SCHEDULES_PATH_PREFIX);
    return scheduleId === undefined
      ? { kind: 'schedules' }
      : { kind: 'schedule', scheduleId };
  }
  if (pathname === ADMIN_PATH || pathname.startsWith(ADMIN_PATH_PREFIX)) {
    return { kind: 'admin', ...parseAdminPage(pathname) };
  }
  // The tab is parsed before a single agent id, as a memory address before a record id.
  const tasksAgentId = singleSegment(pathname, AGENT_PATH_PREFIX, TASKS_SUFFIX);
  if (tasksAgentId !== undefined)
    return { kind: 'agent', agentId: tasksAgentId, tab: 'tasks' };
  const agentId = singleSegment(pathname, AGENT_PATH_PREFIX);
  if (agentId !== undefined) return { kind: 'agent', agentId };
  const threadId = singleSegment(pathname, CHAT_PATH_PREFIX);
  return threadId === undefined ? { kind: 'chat' } : { kind: 'chat', threadId };
}
