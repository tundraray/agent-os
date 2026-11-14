'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { SquarePenIcon } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { AGENTS_PATH } from '@/lib/shell-route';
import { useShellActions } from './shell-actions';

export type ThreadNoticeProps =
  | {
      variant: 'not-found' | 'load-error' | 'deleted';
      /** «Повторить»; shown for `load-error` only. */
      onRetry?: () => void;
      onNewChat: () => void;
    }
  /** MC-15: the agent page of a foreign, deleted or missing agent. */
  | { variant: 'agent-not-found' }
  /** MC-16: the agent page could not be read. */
  | { variant: 'agent-load-error'; onRetry: () => void };

type ScreenVariant = Exclude<ThreadNoticeProps['variant'], 'deleted'>;

const COPY = {
  'not-found': {
    title: 'Беседа не найдена',
    description: 'Возможно, её удалили или ссылка указана неверно.',
  },
  'load-error': {
    title: 'Не удалось загрузить беседу',
    description: 'Проверьте подключение и попробуйте ещё раз.',
  },
  deleted: {
    title: 'Беседа удалена',
    description: 'Её удалили в другой вкладке или окне.',
  },
  'agent-not-found': {
    title: 'Агент не найден',
    description: 'Возможно, его удалили вместе с беседой или ссылка указана неверно.',
  },
  'agent-load-error': {
    title: 'Не удалось загрузить агента',
    description: 'Проверьте подключение и попробуйте ещё раз.',
  },
} as const satisfies Record<ThreadNoticeProps['variant'], { title: string; description: string }>;

/**
 * TH-06 / TH-07 replace the feed: the same screen for a foreign, missing or deleted thread (AC-14.2), with focus on its h1.
 * The agent page shows the same screen with MC-15 and MC-16 (UXRD Screen 3).
 * `deleted` (E-8, TH-07 «Deleted while open») is the inline notice the feed shows in place of the TH-08 block.
 */
export function ThreadNotice(props: ThreadNoticeProps) {
  switch (props.variant) {
    case 'deleted':
      return <DeletedInlineNotice onNewChat={props.onNewChat} />;
    case 'agent-not-found':
      return (
        <NoticeScreen variant={props.variant}>
          <Link href={AGENTS_PATH} className={buttonVariants({ className: 'pointer-coarse:h-11' })}>
            К списку агентов
          </Link>
        </NoticeScreen>
      );
    case 'agent-load-error':
      return (
        <NoticeScreen variant={props.variant}>
          <Button className="pointer-coarse:h-11" onClick={props.onRetry}>
            Повторить
          </Button>
        </NoticeScreen>
      );
    case 'not-found':
    case 'load-error': {
      const canRetry = props.variant === 'load-error' && props.onRetry !== undefined;
      return (
        <NoticeScreen variant={props.variant}>
          {canRetry && <Button onClick={props.onRetry}>Повторить</Button>}
          <Button variant={canRetry ? 'outline' : 'default'} onClick={props.onNewChat}>
            <SquarePenIcon aria-hidden />
            Новый чат
          </Button>
        </NoticeScreen>
      );
    }
  }
}

/** The full-area notice: its h1 takes focus (tabIndex −1), its actions sit under the reason. */
function NoticeScreen({ variant, children }: { variant: ScreenVariant; children: ReactNode }) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { title, description } = COPY[variant];

  useEffect(() => {
    headingRef.current?.focus();
  }, [variant]);

  return (
    <section
      aria-labelledby={headingId}
      className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center"
    >
      <h1 ref={headingRef} id={headingId} tabIndex={-1} className="text-xl font-semibold outline-none">
        {title}
      </h1>
      <p className="text-muted-foreground text-sm">{description}</p>
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
  const { title, description } = COPY.deleted;

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
        {title}
      </h2>
      <p id={reasonId} role="alert" className="text-muted-foreground">
        {description}
      </p>
      <Button ref={buttonRef} size="sm" className="mt-2 pointer-coarse:h-11" aria-describedby={reasonId} onClick={onNewChat}>
        <SquarePenIcon aria-hidden />
        Новый чат
      </Button>
    </section>
  );
}

/** Slot `ThreadComponents.DeletedNotice`: the E-8 notice wired to the shell's «Новый чат». */
export function DeletedNotice() {
  const { newChat } = useShellActions();
  return <ThreadNotice variant="deleted" onNewChat={() => newChat('notice')} />;
}
