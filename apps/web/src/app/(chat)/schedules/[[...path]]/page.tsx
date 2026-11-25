/**
 * The whole chat UI lives in the (chat) layout; `MainView` picks the schedules list or a schedule page by the
 * pathname, so the page only claims `/schedules` and every path under it. It never reads `params`:
 * with `cacheComponents` that would require a `Suspense` boundary.
 */
export default function SchedulesPage() {
  return null;
}
