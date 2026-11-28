'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { AttentionEvent, NotificationLevel } from '@agent-os/contracts';
import { describeApiError } from '@/lib/api/api-request';
import { focusShellTarget } from '@/lib/focus';
import type { LiveAttention } from '@/lib/live/live-store';
import { logger } from '@/lib/logger';
import type { NotificationPermissionState } from '@/lib/notifications/notifications-store';
import { parseShellRoute, threadPath } from '@/lib/shell-route';
import { leaveThenGo, useShellServices } from './shell-actions';

/** Why an event is dropped before the conversation is read: no permission, or the tab shows it on view. */
export type AttentionSkip = 'no_permission' | 'on_view';

/**
 * The first two checks of live-feed design-web.md, C3 «событие внимания становится уведомлением»: they run before any
 * read, so a tab without permission sends no request. `null` — read the conversation.
 */
export function skipBeforeRead({
  permission,
  onView,
}: {
  permission: NotificationPermissionState;
  onView: boolean;
}): AttentionSkip | null {
  if (permission !== 'granted') return 'no_permission';
  if (onView) return 'on_view';
  return null;
}

/** The level table of the same section; the conversation's own level beats the employee's default. */
export function levelAllows({
  threadLevel,
  userLevel,
  event,
}: {
  threadLevel: NotificationLevel | null;
  userLevel: NotificationLevel;
  event: AttentionEvent;
}): boolean {
  const level = threadLevel ?? userLevel;
  if (level === 'off') return false;
  return level === 'all' || event !== 'answer';
}

/**
 * KD-5 of live-feed design-web.md: mounted once in the shell, it turns `attention` into a browser notification with
 * the conversation's id as `tag`, so the same conversation's notification replaces the previous one in every tab
 * (AC-09.2). The title is the conversation's title or «Новая беседа», the body one event of MC-10, nothing of the
 * reply. A click brings the tab forward and opens the conversation through the ordinary navigation (asking about
 * unsaved changes first), focus in the composer; opening a conversation closes the notification this tab showed
 * about it. Every decision is logged with ids and the event, never the title.
 */
export function useAttentionNotifications(): void {
  const { live, notifications, currentUser, apiClient, leaveGuard } =
    useShellServices();
  const t = useTranslations('shell');
  const router = useRouter();
  const route = parseShellRoute(usePathname());
  const openThreadId = route.kind === 'chat' ? route.threadId : undefined;

  // The listener is subscribed once; these refs give it the current screen, language and router.
  const openRef = useRef(openThreadId);
  const tRef = useRef(t);
  const routerRef = useRef(router);
  const shown = useRef(new Map<string, Notification>());
  useEffect(() => {
    openRef.current = openThreadId;
    tRef.current = t;
    routerRef.current = router;
  });

  // A change in the site settings shows when the employee comes back to the tab (UXRD LF-04).
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') notifications.refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [notifications]);

  // FR-09: opening a conversation closes the notification this tab showed about it.
  useEffect(() => {
    if (openThreadId === undefined) return;
    shown.current.get(openThreadId)?.close();
    shown.current.delete(openThreadId);
  }, [openThreadId]);

  useEffect(() => {
    const open = (threadId: string): void => {
      window.focus();
      leaveThenGo(leaveGuard, () => {
        routerRef.current.push(threadPath(threadId));
        focusShellTarget('composer');
      });
    };

    const show = (
      threadId: string,
      title: string | null,
      event: AttentionEvent,
    ): void => {
      const translate = tRef.current;
      const notification = new Notification(
        title ?? translate('thread.untitled'),
        {
          body: translate(`notifications.event.${event}`),
          tag: threadId,
        },
      );
      shown.current.get(threadId)?.close();
      shown.current.set(threadId, notification);
      notification.onclick = () => {
        notification.close();
        open(threadId);
      };
      notification.onclose = () => {
        if (shown.current.get(threadId) === notification)
          shown.current.delete(threadId);
      };
    };

    const handle = async ({
      threadId,
      event,
    }: LiveAttention): Promise<void> => {
      const skip = skipBeforeRead({
        permission: notifications.getState().permission,
        onView:
          openRef.current === threadId &&
          document.visibilityState === 'visible',
      });
      if (skip !== null) {
        logger.info('attention: not shown', { threadId, event, reason: skip });
        return;
      }
      const user = currentUser.getState().user;
      if (user === null) {
        logger.info('attention: not shown', {
          threadId,
          event,
          reason: 'user_not_read',
        });
        return;
      }
      try {
        const thread = await apiClient.getThread(threadId);
        if (
          !levelAllows({
            threadLevel: thread.notificationLevel,
            userLevel: user.notificationLevel,
            event,
          })
        ) {
          logger.info('attention: not shown', {
            threadId,
            event,
            reason: 'level',
            threadLevel: thread.notificationLevel,
            userLevel: user.notificationLevel,
          });
          return;
        }
        show(threadId, thread.title, event);
        logger.info('attention: shown', { threadId, event });
      } catch (error) {
        logger.error('attention: notification failed', {
          threadId,
          event,
          ...describeApiError(error),
          error,
        });
      }
    };

    return live.onAttention((attention) => void handle(attention));
  }, [live, notifications, currentUser, apiClient, leaveGuard]);
}
