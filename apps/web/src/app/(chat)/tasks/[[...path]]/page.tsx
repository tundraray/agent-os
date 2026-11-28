/**
 * The whole chat UI lives in the (chat) layout; `MainView` picks the tracker's list or a task's screen by the
 * pathname, so the page only claims `/tasks` and every path under it. It never reads `params`:
 * with `cacheComponents` that would require a `Suspense` boundary.
 */
export default function TasksPage() {
  return null;
}
