'use client';

import { usePathname } from 'next/navigation';
import { useAuiState } from '@assistant-ui/react';
import { APP_NAME, pageTitle, useDocumentTitle } from '@/hooks/use-document-title';
import { useFeedSelector } from '@/lib/feed/feed-context';
import { selectAgent } from '@/lib/feed/to-feed';
import { parseShellRoute } from '@/lib/shell-route';
import { selectMainItem } from '@/lib/threads/main-thread';
import { useMainViewState } from './main-view';
import { UNTITLED_THREAD_TITLE } from './thread-history-item';

/**
 * UX-04: the browser tab title, which the Next route announcer reads. `/` → «Новый чат — Agent OS»;
 * TH-06 → «Беседа не найдена — Agent OS»; TH-07 → «Agent OS»; the open thread → «{Название} — Agent OS»
 * or «Новая беседа — Agent OS». `/agents` → «Агенты — Agent OS» (MC-4); an agent page → «{название} —
 * Agent OS» (MC-8), «Агент не найден — Agent OS» (MC-15), «Agent OS» on a failed read. `/account` →
 * «Мой доступ — Agent OS» (enterprise-access MC-7). A panel or library address is titled by its own screen
 * (`PageHeader`, `AdminGate`), which knows the record's name (custom-agents MC-1, MC-7, MC-18). While the URL thread or agent is still
 * resolving the previous title stays. Renders nothing; on an agent page it reads the agent's store from
 * `AgentFeedProvider`.
 */
export function DocumentTitle() {
  const route = parseShellRoute(usePathname());
  const { view, routeThreadId, mainRemoteId } = useMainViewState();
  const mainTitle = useAuiState(
    (s) => selectMainItem(s)?.title);
  const agentName = useFeedSelector((state) => selectAgent(state.view)?.description, undefined);
  const agentLoadError = useFeedSelector((state) => state.loadError, null);

  const title = ((): string | undefined => {
    if (route.kind === 'agents') return pageTitle('Агенты');
    if (route.kind === 'account') return pageTitle('Мой доступ');
    if (route.kind === 'admin' || route.kind === 'library') return undefined;
    if (route.kind === 'agent') {
      if (agentLoadError === 'not_found') return pageTitle('Агент не найден');
      if (agentLoadError !== null) return APP_NAME;
      return agentName === undefined ? undefined : pageTitle(agentName);
    }
    if (routeThreadId === undefined) return pageTitle('Новый чат');
    if (view.kind === 'not-found') return pageTitle('Беседа не найдена');
    if (view.kind === 'load-error') return APP_NAME;
    if (view.kind === 'switching' || mainRemoteId !== routeThreadId) return undefined;
    const text = mainTitle?.trim() ?? '';
    return pageTitle(text === '' ? UNTITLED_THREAD_TITLE : text);
  })();

  useDocumentTitle(title);

  return null;
}
