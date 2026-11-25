'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { SquareIcon } from 'lucide-react';
import type { TestRunSummary } from '@agent-os/contracts';
import { useTakeAgent } from '@/components/agents/decision-card';
import { useShellServices } from '@/components/shell/shell-actions';
import { Button } from '@/components/ui/button';
import { useFeed, useFeedSelector } from '@/lib/feed/feed-context';
import { focusShellTarget } from '@/lib/focus';
import { describeLibraryError } from '@/lib/library/library-errors';

/**
 * The footer of a test run's conversation (KD-3, CT-03, CT-09, MC-4), from `training.run` alone: the composer while
 * the conversation takes a message, otherwise the line of `closedReason` — «Стоп» while the trainer works, the end of
 * the check, or the agent chosen instead. Focus that was in the field moves to «Стоп» when the line replaces it, and back to the field when the composer returns.
 */
export function TestRunFooter({
  run,
  composer,
}: {
  run: TestRunSummary;
  composer: ReactNode;
}) {
  const t = useTranslations('chat.testRun');
  const tStop = useTranslations('chat.training');
  const tStatus = useTranslations('agents.trainingStatus');
  const tErrors = useTranslations('errors');
  const { announcer } = useShellServices();
  const feed = useFeed();
  const take = useTakeAgent();
  const forked = useFeedSelector(
    (state) =>
      state.view?.kind === 'thread' && state.view.thread.forkedFrom !== null,
    false,
  );
  const [failure, setFailure] = useState<ReactNode>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(run.canSend);
  const phase = useRef(run.phase);

  const endWords = tStatus(
    run.capped
      ? 'capped'
      : run.status === 'failed'
        ? 'failedNoReason'
        : 'stopped',
  );

  // «Проверка закончена: {статус}» once, when the phase becomes the end during this visit.
  useEffect(() => {
    const was = phase.current;
    phase.current = run.phase;
    if (was !== 'ended' && run.phase === 'ended')
      announcer
        .getState()
        .announce('chat.testRun.endedAnnouncement', { status: endWords });
  }, [run.phase, endWords, announcer]);

  useLayoutEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = run.canSend;
    // The removed field or «Стоп» leaves focus on <body>; focus elsewhere stays where it is.
    if (was === run.canSend || document.activeElement !== document.body) return;
    if (run.canSend) focusShellTarget('composer');
    else stopRef.current?.focus();
  }, [run.canSend]);

  if (run.canSend || run.closedReason === null) return composer;

  const stop = (): void => {
    setFailure(null);
    // `command` has logged the refusal.
    void feed?.stop().catch(() => setFailure(t('stopFailed')));
  };
  const openTaken = (): void => {
    setFailure(null);
    take().catch((error: unknown) =>
      setFailure(describeLibraryError(tErrors, error, { where: 'take' }).text),
    );
  };

  const reason = run.closedReason;
  return (
    <div className="flex flex-col gap-1 px-2">
      <div className="text-muted-foreground flex min-h-9 items-center justify-between gap-2 text-sm leading-5">
        {reason === 'working' ? (
          <p className="min-w-0">{t('working')}</p>
        ) : reason === 'taken' ? (
          <p className="min-w-0">
            {t('taken', { name: run.taken?.name ?? '' })}{' '}
            <button
              type="button"
              onClick={openTaken}
              className="text-foreground focus-visible:ring-ring rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2"
            >
              {t('takenLink', { fork: forked ? 'yes' : 'no' })}
            </button>
          </p>
        ) : (
          <p className="min-w-0">
            {t('closed', {
              status: tStatus(reason === 'failed' ? 'failedNoReason' : reason),
            })}
          </p>
        )}
        {reason === 'working' && (
          <Button ref={stopRef} variant="outline" size="sm" onClick={stop}>
            <SquareIcon aria-hidden />
            {tStop('stop')}
          </Button>
        )}
      </div>
      {failure !== null && (
        <p role="alert" className="text-destructive text-xs leading-4">
          {failure}
        </p>
      )}
    </div>
  );
}
