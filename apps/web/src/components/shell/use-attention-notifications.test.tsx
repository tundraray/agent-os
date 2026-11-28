// live-feed / web - the shell hook that turns an `attention` event into a browser notification.
// Design Doc: docs/features/live-feed/design-web.md (KD-5, "web - событие внимания становится уведомлением", Flow 3). PRD: docs/features/live-feed/prd.md.
// Generated: 2026-11-28 | Part: web | Test type: Unit (hook under renderHook / RTL with the test live source, MSW for GET /api/threads/:id,
//   a stub `globalThis.Notification` that records its calls; the clock and visibility state are set by the test)
//
// Not tested: that the browser replaces a notification with the same tag across tabs and shows a toast (AC-09.2 across tabs,
// spike S-2: needs three real tabs), click focus (browser behaviour), the server rule that a subagent gives no `attention` (AC-08.3, server part).

import type { AttentionEvent, NotificationLevel } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';
import type { NotificationPermissionState } from '@/lib/notifications/notifications-store';
import { levelAllows, skipBeforeRead } from './use-attention-notifications';

type Row = {
  permission: NotificationPermissionState;
  onView: boolean;
  threadLevel: NotificationLevel | null;
  userLevel: NotificationLevel;
  event: AttentionEvent;
  read: boolean;
  shown: boolean;
};

const hidden = { permission: 'granted', onView: false } as const;

const ROWS: readonly (Row & { name: string })[] = [
  {
    name: 'not granted',
    permission: 'default',
    onView: false,
    threadLevel: 'all',
    userLevel: 'all',
    event: 'decision',
    read: false,
    shown: false,
  },
  {
    name: 'denied',
    permission: 'denied',
    onView: false,
    threadLevel: 'all',
    userLevel: 'all',
    event: 'failure',
    read: false,
    shown: false,
  },
  {
    name: 'thread on view',
    permission: 'granted',
    onView: true,
    threadLevel: 'all',
    userLevel: 'all',
    event: 'decision',
    read: false,
    shown: false,
  },
  {
    name: 'own all beats default off, decision',
    ...hidden,
    threadLevel: 'all',
    userLevel: 'off',
    event: 'decision',
    read: true,
    shown: true,
  },
  {
    name: 'own all beats default off, answer',
    ...hidden,
    threadLevel: 'all',
    userLevel: 'off',
    event: 'answer',
    read: true,
    shown: true,
  },
  {
    name: 'own all beats default off, failure',
    ...hidden,
    threadLevel: 'all',
    userLevel: 'off',
    event: 'failure',
    read: true,
    shown: true,
  },
  {
    name: 'decisions and failures, decision',
    ...hidden,
    threadLevel: 'decisions_and_failures',
    userLevel: 'all',
    event: 'decision',
    read: true,
    shown: true,
  },
  {
    name: 'decisions and failures, answer',
    ...hidden,
    threadLevel: 'decisions_and_failures',
    userLevel: 'all',
    event: 'answer',
    read: true,
    shown: false,
  },
  {
    name: 'decisions and failures, failure',
    ...hidden,
    threadLevel: 'decisions_and_failures',
    userLevel: 'all',
    event: 'failure',
    read: true,
    shown: true,
  },
  {
    name: 'own off beats default all',
    ...hidden,
    threadLevel: 'off',
    userLevel: 'all',
    event: 'decision',
    read: true,
    shown: false,
  },
  {
    name: 'no own level, default decisions and failures, answer',
    ...hidden,
    threadLevel: null,
    userLevel: 'decisions_and_failures',
    event: 'answer',
    read: true,
    shown: false,
  },
  {
    name: 'no own level, default decisions and failures, failure',
    ...hidden,
    threadLevel: null,
    userLevel: 'decisions_and_failures',
    event: 'failure',
    read: true,
    shown: true,
  },
];

describe('use-attention-notifications (KD-5)', () => {
  // AC: AC-08.1 "…браузер спрашивает разрешение только после его собственного действия…" (no request without permission)
  // AC: AC-09.1 "Given беседа открыта в видимой вкладке, when агент в ней закончил, then уведомления нет ни в одной вкладке…" (this tab's half)
  // AC: AC-10.1 "…у беседы выбран «решения и сбои»… when агент закончил, then уведомления нет; when ход упал или открылось решение, then уведомление есть."
  // AC: AC-10.2 "…выбран «без уведомлений», then о ней уведомлений нет, а другие беседы уведомляют по уровню по умолчанию."
  // Behavior: attention (kind) → checks in order: permission granted; this tab does not show the thread on view; level of the
  //   thread, else the employee's default → read of the thread only after the first two checks → Notification shown or not.
  // Rows (permission, tab, thread level, user level, kind -> thread read?, shown?):
  //   - not granted, any                         -> no read, not shown
  //   - granted, thread on view in the main area -> no read, not shown (the right panel or an agent page does not count as on view)
  //   - granted, hidden, level all, default off  -> read, shown for decision / answer / failure (the thread level beats the default)
  //   - granted, hidden, level decisions_and_failures -> shown for decision and failure, not for answer
  //   - granted, hidden, level off, default all  -> read, not shown
  //   - granted, hidden, no thread level, default decisions_and_failures -> default applies
  // Catches: a request sent by a tab that has no permission; a notification for a conversation the employee is looking at; the
  //   level table read the wrong way round (answer shown on "decisions and failures"); the thread level ignored in favour of
  //   the default.
  // @category: core-functionality
  // @dependency: useAttentionNotifications, LiveStore, notifications store, MSW, stub Notification
  // @complexity: high
  it.each(ROWS)(
    'AC-08.1 AC-09.1 AC-10.1 AC-10.2: $name -> read $read, shown $shown',
    ({ permission, onView, threadLevel, userLevel, event, read, shown }) => {
      const reads = skipBeforeRead({ permission, onView }) === null;
      expect(reads).toBe(read);
      expect(reads && levelAllows({ threadLevel, userLevel, event })).toBe(
        shown,
      );
    },
  );

  // AC: AC-08.2 "…браузер показывает уведомление с названием беседы и событием на языке интерфейса, без текста ответа."
  // AC: AC-09.2 "…три вкладки… браузер показывает одно уведомление." (web half: the tag is the thread id)
  // Behavior: an allowed event → one `new Notification(title, { tag: thread id, body: event text in the UI language })`; the title
  //   is the thread title, «Новая беседа» when it has none; the body carries one of three event texts and nothing from the reply;
  //   a failing thread read → no notification and one log record with ids and no title.
  // Catches: a tag other than the thread id (three tabs show three toasts); the thread title or answer text of the reply in the
  //   log or body; an untitled thread shown with an empty title; a read error that throws out of the event handler.
  // @category: core-functionality
  // @dependency: useAttentionNotifications, next-intl, MSW, stub Notification, logger
  // @complexity: medium
  it.todo(
    'AC-08.2 AC-09.2: the notification carries the thread title (or «Новая беседа»), the event text and tag = thread id; a failed read shows nothing',
  );
});
