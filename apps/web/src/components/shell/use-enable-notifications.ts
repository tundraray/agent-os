'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { useShellServices } from './shell-actions';

/**
 * «Включить уведомления» of the offer LF-03, the section LF-04 and «Включить в браузере» of LF-05: asks the browser
 * (only ever from the employee's click, UXRD KD-3); a refusal shows MC-3. Resolves once the browser has answered.
 */
export function useEnableNotifications(): () => Promise<void> {
  const t = useTranslations('shell.notifications');
  const { notifications } = useShellServices();
  return async () => {
    try {
      const answer = await notifications.ask();
      if (answer === 'denied') toast(t('denied'));
    } catch (error) {
      logger.error('notifications: permission request failed', { error });
    }
  };
}
