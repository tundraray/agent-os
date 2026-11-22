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
 * UXRD MC-11, the one question before leaving unsaved changes, mounted once by the shell: it shows the open question
 * of `leaveGuard` and answers it. The focus starts on «Остаться»; Esc answers the same. A record without a name
 * yet (a new one) gets the text without a name.
 */
export function LeaveGuardDialog() {
  const t = useTranslations('shell.leaveGuard');
  const { leaveGuard } = useShellServices();
  const question = useStore(leaveGuard, (state) => state.question);
  // The last question stays on screen while the dialog fades out after the answer.
  const [shown, setShown] = useState<LeaveGuardState['question']>(question);
  if (question !== null && question !== shown) setShown(question);
  const stayRef = useRef<HTMLButtonElement>(null);
  const name = shown?.name.trim() ?? '';

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
          <AlertDialogDescription>
            {name === '' ? t('bodyNew') : t('body', { name })}
          </AlertDialogDescription>
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
            {t('leave')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
