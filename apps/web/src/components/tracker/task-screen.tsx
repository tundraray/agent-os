'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontalIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  TRACKER_DESCRIPTION_MAX_LENGTH,
  type ChipRecord,
  type TrackerTaskPatchBody,
  type TrackerTaskStatus,
  type TrackerTaskView,
} from '@agent-os/contracts';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { useChatAgents } from '@/components/assistant-ui/elements/composer-actions';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { ThreadTitleField } from '@/components/shell/thread-title-field';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useResource } from '@/hooks/use-resource';
import { isNotFound } from '@/lib/admin/admin-errors';
import { describeApiError } from '@/lib/api/api-request';
import { focusShellTarget } from '@/lib/focus';
import { createCoalescedRunner } from '@/lib/live/coalesced-runner';
import { logger } from '@/lib/logger';
import { trackerPath } from '@/lib/shell-route';
import { startTimer } from '@/lib/timer';
import { trackerApi } from '@/lib/tracker/tracker-api';
import { describeTrackerError } from '@/lib/tracker/tracker-errors';
import { DelegateDialog } from './delegate-dialog';
import { TaskConversations } from './task-conversations';
import { TaskFeed } from './task-feed';
import { TrackerStatusSelect } from './tracker-status';

/** Re-reads by live changes no more often than once a second, like the schedules' pages. */
const REREAD_INTERVAL_MS = 1000;
/** How much of an agent's comment the announcement reads (MC-8). */
const ANNOUNCED_TEXT_LENGTH = 120;

/**
 * The task screen `/tasks/<id>` (TT-05 – TT-09): read on open, after every own change and on the changes of its own
 * conversations — the root's records, their state, row and deletion — and on every reconnect (KD-2, Flow 5), so an
 * agent's report shows while the screen is open. A failed re-read keeps the last task on screen; the read logs it.
 * Any 404 — a foreign, deleted or missing task — is TT-12, which names nothing of the task.
 */
export function TaskScreen({ id }: { id: string }) {
  const { libraryIndex } = useShellServices();
  const resource = useResource(() => trackerApi.get(id), id, 'tracker');
  const [shown, setShown] = useState<TrackerTaskView | undefined>(undefined);
  if (resource.data !== undefined && resource.data !== shown)
    setShown(resource.data);
  const agents = useChatAgents().map((agent) => agent.chip);

  // The «Агент» field and the agents' icons read the library list (KD-4), as a conversation does on entering.
  useEffect(() => {
    void libraryIndex.refresh();
  }, [libraryIndex]);
  useReloadOnOwnConversations(shown, resource.reload);
  useAnnounceAgentComments(shown);

  if (isNotFound(resource.error))
    return <ThreadNotice variant="task-not-found" />;
  if (shown === undefined && resource.status === 'error')
    return <ThreadNotice variant="task-load-error" onRetry={resource.reload} />;
  if (shown === undefined) return <TaskSkeleton />;
  return <TaskPage task={shown} agents={agents} onChanged={resource.reload} />;
}

/** KD-2: the own conversations' `entries` of their root, `state`, `summary`, `deleted`, and `ready`, coalesced. */
function useReloadOnOwnConversations(
  task: TrackerTaskView | undefined,
  reload: () => void,
): void {
  const { live } = useShellServices();
  const reloadRef = useRef(reload);
  useLayoutEffect(() => {
    reloadRef.current = reload;
  });
  const conversationIds =
    task?.conversations.map((conversation) => conversation.id).join(' ') ?? '';
  useEffect(() => {
    // `reload` only starts reads; it never rejects, so the runner never hands a rejection on.
    const runner = createCoalescedRunner(
      async () => {
        reloadRef.current();
      },
      { minIntervalMs: REREAD_INTERVAL_MS },
    );
    const request = (): void => {
      void runner.request();
    };
    const ids = conversationIds === '' ? [] : conversationIds.split(' ');
    // The root agent's id is the conversation's: `agentId` leaves out the records of its subagents.
    const unsubscribers = [
      ...ids.map((threadId) =>
        live.onChange(
          {
            kinds: ['entries', 'state', 'summary', 'deleted'],
            threadId,
            agentId: threadId,
          },
          request,
        ),
      ),
      live.onReady(request),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      runner.cancel();
    };
  }, [live, conversationIds]);
}

/** MC-8: a new agent comment, found by its id against the previous read; the first read announces nothing. */
function useAnnounceAgentComments(task: TrackerTaskView | undefined): void {
  const { announcer } = useShellServices();
  const tAgent = useTranslations('common.agentField');
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (task === undefined) return;
    const comments = task.feed.flatMap((item) =>
      item.kind === 'comment' && item.author === 'agent' ? [item] : [],
    );
    const previous = known.current;
    known.current = new Set(comments.map((comment) => comment.id));
    if (previous === null) return;
    for (const comment of comments) {
      if (previous.has(comment.id)) continue;
      const agent = task.conversations.find(
        (conversation) => conversation.id === comment.conversationId,
      )?.agent;
      announcer.getState().announce('tracker.feed.agentComment', {
        agent: agent?.name ?? tAgent('chatAgent'),
        text: comment.text.slice(0, ANNOUNCED_TEXT_LENGTH),
      });
    }
  }, [task, announcer, tAgent]);
}

function TaskPage({
  task,
  agents,
  onChanged,
}: {
  task: TrackerTaskView;
  agents: readonly ChipRecord[];
  onChanged: () => void;
}) {
  const t = useTranslations('tracker');
  const tErrors = useTranslations('errors');
  const { announcer } = useShellServices();
  const router = useRouter();
  const menuRef = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [delegating, setDelegating] = useState(false);
  /** The status being saved, or saved and waiting for the next read: it stands on the button meanwhile. */
  const [picked, setPicked] = useState<{
    status: TrackerTaskStatus;
    saving: boolean;
    over: TrackerTaskView;
  } | null>(null);
  const taskId = task.id;

  // UXRD «Порядок фокуса»: once the task is on screen, focus lands on its title.
  useEffect(() => {
    focusShellTarget('page-title');
  }, [taskId]);

  async function patch(
    body: TrackerTaskPatchBody,
    where: 'status' | 'save',
  ): Promise<boolean> {
    const durationMs = startTimer();
    const fields = () => ({
      taskId,
      fields: Object.keys(body),
      durationMs: durationMs(),
    });
    try {
      await trackerApi.update(taskId, body);
      logger.info('tracker: task saved', fields());
      return true;
    } catch (cause) {
      logger.warn('tracker: save refused', {
        ...fields(),
        ...describeApiError(cause),
      });
      toast.error(describeTrackerError(tErrors, cause, { where }).text);
      return false;
    } finally {
      onChanged();
    }
  }

  async function changeStatus(status: TrackerTaskStatus): Promise<void> {
    setPicked({ status, saving: true, over: task });
    if (await patch({ status }, 'status')) {
      setPicked({ status, saving: false, over: task });
      announcer.getState().announce('tracker.task.statusAnnounced', {
        status: t(`status.${status}`),
      });
    } else setPicked(null);
  }

  async function rename(title: string): Promise<void> {
    setRenaming(false);
    menuRef.current?.focus();
    await patch({ title }, 'save');
  }

  async function remove(): Promise<void> {
    const durationMs = startTimer();
    const fields = () => ({ taskId, durationMs: durationMs() });
    try {
      await trackerApi.remove(taskId);
    } catch (cause) {
      logger.warn('tracker: delete refused', {
        ...fields(),
        ...describeApiError(cause),
      });
      throw cause;
    }
    logger.info('tracker: task deleted', fields());
    toast.success(t('task.deleted'));
    router.push(trackerPath());
  }

  const shownStatus = picked !== null && picked.over === task ? picked : null;

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title={task.title}
        parent={{ title: t('list.title'), href: trackerPath() }}
        titleField={
          renaming ? (
            <div className="min-w-16 flex-1">
              <ThreadTitleField
                initialTitle={task.title}
                onSave={(title) => void rename(title)}
                onCancel={() => {
                  setRenaming(false);
                  menuRef.current?.focus();
                }}
              />
            </div>
          ) : undefined
        }
        badge={
          <TrackerStatusSelect
            status={shownStatus?.status ?? task.status}
            saving={shownStatus?.saving === true}
            onSelect={(status) => void changeStatus(status)}
          />
        }
      >
        <Button
          size="sm"
          className="flex-1 pointer-coarse:h-11 md:flex-none"
          onClick={() => setDelegating(true)}
        >
          {t('task.delegate')}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            ref={menuRef}
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="pointer-coarse:size-11"
                aria-label={t('task.actions')}
              />
            }
          >
            <MoreHorizontalIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-40">
            <DropdownMenuItem
              className="pointer-coarse:min-h-11"
              onClick={() => setRenaming(true)}
            >
              {t('task.rename')}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="pointer-coarse:min-h-11"
              onClick={() => setDeleting(true)}
            >
              {t('task.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 px-4 py-4 md:py-6 lg:grid-cols-[minmax(0,48rem)_18rem] lg:justify-between">
        <Description
          description={task.description}
          onSave={(description) => patch({ description }, 'save')}
        />
        <aside className="lg:sticky lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
          <TaskConversations
            conversations={task.conversations}
            agents={agents}
          />
        </aside>
        <div className="lg:col-start-1 lg:row-start-2">
          <TaskFeed task={task} agents={agents} onChanged={onChanged} />
        </div>
      </div>
      <DelegateDialog
        task={task}
        agents={agents}
        open={delegating}
        onOpenChange={setDelegating}
        onDelegated={onChanged}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('task.deleteTitle')}
        body={t('task.deleteBody', { title: task.title })}
        confirmLabel={t('task.deleteConfirm')}
        onConfirm={remove}
        refusalText={(cause) =>
          describeTrackerError(tErrors, cause, { where: 'delete' }).text
        }
      />
    </div>
  );
}

/**
 * TT-06: «Описание» and «Изменить»; the text as written, or «Добавить описание». The editor saves on «Сохранить»,
 * Ctrl+Enter or ⌘+Enter and cancels on Esc; a refusal keeps it open with the text. Focus goes back to the button.
 */
function Description({
  description,
  onSave,
}: {
  description: string;
  onSave: (description: string) => Promise<boolean>;
}) {
  const t = useTranslations('tracker.task');
  const tCommon = useTranslations('common');
  const headingId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const empty = description.trim() === '';

  const close = (): void => {
    setDraft(null);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  async function save(): Promise<void> {
    if (draft === null || saving) return;
    setSaving(true);
    const saved = await onSave(draft);
    setSaving(false);
    if (saved) close();
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 id={headingId} className="text-sm leading-5 font-medium">
          {t('description')}
        </h2>
        {draft === null && !empty && (
          <Button
            ref={buttonRef}
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => setDraft(description)}
          >
            {t('edit')}
          </Button>
        )}
      </div>
      {draft !== null ? (
        <div className="flex max-w-160 flex-col gap-2">
          <Textarea
            aria-labelledby={headingId}
            autoFocus
            maxLength={TRACKER_DESCRIPTION_MAX_LENGTH}
            value={draft}
            readOnly={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            className="max-h-96 min-h-24 text-sm leading-5"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="pointer-coarse:h-11"
              disabled={saving}
              onClick={() => void save()}
            >
              {t('save')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
              disabled={saving}
              onClick={close}
            >
              {tCommon('cancel')}
            </Button>
          </div>
        </div>
      ) : empty ? (
        <div>
          <Button
            ref={buttonRef}
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => setDraft('')}
          >
            {t('addDescription')}
          </Button>
        </div>
      ) : (
        <p className="max-w-160 text-sm leading-5 whitespace-pre-wrap wrap-break-word text-foreground">
          {description}
        </p>
      )}
    </section>
  );
}

/** TT-05 – TT-08 Loading: the description, the feed and the conversations as skeletons. */
function TaskSkeleton() {
  return (
    <div
      aria-busy
      className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 px-4 py-4 md:py-6 lg:grid-cols-[minmax(0,48rem)_18rem] lg:justify-between"
    >
      <div aria-hidden className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
        {[0, 1, 2].map((row) => (
          <div key={row} className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </div>
      <div aria-hidden className="flex flex-col gap-3">
        <Skeleton className="h-4 w-20" />
        {[0, 1].map((row) => (
          <div key={row} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}
