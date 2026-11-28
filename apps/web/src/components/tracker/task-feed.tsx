'use client';

import {
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowUpRightIcon,
  BotIcon,
  LoaderCircle,
  WorkflowIcon,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  TRACKER_COMMENT_MAX_LENGTH,
  TrackerErrorCodeSchema,
  type ChipRecord,
  type TrackerFeedItem,
  type TrackerTaskConversation,
  type TrackerTaskView,
} from '@agent-os/contracts';
import { CAPTION } from '@/components/admin/admin-form';
import { RECORD_KIND_ICON } from '@/components/library/record-label';
import { ShellLink } from '@/components/shell/shell-link';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { formatListTime } from '@/i18n/formats';
import { isNotFound } from '@/lib/admin/admin-errors';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import { threadPath } from '@/lib/shell-route';
import { startTimer } from '@/lib/timer';
import { trackerApi } from '@/lib/tracker/tracker-api';
import { describeTrackerError } from '@/lib/tracker/tracker-errors';
import { cn } from '@/lib/utils';
import { TrackerStatusGlyph } from './tracker-status';

const LINK =
  'rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * TT-07, tracker-feed.md: the task's feed, oldest first, and the comment field under it. A comment goes to the
 * agent too while «Передать агенту» is on (KD-5); `onChanged` reads the task again after a comment or a refusal.
 */
export function TaskFeed({
  task,
  agents,
  onChanged,
}: {
  task: TrackerTaskView;
  agents: readonly ChipRecord[];
  onChanged: () => void;
}) {
  const t = useTranslations('tracker.feed');
  const hasComments = task.feed.some((item) => item.kind === 'comment');
  return (
    <div className="flex flex-col gap-4">
      <div
        role="feed"
        aria-label={t('label')}
        className="flex max-w-160 flex-col"
      >
        {task.feed.map((item, index) => (
          <FeedItem
            key={'id' in item ? item.id : `${item.kind}-${item.at}-${index}`}
            item={item}
            task={task}
            agents={agents}
          />
        ))}
      </div>
      {!hasComments && (
        <p className="text-xs leading-4 text-muted-foreground">{t('empty')}</p>
      )}
      <CommentField task={task} onChanged={onChanged} />
    </div>
  );
}

/** The conversation a feed item names, deleted ones too. */
const conversationOf = (
  task: TrackerTaskView,
  id: string | null,
): TrackerTaskConversation | undefined =>
  id === null
    ? undefined
    : task.conversations.find((conversation) => conversation.id === id);

function FeedItem({
  item,
  task,
  agents,
}: {
  item: TrackerFeedItem;
  task: TrackerTaskView;
  agents: readonly ChipRecord[];
}) {
  const t = useTranslations('tracker');
  const tThread = useTranslations('shell.thread');
  const tAgent = useTranslations('common.agentField');
  const format = useFormatter();
  const time = formatListTime(format, item.at);
  const conversation = conversationOf(
    task,
    item.kind === 'created' ? null : item.conversationId,
  );
  const conversationTitle =
    conversation === undefined || conversation.title.trim() === ''
      ? tThread('untitled')
      : conversation.title;
  const agentName = conversation?.agent?.name ?? null;

  switch (item.kind) {
    case 'created':
      return <FeedEvent time={time}>{t('feed.created')}</FeedEvent>;
    case 'delegated':
      return (
        <FeedEvent
          time={time}
          icon={<WorkflowIcon aria-hidden className="size-3.5 shrink-0" />}
        >
          {agentName === null
            ? t('feed.delegatedChat', { title: conversationTitle })
            : t('feed.delegated', {
                agent: agentName,
                title: conversationTitle,
              })}
        </FeedEvent>
      );
    case 'status': {
      const status = t(`status.${item.status}`);
      return (
        <FeedEvent
          time={time}
          icon={<TrackerStatusGlyph status={item.status} />}
        >
          {item.author === 'employee'
            ? t('feed.statusByYou', { status })
            : agentName === null
              ? t('feed.statusByChat', { status })
              : t('feed.statusByAgent', { agent: agentName, status })}
        </FeedEvent>
      );
    }
    case 'comment': {
      const byAgent = item.author === 'agent';
      const author = byAgent
        ? (agentName ?? tAgent('chatAgent'))
        : t('feed.you');
      const kind = agents.find(
        (agent) => agent.id === conversation?.agent?.id,
      )?.kind;
      const AgentIcon = kind === undefined ? BotIcon : RECORD_KIND_ICON[kind];
      const deleted = conversation?.deleted === true;
      const link = (chunks: ReactNode): ReactNode =>
        conversation === undefined ? null : (
          <ShellLink href={threadPath(conversation.id)} className={LINK}>
            {chunks}
            <ArrowUpRightIcon
              aria-hidden
              className="ms-0.5 inline size-3.5 align-text-bottom"
            />
          </ShellLink>
        );
      return (
        <article
          aria-label={t('feed.article', { author, time })}
          className="flex flex-col gap-1 pt-4 first:pt-0"
        >
          <p className="flex flex-wrap items-center gap-x-1 text-xs leading-4">
            {byAgent && (
              <AgentIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            )}
            <span className="text-sm leading-5 font-medium text-foreground">
              {author}
            </span>
            <span className="text-muted-foreground tabular-nums">· {time}</span>
            {byAgent && conversation !== undefined && (
              <span className="text-muted-foreground">
                ·{' '}
                {deleted
                  ? t('feed.fromDeleted', { title: conversationTitle })
                  : t.rich('feed.from', { title: conversationTitle, link })}
              </span>
            )}
          </p>
          <p className="text-sm leading-5 whitespace-pre-wrap wrap-break-word text-foreground">
            {item.text}
          </p>
          {!byAgent && conversation !== undefined && (
            <p className="flex items-center gap-1 text-xs leading-4 text-muted-foreground">
              <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0" />
              {deleted
                ? t('feed.forwardedDeleted', { title: conversationTitle })
                : t.rich('feed.forwarded', { title: conversationTitle, link })}
            </p>
          )}
        </article>
      );
    }
  }
}

/** An event: one Caption line, its icon and the time at its end. */
function FeedEvent({
  time,
  icon,
  children,
}: {
  time: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <p className="flex items-start gap-1 pt-2 text-xs leading-4 text-muted-foreground first:pt-0">
      {icon}
      <span>
        {children} · <span className="tabular-nums">{time}</span>
      </span>
    </p>
  );
}

/**
 * The comment field (tracker-feed.md, parts 6–9; UXRD KD-5). The switch turns on when the task first gets a live
 * conversation to send to and keeps the employee's choice until they leave the screen; without one it is off and
 * unavailable with the reason (DD «Состояния экранов»). Enter sends, Shift+Enter breaks the line; a refusal keeps
 * the text, and 409 `TRACKER_NO_CONVERSATION` or 404 read the task again (Flow 3).
 */
function CommentField({
  task,
  onChanged,
}: {
  task: TrackerTaskView;
  onChanged: () => void;
}) {
  const t = useTranslations('tracker.feed');
  const tThread = useTranslations('shell.thread');
  const tErrors = useTranslations('errors');
  const id = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const target = task.forwardTo;
  const [forward, setForward] = useState(true);
  const [hadTarget, setHadTarget] = useState(target !== null);
  if (hadTarget !== (target !== null)) {
    setHadTarget(target !== null);
    if (target !== null) setForward(true);
  }
  const forwarding = target !== null && forward;
  const describedById = `${id}-target`;
  const errorId = `${id}-error`;
  const targetTitle =
    target === null || target.title.trim() === ''
      ? tThread('untitled')
      : target.title;
  const reason =
    task.conversations.length === 0 ? t('notDelegated') : t('allDeleted');

  async function send(): Promise<void> {
    const trimmed = text.trim();
    if (sending || trimmed === '') return;
    setSending(true);
    setError(null);
    const durationMs = startTimer();
    const fields = () => ({ taskId: task.id, durationMs: durationMs() });
    try {
      await trackerApi.comment(task.id, {
        text: trimmed,
        forward: forwarding,
      });
      logger.info('tracker: comment saved', {
        ...fields(),
        forward: forwarding,
      });
      setText('');
      onChanged();
    } catch (cause) {
      logger.warn('tracker: comment refused', {
        ...fields(),
        ...describeApiError(cause),
      });
      setError(describeTrackerError(tErrors, cause, { where: 'comment' }).text);
      if (
        isNotFound(cause) ||
        (isApiRequestError(cause) &&
          cause.code === TrackerErrorCodeSchema.enum.TRACKER_NO_CONVERSATION)
      )
        onChanged();
    } finally {
      setSending(false);
      fieldRef.current?.focus();
    }
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    void send();
  };

  return (
    <form onSubmit={onSubmit} className="flex max-w-160 flex-col gap-2">
      <Textarea
        ref={fieldRef}
        aria-label={t('comment')}
        placeholder={t('comment')}
        maxLength={TRACKER_COMMENT_MAX_LENGTH}
        value={text}
        readOnly={sending}
        aria-invalid={error !== null || undefined}
        aria-describedby={error === null ? undefined : errorId}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-60 min-h-18 text-sm leading-5"
      />
      {error !== null && (
        <p id={errorId} className={cn(CAPTION, 'text-destructive')}>
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-x-2 gap-y-1 sm:basis-0">
          <label className="flex shrink-0 items-center gap-2 text-sm leading-5 text-foreground">
            <Switch
              checked={forwarding}
              disabled={target === null || sending}
              onCheckedChange={setForward}
              aria-describedby={describedById}
            />
            {t('forward')}
          </label>
          <span
            id={describedById}
            title={target === null ? undefined : targetTitle}
            className="min-w-0 truncate text-xs leading-4 text-muted-foreground max-sm:basis-full"
          >
            {target === null
              ? reason
              : forwarding
                ? t('target', { title: targetTitle })
                : null}
          </span>
        </div>
        <Button
          type="submit"
          size="sm"
          className="ms-auto pointer-coarse:h-11"
          disabled={text.trim() === '' && !sending}
          aria-disabled={sending || undefined}
        >
          {sending && (
            <LoaderCircle
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
            />
          )}
          {forwarding ? t('sendToAgent') : t('send')}
        </Button>
      </div>
    </form>
  );
}
