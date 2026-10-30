export const CHAT_PATH_PREFIX = "/chat/";

/** The only way a thread path is built: Link href, replaceState, pathname comparison. */
export const threadPath = (threadId: string): string =>
  `${CHAT_PATH_PREFIX}${encodeURIComponent(threadId)}`;

/** `/chat/<id>` → decoded id; `/` and any other path → undefined. */
export function parseRouteThreadId(pathname: string | null): string | undefined {
  if (pathname === null || !pathname.startsWith(CHAT_PATH_PREFIX)) return undefined;
  const segment = pathname.slice(CHAT_PATH_PREFIX.length);
  if (segment === "" || segment.includes("/")) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding: keep the raw segment so the API answers 404 and the user sees TH-06.
    return segment;
  }
}
