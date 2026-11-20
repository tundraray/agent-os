/**
 * The whole chat UI lives in the (chat) layout; `MainView` picks the library screen by the pathname,
 * so the page only claims `/library` and every path under it. It never reads `params`:
 * with `cacheComponents` that would require a `Suspense` boundary.
 */
export default function LibraryPage() {
  return null;
}
