'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import {
  SearchXIcon,
  ShieldOffIcon,
  SquarePenIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, buttonVariants } from '@/components/ui/button';
import { pageTitle, useDocumentTitle } from '@/hooks/use-document-title';
import {
  adminPath,
  AGENTS_PATH,
  libraryPath,
  schedulesPath,
  trackerPath,
  type AdminSection,
} from '@/lib/shell-route';
import { useShellActions } from './shell-actions';

export type ThreadNoticeProps =
  | {
      variant: 'not-found' | 'load-error' | 'deleted';
      /** «Повторить»; shown for `load-error` only. */
      onRetry?: () => void;
      onNewChat: () => void;
    }
  /** The side chat's tab (improvements IM-06): the reason alone, and «Повторить» for a failed read. */
  | { variant: 'aside-not-found' }
  | { variant: 'aside-load-error'; onRetry: () => void }
  /** MC-15: the agent page of a foreign, deleted or missing agent. */
  | { variant: 'agent-not-found' }
  /** MC-16: the agent page could not be read. */
  | { variant: 'agent-load-error'; onRetry: () => void }
  /** AD-02 (MC-19): a panel address opened without the administrator right. */
  | { variant: 'no-access' }
  /** AD-15 (MC-34): a panel record that does not exist; «К списку» opens its section's list. */
  | { variant: 'record-not-found'; section: AdminSection }
  /**
   * RV-02 (MC-6): a library record page the API answered 404. One screen for a foreign personal, closed,
   * deleted and missing record, naming nothing of the record (ADR-0016).
   */
  | { variant: 'library-not-found' }
  /** RV-01 «Ошибка» (MC-6): a library record page could not be read. */
  | { variant: 'library-load-error'; onRetry: () => void }
  /** schedules SH-08 (MC-13): a foreign, deleted or missing schedule. */
  | { variant: 'schedule-not-found' }
  /** schedules SH-05 «Error» (MC-8): the schedule page could not be read. */
  | { variant: 'schedule-load-error'; onRetry: () => void }
  /** task-tracker TT-12 (MC-14): a foreign, deleted or missing task. */
  | { variant: 'task-not-found' }
  /** task-tracker TT-08 «Error» (MC-6): the task could not be read. */
  | { variant: 'task-load-error'; onRetry: () => void };

type ScreenVariant = Exclude<ThreadNoticeProps['variant'], 'deleted'>;

/** The `shell.notice` entry of each variant: its title and description. */
const COPY = {
  'not-found': 'notFound',
  'load-error': 'loadError',
  deleted: 'deleted',
  'aside-not-found': 'notFound',
  'aside-load-error': 'loadError',
  'agent-not-found': 'agentNotFound',
  'agent-load-error': 'agentLoadError',
  'no-access': 'noAccess',
  'record-not-found': 'recordNotFound',
  'library-not-found': 'libraryNotFound',
  'library-load-error': 'libraryLoadError',
  'schedule-not-found': 'scheduleNotFound',
  'schedule-load-error': 'scheduleLoadError',
  'task-not-found': 'taskNotFound',
  'task-load-error': 'taskLoadError',
} as const satisfies Record<ThreadNoticeProps['variant'], string>;

/**
 * TH-06 / TH-07 replace the feed: the same screen for a foreign, missing or deleted thread (AC-14.2), with focus on its h1.
 * The agent page shows the same screen with MC-15 and MC-16 (UXRD Screen 3), the panel with MC-19 and MC-34,
 * a library record page with MC-6 (RV-02 and its load error), a schedule page with schedules MC-13 and MC-8, a tracker task with task-tracker MC-14 and MC-6.
 * `deleted` (E-8, TH-07 «Deleted while open») is the inline notice the feed shows in place of the TH-08 block.
 */
export function ThreadNotice(props: ThreadNoticeProps) {
  const t = useTranslations('shell');
  switch (props.variant) {
    case 'deleted':
      return <DeletedInlineNotice onNewChat={props.onNewChat} />;
    case 'agent-not-found':
      return (
        <NoticeScreen variant={props.variant}>
          <Link
            href={AGENTS_PATH}
            className={buttonVariants({ className: 'pointer-coarse:h-11' })}
          >
            {t('notice.toAgents')}
          </Link>
        </NoticeScreen>
      );
    case 'aside-not-found':
      return <NoticeScreen variant={props.variant}>{null}</NoticeScreen>;
    case 'aside-load-error':
    case 'agent-load-error':
      return (
        <NoticeScreen variant={props.variant}>
          <Button className="pointer-coarse:h-11" onClick={props.onRetry}>
            {t('notice.retry')}
          </Button>
        </NoticeScreen>
      );
    case 'no-access':
      return (
        <NoticeScreen variant={props.variant} Icon={ShieldOffIcon}>
          <Link
            href="/"
            className={buttonVariants({ className: 'pointer-coarse:h-11' })}
          >
            {t('notice.toChat')}
          </Link>
        </NoticeScreen>
      );
    case 'record-not-found':
      return (
        <NoticeScreen variant={props.variant} Icon={SearchXIcon}>
          <Link
            href={adminPath(props.section)}
            className={buttonVariants({ className: 'pointer-coarse:h-11' })}
          >
            {t('notice.toList')}
          </Link>
        </NoticeScreen>
      );
    case 'library-not-found':
      return (
        <NoticeScreen
          variant={props.variant}
          Icon={SearchXIcon}
          tab={pageTitle(t('notice.libraryNotFound.title'))}
        >
          <Link
            href={libraryPath()}
            className={buttonVariants({ className: 'pointer-coarse:h-11' })}
          >
            {t('notice.toLibrary')}
          </Link>
        </NoticeScreen>
      );
    case 'schedule-not-found':
      return (
        <NoticeScreen
          variant={props.variant}
          Icon={SearchXIcon}
          tab={pageTitle(t('notice.scheduleNotFound.title'))}
        >
          <Link
            href={schedulesPath()}
            className={buttonVariants({ className: 'pointer-coarse:h-11' })}
          >
            {t('notice.toSchedules')}
          </Link>
        </NoticeScreen>
      );
    case 'task-not-found':
      return (
        <NoticeScreen
          variant={props.variant}
          Icon={SearchXIcon}
          tab={pageTitle(t('notice.taskNotFound.title'))}
        >
          <Link
            href={trackerPath()}
            className={buttonVariants({ className: 'pointer-coarse:h-11' })}
          >
            {t('notice.toTasks')}
          </Link>
        </NoticeScreen>
      );
    case 'library-load-error':
    case 'schedule-load-error':
    case 'task-load-error':
      return (
        <NoticeScreen variant={props.variant}>
          <Button className="pointer-coarse:h-11" onClick={props.onRetry}>
            {t('notice.retry')}
          </Button>
        </NoticeScreen>
      );
    case 'not-found':
    case 'load-error': {
      const canRetry =
        props.variant === 'load-error' && props.onRetry !== undefined;
      return (
        <NoticeScreen variant={props.variant}>
          {canRetry && (
            <Button onClick={props.onRetry}>{t('notice.retry')}</Button>
          )}
          <Button
            variant={canRetry ? 'outline' : 'default'}
            onClick={props.onNewChat}
          >
            <SquarePenIcon aria-hidden />
            {t('sidebar.newChat')}
          </Button>
        </NoticeScreen>
      );
    }
  }
}

type NoticeScreenProps = {
  variant: ScreenVariant;
  /** 24 px above the heading (the panel's AD-02, AD-15). */
  Icon?: LucideIcon;
  /** The tab title, where the screen owns the tab (RV-02 «Не найдено — Agent OS»); others leave it to the shell. */
  tab?: string;
  children: ReactNode;
};

/** The full-area notice: its h1 takes focus (tabIndex −1), its actions sit under the reason. */
function NoticeScreen({ variant, Icon, tab, children }: NoticeScreenProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const t = useTranslations('shell.notice');
  useDocumentTitle(tab);

  useEffect(() => {
    headingRef.current?.focus();
  }, [variant]);

  return (
    <section
      aria-labelledby={headingId}
      className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center"
    >
      {Icon !== undefined && (
        <Icon aria-hidden className="mb-2 size-6 text-muted-foreground" />
      )}
      <h1
        ref={headingRef}
        id={headingId}
        tabIndex={-1}
        className="text-xl font-semibold outline-none"
      >
        {t(`${COPY[variant]}.title`)}
      </h1>
      <p className="text-muted-foreground text-sm">
        {t(`${COPY[variant]}.description`)}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div>
    </section>
  );
}

/**
 * E-8: h2 (the header keeps the page h1), the reason in an alert announced once, «Новый чат» described by it.
 * The composer is hidden while this shows; when focus was in it, focus falls back to <body> and moves to «Новый чат» (UXRD 7.4).
 */
function DeletedInlineNotice({ onNewChat }: { onNewChat: () => void }) {
  const headingId = useId();
  const reasonId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const t = useTranslations('shell');

  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) buttonRef.current?.focus();
  }, []);

  return (
    <section
      aria-labelledby={headingId}
      className="border-border bg-background mt-2 flex flex-col items-start gap-1 rounded-md border p-3 text-sm"
    >
      <h2 id={headingId} className="text-foreground font-medium">
        {t('notice.deleted.title')}
      </h2>
      <p id={reasonId} role="alert" className="text-muted-foreground">
        {t('notice.deleted.description')}
      </p>
      <Button
        ref={buttonRef}
        size="sm"
        className="mt-2 pointer-coarse:h-11"
        aria-describedby={reasonId}
        onClick={onNewChat}
      >
        <SquarePenIcon aria-hidden />
        {t('sidebar.newChat')}
      </Button>
    </section>
  );
}

/** Slot `ThreadComponents.DeletedNotice`: the E-8 notice wired to the shell's «Новый чат». */
export function DeletedNotice() {
  const { newChat } = useShellActions();
  return <ThreadNotice variant="deleted" onNewChat={newChat} />;
}
