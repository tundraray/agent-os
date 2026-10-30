'use client';

import { useEffect } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { useMainViewState } from './main-view';

const APP_NAME = 'Agent OS';

/** Placeholder for a thread without a title (D-06). */
const UNTITLED = 'Новая беседа';

/**
 * UX-04: the browser tab title, which the Next route announcer reads. `/` → «Новый чат — Agent OS»;
 * TH-06 → «Беседа не найдена — Agent OS»; TH-07 → «Agent OS»; the open thread → «{Название} — Agent OS»
 * or «Новая беседа — Agent OS». While the URL thread is still resolving the previous title stays. Renders nothing.
 */
export function DocumentTitle() {
  const { view, routeThreadId, mainRemoteId } = useMainViewState();
  const mainTitle = useAuiState(
    (s) =>
      s.threads.threadItems.find(
        (item) => item.id === s.threads.mainThreadId || item.remoteId === s.threads.mainThreadId,
      )?.title,
  );

  const title = ((): string | undefined => {
    if (routeThreadId === undefined) return `Новый чат — ${APP_NAME}`;
    if (view.kind === 'not-found') return `Беседа не найдена — ${APP_NAME}`;
    if (view.kind === 'load-error') return APP_NAME;
    if (view.kind === 'switching' || mainRemoteId !== routeThreadId) return undefined;
    const text = mainTitle?.trim() ?? '';
    return `${text === '' ? UNTITLED : text} — ${APP_NAME}`;
  })();

  useEffect(() => {
    if (title !== undefined) document.title = title;
  }, [title]);

  return null;
}
