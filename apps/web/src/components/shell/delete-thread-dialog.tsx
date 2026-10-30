'use client';

import { useRef, type RefObject } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export type DeleteThreadDialogProps = {
  open: boolean;
  /** Title as the list shows it, «Новая беседа» for an untitled thread. */
  threadTitle: string;
  /** A reply is generating in the thread: the dialog says it will be stopped (A-4). */
  isRunning: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  /** Element focused once the dialog closes; an empty ref leaves focus to the caller (e.g. the route change). */
  finalFocus: RefObject<HTMLElement | null>;
};

/** DLG-01: confirms deleting a thread; «Отмена» is the default action, Esc and a click outside cancel. */
export function DeleteThreadDialog({
  open,
  threadTitle,
  isRunning,
  onConfirm,
  onOpenChange,
  finalFocus,
}: DeleteThreadDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <AlertDialogContent
        initialFocus={cancelRef}
        finalFocus={() => finalFocus.current ?? false}
        className="max-w-[calc(100%-2rem)] data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-100"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить беседу?</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="flex flex-col gap-2 wrap-break-word">
            <p>Беседа «{threadTitle}» и все её сообщения будут удалены. Это действие нельзя отменить.</p>
            {isRunning && <p>Ответ ассистента в этой беседе ещё генерируется — он будет остановлен.</p>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef}>Отмена</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            Удалить
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
