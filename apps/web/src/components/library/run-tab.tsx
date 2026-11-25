'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type {
  ConversationTraining,
  TestRunView,
  TrainingView,
  Verdict,
} from '@agent-os/contracts';
import { FormError } from '@/components/admin/admin-form';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { TrainingStatusLabel } from '@/components/agents/agent-status';
import { useLiveRecord } from '@/components/agents/run-card';
import { useReloadOnTree } from '@/components/agents/session-task-list';
import { useConversationFeed } from '@/components/shell/main-view';
import { useShellServices } from '@/components/shell/shell-actions';
import { ShellLink } from '@/components/shell/shell-link';
import { Button } from '@/components/ui/button';
import { useResource, type Resource } from '@/hooks/use-resource';
import { describeApiError } from '@/lib/api/api-request';
import { libraryApi } from '@/lib/library/library-api';
import {
  describeLibraryError,
  isHiddenFromViewer,
} from '@/lib/library/library-errors';
import { logger } from '@/lib/logger';
import { recordPath } from '@/lib/shell-route';
import { DeleteRecordDialog } from './delete-record-dialog';
import { RecordSkeleton } from './record-page';
import { TestRunRounds } from './test-run-rounds';
import { useStartTraining } from './training-block';
import { Comparison } from './training-comparison';
import { PoolProgress, useUsdAmount, VersionChanges } from './training-parts';

const CAPTION = 'text-muted-foreground text-xs leading-4';
const TEXT = 'text-foreground text-sm leading-5 whitespace-pre-wrap';
const LINK =
  'text-primary w-fit text-sm leading-5 font-medium underline-offset-4 hover:underline pointer-coarse:min-h-11';

/**
 * The tab «Проверка» / «Обучение» of the run's own conversation (self-learning UXRD TR-02, create-and-test UXRD
 * CT-04; KD-6): one component — the line «когда и с чего», the summary and the read states are shared, the middle
 * block is the run's own. Read on open and again on every `tree` note of the conversation (read-on-open).
 */
export function RunTab({ run }: { run: NonNullable<ConversationTraining> }) {
  if (run.testRun)
    return <TestRunTab key={run.trainingId} testRunId={run.trainingId} />;
  if (run.agentId === null) return <NotFound />;
  return (
    <TrainingTab
      key={run.trainingId}
      agentId={run.agentId}
      trainingId={run.trainingId}
    />
  );
}

function useRunView<T>(
  load: () => Promise<T>,
  key: string,
  threadId: string,
): Resource<T> {
  const view = useResource(load, key, 'library');
  useReloadOnTree(view.data === undefined ? null : threadId, view.reload);
  return view;
}

/** «Не найдено» for anyone but the starter (FR-15), the error MC-13 with «Повторить», the skeleton, then the tab. */
function RunView<T>({
  view,
  children,
}: {
  view: Resource<T>;
  children: (data: T) => ReactNode;
}) {
  const t = useTranslations('library.training');
  if (isHiddenFromViewer(view.error)) return <NotFound />;
  if (view.status === 'error') {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <p className="text-foreground text-sm leading-5">{t('loadFailed')}</p>
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={view.reload}
        >
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (view.data === undefined) return <RecordSkeleton />;
  return <div className="flex flex-col gap-6">{children(view.data)}</div>;
}

function NotFound() {
  const t = useTranslations('shell.notice.libraryNotFound');
  return (
    <p className="text-muted-foreground py-6 text-center text-sm leading-5">
      {t('title')}
    </p>
  );
}

type RunState = Pick<
  TrainingView,
  'status' | 'cappedAt' | 'failureReason' | 'spentUsd' | 'capUsd' | 'pool'
>;

/** Part 1 «Итог»: status and spend, the run's own lines and buttons, then its course. */
function Summary({
  view,
  progress,
  children,
}: {
  view: RunState;
  progress: string;
  children: ReactNode;
}) {
  const t = useTranslations('library.training');
  const usd = useUsdAmount();
  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4">
      <p className={`${CAPTION} flex flex-wrap items-center gap-1`}>
        <TrainingStatusLabel
          status={view.status}
          capped={view.cappedAt !== null}
          reason={view.failureReason}
        />
        {`· ${t('spent', { spent: usd(view.spentUsd), cap: usd(view.capUsd) })}`}
      </p>
      {children}
      <PoolProgress
        pool={view.pool}
        ended={view.status !== 'running'}
        label={progress}
      />
    </section>
  );
}

function TrainingTab({
  agentId,
  trainingId,
}: {
  agentId: string;
  trainingId: string;
}) {
  const t = useTranslations('library');
  const format = useFormatter();
  const view = useRunView(
    () => libraryApi.training(agentId, trainingId),
    `training:${agentId}:${trainingId}`,
    trainingId,
  );
  return (
    <RunView view={view}>
      {(data) => (
        <>
          <div className="flex flex-col gap-1">
            <p className={CAPTION}>
              {t('training.started', {
                at: format.dateTime(new Date(data.startedAt), 'dayTime'),
                version: data.baseVersion,
              })}
            </p>
            <ShellLink href={recordPath(agentId)} className={LINK}>
              {t('memory.openDeepAgent')}
            </ShellLink>
          </div>
          <TrainingSummary
            agentId={agentId}
            trainingId={trainingId}
            view={data}
            reload={view.reload}
          />
          {data.proposal.version !== null && (
            <VersionChanges
              proposal={data.proposal}
              heading={t('training.changes', {
                version: data.proposal.version,
              })}
            />
          )}
          <Comparison view={data} />
        </>
      )}
    </RunView>
  );
}

function TrainingSummary({
  agentId,
  trainingId,
  view,
  reload,
}: {
  agentId: string;
  trainingId: string;
  view: TrainingView;
  reload: () => void;
}) {
  const t = useTranslations('library.training');
  const tErrors = useTranslations('errors');
  const format = useFormatter();
  const [confirming, setConfirming] = useState(false);
  const { starting, startError, train } = useStartTraining(agentId);
  const count = (verdict: Verdict) =>
    view.comparisons.filter((element) => element.verdict === verdict).length;
  const version = view.proposal.version;

  async function activate(): Promise<void> {
    try {
      const activated = await libraryApi.activateTraining(agentId, trainingId);
      toast.success(t('activated', { version: activated.version }));
    } catch (cause) {
      logger.warn('library: training activation refused', {
        recordId: agentId,
        trainingId,
        failure: describeApiError(cause),
      });
      throw cause;
    } finally {
      reload();
    }
  }

  return (
    <Summary view={view} progress={t('progress')}>
      {view.status === 'done' &&
        version === null &&
        view.proposal.explanation !== null && (
          <p className={TEXT}>
            {t('nothingToImprove', { explanation: view.proposal.explanation })}
          </p>
        )}
      {view.recommended !== null && (
        <p className={TEXT}>
          {t(view.recommended ? 'recommended' : 'notRecommended', {
            wins: count('proposed_better'),
            losses: count('base_better'),
            equal: count('equal'),
          })}
        </p>
      )}
      {view.activatedAt !== null && (
        <p className={CAPTION}>
          {t('activeSince', {
            at: format.dateTime(new Date(view.activatedAt), 'dayTime'),
          })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {view.canActivate && (
          <Button size="sm" onClick={() => setConfirming(true)}>
            {t('activate')}
          </Button>
        )}
        {(view.status === 'stopped' || view.status === 'failed') && (
          <Button
            variant="outline"
            size="sm"
            disabled={starting}
            onClick={() => void train()}
          >
            {t('retrain')}
          </Button>
        )}
      </div>
      {startError !== null && <FormError>{startError}</FormError>}
      {version !== null && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t('activateTitle', { version })}
          body={t('activateBody', { base: view.activeVersion })}
          confirmLabel={t('activate')}
          onConfirm={activate}
          refusalText={(cause) =>
            describeLibraryError(tErrors, cause, { where: 'activate' }).text
          }
        />
      )}
    </Summary>
  );
}

function TestRunTab({ testRunId }: { testRunId: string }) {
  const t = useTranslations('library.testRun');
  const format = useFormatter();
  const view = useRunView(
    () => libraryApi.testRun(testRunId),
    `test-run:${testRunId}`,
    testRunId,
  );
  return (
    <RunView view={view}>
      {(data) => (
        <>
          <p className={CAPTION}>
            {t('started', {
              at: format.dateTime(new Date(data.startedAt), 'dayTime'),
            })}
          </p>
          <TestRunSummary view={data} reload={view.reload} />
          {data.agent !== null && (
            <TestRunRounds view={data} agent={data.agent} />
          )}
        </>
      )}
    </RunView>
  );
}

/** A round counts in «Прошло…» once every test has its verdict in it, or once the run ended. */
const judgedRounds = (view: TestRunView): TestRunView['rounds'] =>
  view.rounds.filter(
    (_, index) =>
      view.phase === 'ended' ||
      view.tests.every((test) => test.rounds[index]?.verdict != null),
  );

/** The test run's summary (CT-04 part 1, CT-05): the passed lines, the library line, each fix's activation, delete. */
function TestRunSummary({
  view,
  reload,
}: {
  view: TestRunView;
  reload: () => void;
}) {
  const t = useTranslations('library.testRun');
  const tTraining = useTranslations('library.training');
  const tErrors = useTranslations('errors');
  const format = useFormatter();
  const { libraryIndex } = useShellServices();
  const feed = useConversationFeed();
  // The version «Сделать активной» was pressed for; it stays while the dialog closes.
  const [version, setVersion] = useState(2);
  const [activating, setActivating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { agent } = view;
  const live = useLiveRecord(agent?.id ?? null);
  // The delete dialog reads the agent's library row (KD-6); the list may not be read in a conversation yet.
  const missing = view.canDelete && live == null;
  useEffect(() => {
    if (missing) void libraryIndex.refresh();
  }, [missing, libraryIndex]);
  // After a delete or an activation the re-read removes the pressed button: focus goes to the tab «Проверка» (CT-05).
  const focusTab = useRef(false);
  useEffect(() => {
    if (!focusTab.current) return;
    focusTab.current = false;
    document.querySelector<HTMLElement>('[data-run-tab]')?.focus();
  }, [view]);
  const agentDeleted = agent?.deleted === true;

  const judged = judgedRounds(view);
  const [single] = judged;
  const fixes = agentDeleted
    ? []
    : view.rounds.filter(
        (round) =>
          round.version > 1 &&
          (round.canActivate ||
            (view.activatedAt !== null &&
              round.version === view.activeVersion)),
      );

  async function activate(chosen: number): Promise<void> {
    try {
      await libraryApi.activateTestRun(view.id, chosen);
      focusTab.current = true;
      toast.success(t('activated', { fix: chosen - 1 }));
    } catch (cause) {
      logger.warn('library: test run activation refused', {
        testRunId: view.id,
        version: chosen,
        failure: describeApiError(cause),
      });
      throw cause;
    } finally {
      reload();
    }
  }

  return (
    <Summary view={view} progress={t('progress')}>
      {judged.length === 1 && single !== undefined && (
        <p className={TEXT}>
          {t('passedOne', { passed: single.passed, total: single.total })}
        </p>
      )}
      {judged.length > 1 && (
        <p className={TEXT}>
          {t('passedRounds', {
            rounds: judged
              .map((round) =>
                t('roundPassed', {
                  fix: round.version - 1,
                  passed: round.passed,
                  total: round.total,
                }),
              )
              .join(', '),
          })}
        </p>
      )}
      {agent === null
        ? view.status !== 'running' && <p className={TEXT}>{t('notCreated')}</p>
        : view.status !== 'running' && (
            <p className={TEXT}>{t(agentDeleted ? 'deleted' : 'inLibrary')}</p>
          )}
      {view.fixSkipped === 'nothing_to_fix' && (
        <p className={TEXT}>
          {view.fixExplanation === null
            ? t('nothingToFixBare')
            : t('nothingToFix', { explanation: view.fixExplanation })}
        </p>
      )}
      {fixes.map((round) => (
        <div
          key={round.versionId}
          className="flex flex-wrap items-center gap-x-3 gap-y-1"
        >
          <span className="text-foreground text-sm leading-5">
            {t('round', { fix: round.version - 1 })}
          </span>
          {round.canActivate ? (
            <Button
              size="sm"
              className="pointer-coarse:h-11"
              aria-label={t('activateName', { fix: round.version - 1 })}
              onClick={() => {
                setVersion(round.version);
                setActivating(true);
              }}
            >
              {tTraining('activate')}
            </Button>
          ) : (
            view.activatedAt !== null && (
              <span className={CAPTION}>
                {tTraining('activeSince', {
                  at: format.dateTime(new Date(view.activatedAt), 'dayTime'),
                })}
              </span>
            )
          )}
        </div>
      ))}
      {view.canDelete && live != null && (
        <Button
          variant="outline"
          size="sm"
          className="self-start pointer-coarse:h-11"
          onClick={() => setDeleting(true)}
        >
          {t('delete')}
        </Button>
      )}
      <ConfirmDialog
        open={activating}
        onOpenChange={setActivating}
        title={t('activateTitle', { fix: version - 1 })}
        body={t('activateBody')}
        confirmLabel={tTraining('activate')}
        onConfirm={() => activate(version)}
        refusalText={(cause) =>
          describeLibraryError(tErrors, cause, { where: 'activate' }).text
        }
      />
      {live != null && (
        <DeleteRecordDialog
          record={live}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={() => {
            focusTab.current = true;
            reload();
            // The header's «Открыть агента» follows the conversation's view, which the delete does not re-read.
            void feed?.load();
          }}
        />
      )}
    </Summary>
  );
}
