export const CHAT_PATH_PREFIX = "/chat/";
export const AGENTS_PATH = "/agents";

const AGENT_PATH_PREFIX = `${AGENTS_PATH}/`;

/** The screen a shell path opens; `/` and any unknown path open a new chat. */
export type ShellRoute =
  | { kind: "chat"; threadId?: string }
  | { kind: "agents" }
  | { kind: "agent"; agentId: string };

/** The only way a thread path is built: Link href, replaceState, pathname comparison. */
export const threadPath = (threadId: string): string =>
  `${CHAT_PATH_PREFIX}${encodeURIComponent(threadId)}`;

/** The only way an agent page path is built. */
export const agentPath = (agentId: string): string =>
  `${AGENT_PATH_PREFIX}${encodeURIComponent(agentId)}`;

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

export function parseShellRoute(pathname: string | null): ShellRoute {
  if (pathname === null) return { kind: "chat" };
  if (pathname === AGENTS_PATH) return { kind: "agents" };
  const agentId = singleSegment(pathname, AGENT_PATH_PREFIX);
  if (agentId !== undefined) return { kind: "agent", agentId };
  const threadId = singleSegment(pathname, CHAT_PATH_PREFIX);
  return threadId === undefined ? { kind: "chat" } : { kind: "chat", threadId };
}
