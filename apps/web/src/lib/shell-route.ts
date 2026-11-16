export const CHAT_PATH_PREFIX = "/chat/";
export const AGENTS_PATH = "/agents";
/** «Мой доступ» (UXRD Screen 3). */
export const ACCOUNT_PATH = "/account";

const AGENT_PATH_PREFIX = `${AGENTS_PATH}/`;
const ADMIN_PATH = "/admin";
const ADMIN_PATH_PREFIX = `${ADMIN_PATH}/`;
/** Outside `/admin/servers/…` because a server may be named `new`. */
const REGISTER_SERVER_PATH = `${ADMIN_PATH_PREFIX}register-server`;
const NEW_SIGN_IN_PATH = `${ADMIN_PATH_PREFIX}sign-in/new`;

/** The panel's sections in screen order; titles and icons live in `components/admin/admin-sections.ts`. */
export const ADMIN_SECTION_IDS = ["users", "roles", "sign-in", "servers", "models"] as const;
export type AdminSection = (typeof ADMIN_SECTION_IDS)[number];
/** The model catalogue is edited in dialogs on its list; every other section's records have their own page. */
const hasRecordPages = (section: AdminSection): boolean => section !== "models";

export type AdminPage = { kind: "list" } | { kind: "new" } | { kind: "record"; key: string };

/** The screen a shell path opens; `/` and any unknown path open a new chat. */
export type ShellRoute =
  | { kind: "chat"; threadId?: string }
  | { kind: "agents" }
  | { kind: "agent"; agentId: string }
  | { kind: "account" }
  | { kind: "admin"; section: AdminSection; page: AdminPage };

/** The only way a thread path is built: Link href, replaceState, pathname comparison. */
export const threadPath = (threadId: string): string =>
  `${CHAT_PATH_PREFIX}${encodeURIComponent(threadId)}`;

/** The only way an agent page path is built. */
export const agentPath = (agentId: string): string =>
  `${AGENT_PATH_PREFIX}${encodeURIComponent(agentId)}`;

/** The only way a panel section list path is built. */
export const adminPath = (section: AdminSection): string => `${ADMIN_PATH_PREFIX}${section}`;

/** The only way a panel record path is built; a server is addressed by its name (ADR-0014). */
export const adminRecordPath = (section: AdminSection, key: string): string =>
  `${adminPath(section)}/${encodeURIComponent(key)}`;

/** The only way a panel "new record" path is built. */
export const adminNewPath = (section: "sign-in" | "servers"): string =>
  section === "sign-in" ? NEW_SIGN_IN_PATH : REGISTER_SERVER_PATH;

/** One non-empty segment after `prefix`, decoded; undefined when the path has none or more. */
function singleSegment(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const segment = pathname.slice(prefix.length);
  if (segment === "" || segment.includes("/")) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding: keep the raw segment so the API answers 404 and the user sees "not found".
    return segment;
  }
}

/** `/admin` and any unknown path under it open «Сотрудники». */
function parseAdminPage(pathname: string): { section: AdminSection; page: AdminPage } {
  if (pathname === NEW_SIGN_IN_PATH) return { section: "sign-in", page: { kind: "new" } };
  if (pathname === REGISTER_SERVER_PATH) return { section: "servers", page: { kind: "new" } };
  for (const section of ADMIN_SECTION_IDS) {
    if (pathname === adminPath(section)) return { section, page: { kind: "list" } };
    const key = hasRecordPages(section) ? singleSegment(pathname, `${adminPath(section)}/`) : undefined;
    if (key !== undefined) return { section, page: { kind: "record", key } };
  }
  return { section: "users", page: { kind: "list" } };
}

export function parseShellRoute(pathname: string | null): ShellRoute {
  if (pathname === null) return { kind: "chat" };
  if (pathname === AGENTS_PATH) return { kind: "agents" };
  if (pathname === ACCOUNT_PATH) return { kind: "account" };
  if (pathname === ADMIN_PATH || pathname.startsWith(ADMIN_PATH_PREFIX)) {
    return { kind: "admin", ...parseAdminPage(pathname) };
  }
  const agentId = singleSegment(pathname, AGENT_PATH_PREFIX);
  if (agentId !== undefined) return { kind: "agent", agentId };
  const threadId = singleSegment(pathname, CHAT_PATH_PREFIX);
  return threadId === undefined ? { kind: "chat" } : { kind: "chat", threadId };
}
