'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useAuiState } from '@assistant-ui/react';
import { useFeedSelector } from '@/lib/feed/feed-context';
import { parseShellRoute } from '@/lib/shell-route';
import { useMainViewState } from './main-view';

const APP_NAME = 'Agent OS';

/** Placeholder for a thread without a title (D-06). */
const UNTITLED = 'Новая беседа';

/**
 * UX-04: the browser tab title, which the Next route announcer reads. `/` → «Новый чат — Agent OS»;
 * TH-06 → «Беседа не найдена — Agent OS»; TH-07 → «Agent OS»; the open thread → «{Название} — Agent OS»
 * or «Новая беседа — Agent OS». `/agents` → «Агенты — Agent OS» (MC-4); an agent page → «{название} —
 * Agent OS» (MC-8), «Агент не найден — Agent OS» (MC-15), «Agent OS» on a failed read. While the URL
 * thread or agent is still resolving the previous title stays. Renders nothing; on an agent page it
 * reads the agent's store from `AgentFeedProvider`.
 */
export function DocumentTitle() {
  const route = parseShellRoute(usePathname());
  const { view, routeThreadId, mainRemoteId } = useMainViewState();
  const mainTitle = useAuiState(
    (s) =>
      s.threads.threadItems.find(
        (item) => item.id === s.threads.mainThreadId || item.remoteId === s.threads.mainThreadId,
      )?.title,
  );
  const agentName = useFeedSelector(
    (state) => (state.view?.kind === 'agent' ? state.view.agent.description : undefined),
    undefined,
  );
  const agentLoadError = useFeedSelector((state) => state.loadError, null);

  const title = ((): string | undefined => {
    if (route.kind === 'agents') return `Агенты — ${APP_NAME}`;
    if (route.kind === 'agent') {
      if (agentLoadError === 'not_found') return `Агент не найден — ${APP_NAME}`;
      if (agentLoadError !== null) return APP_NAME;
      return agentName === undefined ? undefined : `${agentName} — ${APP_NAME}`;
    }
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
