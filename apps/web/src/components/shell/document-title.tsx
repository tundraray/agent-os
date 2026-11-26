'use client';

import { usePathname } from 'next/navigation';
import { useAuiState } from '@assistant-ui/react';
import { useTranslations } from 'next-intl';
import {
  APP_NAME,
  pageTitle,
  useDocumentTitle,
} from '@/hooks/use-document-title';
import { useFeedSelector } from '@/lib/feed/feed-context';
import { selectAgent } from '@/lib/feed/to-feed';
import { isPageRoute, parseShellRoute } from '@/lib/shell-route';
import { selectMainItem } from '@/lib/threads/main-thread';
import { useMainViewState } from './main-view';

/**
 * UX-04: the browser tab title, which the Next route announcer reads. `/` → «Новый чат — Agent OS»;
 * TH-06 → «Беседа не найдена — Agent OS»; TH-07 → «Agent OS»; the open thread → «{Название} — Agent OS»
 * or «Новая беседа — Agent OS». `/agents` → «Агенты — Agent OS» (MC-4); an agent page → «{название} —
 * Agent OS» (MC-8), «Агент не найден — Agent OS» (MC-15), «Agent OS» on a failed read. `/account` →
 * «Мой доступ — Agent OS» (enterprise-access MC-7). A panel, library or schedules address is titled by its own screen
 * (`PageHeader`, `AdminGate`), which knows the record's name (custom-agents MC-1, MC-7, MC-18). While the URL thread or agent is still
 * resolving the previous title stays. Renders nothing; on an agent page it reads the agent's store from
 * `AgentFeedProvider`.
 */
export function DocumentTitle() {
  const t = useTranslations('shell');
  const route = parseShellRoute(usePathname());
  const { view, routeThreadId, mainRemoteId } = useMainViewState();
  const mainTitle = useAuiState((s) => selectMainItem(s)?.title);
  const agentName = useFeedSelector(
    (state) => selectAgent(state.view)?.description,
    undefined,
  );
  const agentLoadError = useFeedSelector((state) => state.loadError, null);

  const title = ((): string | undefined => {
    if (route.kind === 'agents') return pageTitle(t('page.agents'));
    if (route.kind === 'account') return pageTitle(t('page.account'));
    if (isPageRoute(route)) return undefined;
    if (route.kind === 'agent') {
      if (agentLoadError === 'not_found')
        return pageTitle(t('notice.agentNotFound.title'));
      if (agentLoadError !== null) return APP_NAME;
      return agentName === undefined ? undefined : pageTitle(agentName);
    }
    if (routeThreadId === undefined) return pageTitle(t('sidebar.newChat'));
    if (view.kind === 'not-found') return pageTitle(t('notice.notFound.title'));
    if (view.kind === 'load-error') return APP_NAME;
    if (view.kind === 'switching' || mainRemoteId !== routeThreadId)
      return undefined;
    const text = mainTitle?.trim() ?? '';
    return pageTitle(text === '' ? t('thread.untitled') : text);
  })();

  useDocumentTitle(title);

  return null;
}
