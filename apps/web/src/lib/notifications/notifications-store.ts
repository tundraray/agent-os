import type { NotificationLevel } from '@agent-os/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { logger as appLogger } from '@/lib/logger';

/**
 * What the browser allows (live-feed UXRD LF-04): not asked yet, granted, denied, unavailable on a page
 * without https, or no notifications in this browser at all.
 */
export type NotificationPermissionState =
  'default' | 'granted' | 'denied' | 'insecure' | 'unsupported';

export type NotificationsState = {
  permission: NotificationPermissionState;
  /** «×» of the offer LF-03 was pressed in this browser (cookie `aos_notify_offer`, design-web.md KD-6). */
  offerDismissed: boolean;
  /** The server accepted the employee's message in this tab: an agent has started work. */
  messageAccepted: boolean;
};

export type NotificationsStore = StoreApi<NotificationsState> & {
  /** Reads the permission again: the tab became visible, so a change in the site settings shows. */
  refresh: () => void;
  /** Asks the browser; call it only from the employee's click (UXRD KD-3). Resolves with the new state. */
  ask: () => Promise<NotificationPermissionState>;
  dismissOffer: () => void;
  noteMessageAccepted: () => void;
};

/** design-web.md, Contract Definitions: name, value, path and a year's life of the offer cookie. */
const OFFER_COOKIE = 'aos_notify_offer';
const OFFER_COOKIE_VALUE = 'dismissed';
const OFFER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** The shell services are also built during server rendering, where there is no browser to ask. */
function readPermission(): NotificationPermissionState {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

function readOfferDismissed(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie
    .split('; ')
    .includes(`${OFFER_COOKIE}=${OFFER_COOKIE_VALUE}`);
}

/**
 * The offer LF-03 shows while the browser has not been asked, the employee's default level is not `off`, the
 * offer was not dismissed in this browser and an agent has started work from this tab (design-web.md, C3).
 */
export function offerShown(
  state: NotificationsState,
  level: NotificationLevel | undefined,
): boolean {
  return (
    state.permission === 'default' &&
    level !== undefined &&
    level !== 'off' &&
    !state.offerDismissed &&
    state.messageAccepted
  );
}

/**
 * Browser permission and the offer, read by the offer, the «Уведомления» section and a conversation's submenu
 * (live-feed design-web.md, KD-5, KD-6). The permission is read at creation, after the browser's answer and
 * on `refresh`.
 */
export function createNotificationsStore({
  logger,
}: {
  logger: Pick<typeof appLogger, 'info'>;
}): NotificationsStore {
  const state = createStore<NotificationsState>()(() => ({
    permission: readPermission(),
    offerDismissed: readOfferDismissed(),
    messageAccepted: false,
  }));

  const refresh = (): void => {
    const permission = readPermission();
    if (permission !== state.getState().permission)
      state.setState({ permission });
  };

  return Object.assign(state, {
    refresh,
    ask: async (): Promise<NotificationPermissionState> => {
      const answer = await Notification.requestPermission();
      logger.info('notifications: browser answered', { answer });
      refresh();
      return state.getState().permission;
    },
    dismissOffer: (): void => {
      document.cookie = `${OFFER_COOKIE}=${OFFER_COOKIE_VALUE}; path=/; max-age=${OFFER_COOKIE_MAX_AGE}`;
      logger.info('notifications: offer dismissed');
      state.setState({ offerDismissed: true });
    },
    noteMessageAccepted: (): void => {
      if (!state.getState().messageAccepted)
        state.setState({ messageAccepted: true });
    },
  });
}
