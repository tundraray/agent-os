'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useStore } from 'zustand';
import {
  NotificationLevelSchema,
  type NotificationLevel,
} from '@agent-os/contracts';
import { useShellServices } from '@/components/shell/shell-actions';
import { useEnableNotifications } from '@/components/shell/use-enable-notifications';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { describeApiError } from '@/lib/api/api-request';
import { authApi } from '@/lib/auth/auth-api';
import type { CurrentUserStore } from '@/lib/auth/current-user';
import { logger } from '@/lib/logger';

/** The section's anchor: MC-8 in a conversation's submenu leads here (live-feed UXRD LF-05). */
export const NOTIFICATIONS_SECTION_ID = 'notifications';

/** MC-4: «Без уведомлений» has no hint. */
const LEVEL_HINT = {
  all: 'levelHint.all',
  decisions_and_failures: 'levelHint.decisions_and_failures',
  off: null,
} as const satisfies Record<NotificationLevel, string | null>;

/**
 * LF-04 of the live-feed UXRD, last on «Мой доступ»: the browser's state (MC-6), «Включить уведомления» only while the
 * browser has not been asked and the default level is not `off`, and the default level saved at once on choice
 * (settings-form «Сохранение на месте»). The checked level is `CurrentUser.notificationLevel`; the group is
 * available in every browser state, because the level belongs to the employee.
 */
export function NotificationsSection({
  currentUser,
}: {
  currentUser: CurrentUserStore;
}) {
  const t = useTranslations('account.notifications');
  const { notifications } = useShellServices();
  const askBrowser = useEnableNotifications();
  const headingId = useId();
  const levelHeadingId = useId();
  const hintId = useId();
  const user = useStore(currentUser, (state) => state.user);
  const permission = useStore(notifications, (state) => state.permission);
  const [pending, setPending] = useState<NotificationLevel | null>(null);
  const [failed, setFailed] = useState(false);
  const itemRefs = useRef(new Map<NotificationLevel, HTMLElement>());
  const level = user?.notificationLevel;

  // settings-form «Переключатель или выбор»: after a refusal focus stays on the level checked again.
  useEffect(() => {
    if (failed && level !== undefined) itemRefs.current.get(level)?.focus();
  }, [failed, level]);

  if (user === null || level === undefined) return null;

  const checked = pending ?? level;

  async function choose(next: NotificationLevel): Promise<void> {
    if (pending !== null || next === level) return;
    setPending(next);
    setFailed(false);
    try {
      await authApi.saveNotificationLevel(next);
      logger.info('account: notification level saved', { level: next });
      currentUser.setNotificationLevel(next);
    } catch (cause) {
      logger.error('account: notification level save failed', {
        level: next,
        ...describeApiError(cause),
      });
      setFailed(true);
    } finally {
      setPending(null);
    }
  }

  async function enable(): Promise<void> {
    await askBrowser();
    // UXRD «Accessibility»: the button is gone after the answer, focus moves to the level group.
    itemRefs.current.get(checked)?.focus();
  }

  return (
    <section
      id={NOTIFICATIONS_SECTION_ID}
      aria-labelledby={headingId}
      className="flex max-w-160 flex-col gap-4"
    >
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {t('heading')}
      </h2>
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm leading-5">{t(`browser.${permission}`)}</p>
        {permission === 'default' && level !== 'off' && (
          <Button variant="outline" size="sm" onClick={() => void enable()}>
            {t('enable')}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <p id={levelHeadingId} className="text-sm leading-5 font-medium">
          {t('defaultLevel')}
        </p>
        <RadioGroup
          aria-labelledby={levelHeadingId}
          aria-describedby={hintId}
          aria-disabled={pending !== null || undefined}
          value={checked}
          onValueChange={(next) => {
            const parsed = NotificationLevelSchema.safeParse(next);
            if (parsed.success) void choose(parsed.data);
          }}
          className="flex flex-col gap-2"
        >
          {NotificationLevelSchema.options.map((option) => {
            const hint = LEVEL_HINT[option];
            return (
              <Label
                key={option}
                className="flex w-fit items-start gap-2 text-sm leading-5 font-normal text-foreground pointer-coarse:min-h-11"
              >
                <RadioGroupItem
                  value={option}
                  className="mt-0.5"
                  ref={(node: HTMLElement | null) => {
                    if (node === null) itemRefs.current.delete(option);
                    else itemRefs.current.set(option, node);
                  }}
                />
                <span className="flex flex-col sm:flex-row sm:gap-3">
                  <span>{t(`level.${option}`)}</span>
                  {hint !== null && (
                    <span className="text-xs leading-5 text-muted-foreground">
                      {t(hint)}
                    </span>
                  )}
                </span>
              </Label>
            );
          })}
        </RadioGroup>
        {failed ? (
          <p
            id={hintId}
            role="alert"
            className="text-xs leading-4 text-destructive"
          >
            {t('saveFailed')}
          </p>
        ) : (
          <p id={hintId} className="text-xs leading-4 text-muted-foreground">
            {t('appliesEverywhere')}
          </p>
        )}
      </div>
    </section>
  );
}
