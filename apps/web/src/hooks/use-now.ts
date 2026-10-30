import { useEffect, useState } from 'react';

function msUntilNextMidnight(from: Date): number {
  const midnight = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  return midnight.getTime() - from.getTime();
}

/**
 * "Now" for date grouping (A-6): refreshed when the tab becomes visible again and at local midnight,
 * so "Сегодня" turns into "Вчера" in a window left open overnight.
 */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') setNow(new Date());
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setNow(new Date()), msUntilNextMidnight(now));
    return () => window.clearTimeout(timer);
  }, [now]);

  return now;
}
