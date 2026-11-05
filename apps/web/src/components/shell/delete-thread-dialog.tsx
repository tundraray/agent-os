'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
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
import { threadsApiClient } from '@/lib/threads/threads-api-client';
import { describeThreadsError } from '@/lib/threads/threads-api-error';

export type DeleteThreadDialogProps = {
  open: boolean;
  /** Title as the list shows it, «Новая беседа» for an untitled thread. */
  threadTitle: string;
  /** Server id of the thread; a thread not saved yet has no launches to read. */
  threadId: string | undefined;
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
  threadId,
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
            {threadId !== undefined && <RunningResearchNotice threadId={threadId} />}
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

/** MC-22 (deep-research UXRD, KD-7) by the number of running launches; one form for one, the other for several. */
const RUNNING_RESEARCH_NOTICE = {
  one: 'В беседе идёт ресерч — он будет остановлен, ответа не будет.',
  several: 'В беседе идут ресерчи — они будут остановлены, ответов не будет.',
} as const;

/**
 * DC-6: mounted with the open dialog, reads the thread's launches once and names the running ones. Nothing is shown
 * while the read is pending or when it fails: the dialog does not wait for the warning.
 */
function RunningResearchNotice({ threadId }: { threadId: string }) {
  const [running, setRunning] = useState(0);
  useEffect(() => {
    let current = true;
    threadsApiClient.getThreadResearch(threadId).then(
      ({ launches }) => {
        if (current) setRunning(launches.filter((launch) => launch.state === 'running').length);
      },
      (error: unknown) => {
        console.warn('[deep-research] research read for the delete dialog failed', {
          threadId,
          ...describeThreadsError(error),
        });
      },
    );
    return () => {
      current = false;
    };
  }, [threadId]);

  if (running === 0) return null;
  return <p>{running === 1 ? RUNNING_RESEARCH_NOTICE.one : RUNNING_RESEARCH_NOTICE.several}</p>;
}
