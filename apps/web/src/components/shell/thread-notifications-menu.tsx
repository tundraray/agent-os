'use client';

import { BellIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  NotificationLevelSchema,
  type NotificationLevel,
} from '@agent-os/contracts';
import { NOTIFICATIONS_SECTION_ID } from '@/components/account/notifications-section';
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { useMediaQuery } from '@/hooks/use-media-query';
import type { NotificationPermissionState } from '@/lib/notifications/notifications-store';
import { ACCOUNT_PATH } from '@/lib/shell-route';
import { ShellLink } from './shell-link';

/** What a row's submenu needs from the shell: the employee's default, the browser's state and the two actions. */
export type RowNotifications = {
  /** `null` while the employee is not read: the submenu waits for it, its first item names the default. */
  defaultLevel: NotificationLevel | null;
  permission: NotificationPermissionState;
  /** Saves the level, `null` — as the default; the menu closes at once (KD-7). */
  onChoose: (level: NotificationLevel | null) => void;
  /** «Включить в браузере»: asks the browser. */
  onEnable: () => void;
};

/** The radio value of «Как по умолчанию»: a radio item needs a value, the contract's is `null`. */
const AS_DEFAULT = 'default';

/** LF-06: the conversation is silent — its own `off`, or «как по умолчанию» with the default `off`. */
export const isSilent = (
  level: NotificationLevel | null,
  defaultLevel: NotificationLevel | null,
): boolean => (level ?? defaultLevel) === 'off';

/**
 * LF-05 of the live-feed UXRD: «Уведомления» in a row's «⋯» menu, a radio group of four levels (MC-7) whose choice saves
 * and closes the menu, and under a line the item the browser's state calls for: «Включить в браузере» while not asked,
 * nothing once granted, MC-8 to the section LF-04 otherwise. From 640 px the submenu opens beside the menu, below it
 * over the menu's edge. The checked level is the row's, so after a failed save the old mark stays.
 */
export function ThreadNotificationsMenu({
  level,
  notifications,
}: {
  level: NotificationLevel | null;
  notifications: RowNotifications;
}) {
  const t = useTranslations('shell.thread');
  const tLevel = useTranslations('account.notifications.level');
  const wide = useMediaQuery('(min-width: 640px)');
  const { defaultLevel, permission, onChoose, onEnable } = notifications;

  if (defaultLevel === null) return null;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <BellIcon aria-hidden />
        {t('notifications')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        side={wide ? 'right' : 'bottom'}
        align={wide ? 'start' : 'end'}
        className="min-w-56"
      >
        <DropdownMenuRadioGroup
          value={level ?? AS_DEFAULT}
          onValueChange={(value: unknown) => {
            if (value === AS_DEFAULT) {
              onChoose(null);
              return;
            }
            const parsed = NotificationLevelSchema.safeParse(value);
            if (parsed.success) onChoose(parsed.data);
          }}
        >
          <DropdownMenuRadioItem value={AS_DEFAULT} closeOnClick>
            {t('levelDefault', { level: tLevel(defaultLevel) })}
          </DropdownMenuRadioItem>
          {NotificationLevelSchema.options.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} closeOnClick>
              {tLevel(option)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {permission !== 'granted' && <DropdownMenuSeparator />}
        {permission === 'default' && (
          <DropdownMenuItem onClick={onEnable}>
            {t('enableInBrowser')}
          </DropdownMenuItem>
        )}
        {permission !== 'default' && permission !== 'granted' && (
          <DropdownMenuItem
            render={
              <ShellLink href={`${ACCOUNT_PATH}#${NOTIFICATIONS_SECTION_ID}`} />
            }
          >
            {t('browserBlocked')}
          </DropdownMenuItem>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
