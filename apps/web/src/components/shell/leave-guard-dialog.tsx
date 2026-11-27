'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useStore } from 'zustand';
import { CONTROL_SIZE } from '@/components/admin/admin-form';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { LeaveGuardState } from '@/lib/leave-guard';
import { useShellServices } from './shell-actions';

/**
 * The one question before leaving unsaved changes, mounted once by the shell: it shows the open question of
 * `leaveGuard` and answers it. The focus starts on «Остаться»; Esc answers the same. A library record is named
 * (UXRD MC-11; a new one without a name gets the text without it), access levels are counted (access-levels MC-37).
 */
export function LeaveGuardDialog() {
  const t = useTranslations('shell.leaveGuard');
  const { leaveGuard } = useShellServices();
  const question = useStore(leaveGuard, (state) => state.question);
  // The last question stays on screen while the dialog fades out after the answer.
  const [shown, setShown] = useState<LeaveGuardState['question']>(question);
  if (question !== null && question !== shown) setShown(question);
  const stayRef = useRef<HTMLButtonElement>(null);
  const body = (): string => {
    if (shown?.kind === 'access')
      return t('bodyAccess', { count: shown.changes });
    const name = shown?.name.trim() ?? '';
    return name === '' ? t('bodyNew') : t('body', { name });
  };

  return (
    <AlertDialog
      open={question !== null}
      onOpenChange={(open) => {
        if (!open) leaveGuard.answer(false);
      }}
    >
      <AlertDialogContent initialFocus={stayRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{body()}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={stayRef} size="sm" className={CONTROL_SIZE}>
            {t('stay')}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            size="sm"
            className={CONTROL_SIZE}
            onClick={() => leaveGuard.answer(true)}
          >
            {shown?.kind === 'access' ? t('leaveAccess') : t('leave')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
