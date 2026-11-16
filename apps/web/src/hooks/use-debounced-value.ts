import { useEffect, useState } from 'react';

/** design-admin.md, Runtime settings: the employee search reads 300 ms after the last keystroke (DC-3). */
export const EMPLOYEE_SEARCH_DELAY_MS = 300;

/** `value` once it has stayed unchanged for `delayMs`; every change restarts the wait. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
