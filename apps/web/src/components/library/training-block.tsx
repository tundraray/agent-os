'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { CAPTION, FormError } from '@/components/admin/admin-form';
import { TrainingStatusLabel } from '@/components/agents/agent-status';
import { useShellServices } from '@/components/shell/shell-actions';
import { ShellLink } from '@/components/shell/shell-link';
import { Button } from '@/components/ui/button';
import { useResource } from '@/hooks/use-resource';
import { formatListTime } from '@/i18n/formats';
import { describeApiError } from '@/lib/api/api-request';
import { libraryApi } from '@/lib/library/library-api';
import { describeLibraryError } from '@/lib/library/library-errors';
import { logger } from '@/lib/logger';
import { threadPath } from '@/lib/shell-route';
import { cn } from 'cn';

const LINK =
  'text-primary w-fit text-sm leading-5 font-medium underline-offset-4 hover:underline pointer-coarse:min-h-11';

/** Starts a training of the record and opens its conversation; a refusal shows its text and calls `onRefused`. */
export function useStartTraining(id: string, onRefused?: () => void) {
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ReactNode>(null);

  async function train(): Promise<void> {
    setStarting(true);
    setStartError(null);
    try {
      const started = await libraryApi.startTraining(id);
      router.push(threadPath(started.trainingId));
    } catch (cause) {
      logger.warn('library: training start refused', {
        recordId: id,
        failure: describeApiError(cause),
      });
      setStartError(
        describeLibraryError(tErrors, cause, { where: 'train' }).text,
      );
      setStarting(false);
      onRefused?.();
    }
  }

  return { starting, startError, train };
}

/**
 * UXRD SL-01 parts 2–4, «Обучение»: the training state is read on open (KD-1), and nothing shows without
 * `canTrain` or after a failed read (logged by `useResource`). `selfLearning` is the host's switch; `null` — a
 * host without one: the flag comes from the state, with its MC-1 line.
 */
export function TrainingBlock({
  id,
  selfLearning,
}: {
  id: string;
  selfLearning: boolean | null;
}) {
  const t = useTranslations('library');
  const format = useFormatter();
  const state = useResource(
    () => libraryApi.trainingState(id),
    `training-state:${id}`,
    'library',
  );
  const { starting, startError, train } = useStartTraining(id, state.reload);
  const { workspace } = useShellServices();
  // The training's conversation opens with its tab shown (KD-7); only its starter can open it.
  const showRun = (): void =>
    workspace.show({ tab: 'run', focusHeading: false });

  if (state.data === undefined || !state.data.canTrain) return null;
  const { running, lastFinished, capUsd } = state.data;
  const on = selfLearning ?? state.data.selfLearning;
  const usd = (value: number) => format.number(value, 'usd');

  return (
    <div className="flex flex-col gap-1.5">
      {selfLearning === null && (
        <p className="text-foreground text-sm leading-5">
          {t(on ? 'selfLearning.on' : 'selfLearning.off')}
        </p>
      )}
      {on && (
        <>
          {running === null ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                disabled={starting}
                onClick={() => void train()}
              >
                {t('training.train')}
              </Button>
              <span className={cn(CAPTION, 'text-muted-foreground')}>
                {t('training.willSpend', { cap: usd(capUsd) })}
              </span>
            </div>
          ) : (
            <>
              <p className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs leading-4">
                <TrainingStatusLabel
                  status="running"
                  capped={false}
                  reason={null}
                />
                {`· ${t('training.spent', { spent: usd(running.spentUsd), cap: usd(running.capUsd) })}`}
              </p>
              {running.startedByMe && (
                <ShellLink
                  href={threadPath(running.id)}
                  onNavigate={showRun}
                  className={LINK}
                >
                  {t('training.openConversation')}
                </ShellLink>
              )}
            </>
          )}
          {startError !== null && <FormError>{startError}</FormError>}
          {lastFinished !== null && (
            <>
              <p className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs leading-4">
                {t('training.last', {
                  at: formatListTime(format, lastFinished.finishedAt),
                })}
                <TrainingStatusLabel
                  status={lastFinished.status}
                  capped={false}
                  reason={null}
                />
                {lastFinished.recommended !== null &&
                  t(
                    lastFinished.recommended
                      ? 'training.lastRecommended'
                      : 'training.lastNotRecommended',
                  )}
              </p>
              <ShellLink
                href={threadPath(lastFinished.id)}
                onNavigate={showRun}
                className={LINK}
              >
                {t('training.openResult')}
              </ShellLink>
            </>
          )}
        </>
      )}
    </div>
  );
}
