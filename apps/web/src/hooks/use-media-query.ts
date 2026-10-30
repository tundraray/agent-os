import { useCallback, useSyncExternalStore } from 'react';

// The server cannot evaluate media queries; it renders as if the query does not match.
const getServerSnapshot = (): boolean => false;

/** Live answer of `window.matchMedia(query)`; re-renders when the answer changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
