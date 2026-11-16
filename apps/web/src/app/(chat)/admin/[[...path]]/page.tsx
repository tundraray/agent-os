/**
 * The whole chat UI lives in the (chat) layout; `MainView` picks the panel screen by the pathname,
 * so the page only claims `/admin` and every path under it. It never reads `params`:
 * with `cacheComponents` that would require a `Suspense` boundary.
 */
export default function AdminPage() {
  return null;
}
