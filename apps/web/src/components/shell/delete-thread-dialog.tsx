'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { logger } from '@/lib/logger';
import { threadsApiClient } from '@/lib/threads/threads-api-client';
import { describeThreadsError } from '@/lib/threads/threads-api-error';
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
  /**
   * Server id of the thread: its agents decide the MC-26 paragraph. Undefined for a thread promoted at
   * the first send that has no server id yet — it has no agents to read.
   */
  threadId: string | undefined;
  /** Title as the list shows it, «Новая беседа» for an untitled thread. */
  threadTitle: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  /** Element focused once the dialog closes; an empty ref leaves focus to the caller (e.g. the route change). */
  finalFocus: RefObject<HTMLElement | null>;
};

/** MC-26. */
const AGENTS_PARAGRAPH = 'Агенты и запуски workflow этой беседы тоже будут удалены, работающие — остановлены.';

/**
 * Whether the thread has agents, read each time the dialog opens. Until the answer arrives, and after a
 * failed read, the dialog shows no MC-26 paragraph.
 */
function useThreadHasAgents(threadId: string | undefined, open: boolean): boolean {
  const [answer, setAnswer] = useState<{ threadId: string; hasAgents: boolean } | null>(null);

  useEffect(() => {
    if (!open || threadId === undefined) return;
    let current = true;
    threadsApiClient.getThreadAgents(threadId).then(
      (agents) => {
        if (current) setAnswer({ threadId, hasAgents: agents.length > 0 });
      },
      (error: unknown) => {
        logger.warn('thread agents read failed', { ...describeThreadsError(error), threadId });
      },
    );
    return () => {
      current = false;
    };
  }, [open, threadId]);

  return answer !== null && answer.threadId === threadId && answer.hasAgents;
}

/**
 * DLG-01: confirms deleting a thread; «Отмена» is the default action, Esc and a click outside cancel.
 * A thread with agents adds the MC-26 paragraph.
 */
export function DeleteThreadDialog({
  open,
  threadId,
  threadTitle,
  onConfirm,
  onOpenChange,
  finalFocus,
}: DeleteThreadDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const hasAgents = useThreadHasAgents(threadId, open);
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
            {hasAgents && <p>{AGENTS_PARAGRAPH}</p>}
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
