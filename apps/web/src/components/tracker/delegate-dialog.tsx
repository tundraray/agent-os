'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  TRACKER_COMMENT_MAX_LENGTH,
  type ChipRecord,
  type TrackerTaskView,
} from '@agent-os/contracts';
import { AgentField } from '@/components/agent-field';
import {
  AdminTextField,
  CAPTION,
  COMFORT_CONTROL,
  FormError,
  FormWarning,
} from '@/components/admin/admin-form';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describeApiError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import { threadPath } from '@/lib/shell-route';
import { startTimer } from '@/lib/timer';
import { trackerApi } from '@/lib/tracker/tracker-api';
import { describeTrackerError } from '@/lib/tracker/tracker-errors';
import { cn } from '@/lib/utils';

export type DelegateDialogProps = {
  task: TrackerTaskView;
  /** The agents of «+» and `@` (`useChatAgents()`). */
  agents: readonly ChipRecord[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The delegation was taken; the dialog has closed by then. */
  onDelegated: () => void;
};

/**
 * TT-09 «Поручить агенту» (settings-form «Форма диалога», UXRD KD-6; Flow 2). The body mounts with the open dialog,
 * so every open starts from the agent of the last delegation — while «+» still lists it — or the chat agent.
 */
export function DelegateDialog({
  task,
  agents,
  open,
  onOpenChange,
  onDelegated,
}: DelegateDialogProps) {
  const t = useTranslations('tracker.dialog');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-140">
        <DialogHeader>
          <DialogTitle className="text-base leading-6 font-semibold">
            {t('title')}
          </DialogTitle>
        </DialogHeader>
        <DelegateForm
          task={task}
          agents={agents}
          onDelegated={() => {
            onOpenChange(false);
            onDelegated();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function DelegateForm({
  task,
  agents,
  onDelegated,
}: {
  task: TrackerTaskView;
  agents: readonly ChipRecord[];
  onDelegated: () => void;
}) {
  const t = useTranslations('tracker');
  const tCommon = useTranslations('common');
  const tAgent = useTranslations('common.agentField');
  const tThread = useTranslations('shell.thread');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const router = useRouter();
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [agentId, setAgentId] = useState<string | null>(() => {
    const last = task.conversations[0]?.agent?.id ?? null;
    return agents.some((agent) => agent.id === last) ? last : null;
  });
  const [note, setNote] = useState('');
  const [agentError, setAgentError] = useState<string | undefined>();
  const [formError, setFormError] = useState<ReactNode>(null);
  const [sending, setSending] = useState(false);
  /** Grows with every agent error shown, so focus moves to the field again. */
  const [errorsShown, setErrorsShown] = useState(0);
  const working = task.conversations.find(
    (conversation) => !conversation.deleted && conversation.state === 'working',
  );

  // Runs after the commit that enables the field again, so it can take focus.
  useEffect(() => {
    if (errorsShown === 0) return;
    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [errorsShown]);

  const agentName =
    agentId === null
      ? null
      : (agents.find((agent) => agent.id === agentId)?.name ?? null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setAgentError(undefined);
    setFormError(null);
    const trimmed = note.trim();
    const durationMs = startTimer();
    const fields = () => ({
      taskId: task.id,
      agentId,
      durationMs: durationMs(),
    });
    try {
      const { conversationId } = await trackerApi.delegate(task.id, {
        agentId,
        ...(trimmed === '' ? {} : { note: trimmed }),
        language: locale,
      });
      logger.info('tracker: delegated', { ...fields(), conversationId });
      toast.success(
        t('task.delegated', { agent: agentName ?? tAgent('chatAgent') }),
        {
          action: {
            label: t('task.openConversation'),
            onClick: () => router.push(threadPath(conversationId)),
          },
        },
      );
      onDelegated();
    } catch (cause) {
      logger.warn('tracker: delegation refused', {
        ...fields(),
        ...describeApiError(cause),
      });
      setSending(false);
      const refusal = describeTrackerError(tErrors, cause, {
        where: 'delegate',
        agentName,
      });
      if (refusal.place === 'agent') {
        setAgentError(refusal.text);
        setErrorsShown((count) => count + 1);
      } else setFormError(refusal.text);
    }
  }

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex min-h-0 flex-col gap-4"
    >
      <div className="-mx-4 min-h-0 overflow-y-auto px-4">
        <fieldset disabled={sending} className="flex min-w-0 flex-col gap-4">
          <AgentField
            id={`${id}-agent`}
            agents={agents}
            value={agentId}
            error={agentError}
            onChange={(next) => {
              setAgentId(next);
              setAgentError(undefined);
            }}
          />
          <AdminTextField
            id={`${id}-note`}
            density="comfortable"
            multiline
            inputClassName="max-h-48 min-h-20"
            label={t('dialog.note')}
            optional={t('dialog.optional')}
            maxLength={TRACKER_COMMENT_MAX_LENGTH}
            value={note}
            error={undefined}
            onChange={setNote}
          />
          <p className={cn(CAPTION, 'text-muted-foreground')}>
            {t('dialog.hint')}
          </p>
          {working !== undefined && (
            <FormWarning>
              <p>
                {t('dialog.working', {
                  title:
                    working.title.trim() === ''
                      ? tThread('untitled')
                      : working.title,
                })}
              </p>
            </FormWarning>
          )}
        </fieldset>
      </div>
      {formError !== null && <FormError>{formError}</FormError>}
      <DialogFooter className="sm:justify-start">
        <Button type="submit" className={COMFORT_CONTROL} disabled={sending}>
          {sending && (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {t('dialog.submit')}
        </Button>
        <DialogClose
          render={
            <Button
              type="button"
              variant="outline"
              className={COMFORT_CONTROL}
            />
          }
          disabled={sending}
        >
          {tCommon('cancel')}
        </DialogClose>
      </DialogFooter>
    </form>
  );
}
