'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { Script, TrainingView, Verdict } from '@agent-os/contracts';
import { FormError } from '@/components/admin/admin-form';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import {
  TaskStatusGlyph,
  TrainingStatusLabel,
} from '@/components/agents/agent-status';
import { useReloadOnTree } from '@/components/agents/session-task-list';
import { PageHeader } from '@/components/shell/page-header';
import { ShellLink } from '@/components/shell/shell-link';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { Button, buttonVariants } from '@/components/ui/button';
import { useResource } from '@/hooks/use-resource';
import { formatListTime } from '@/i18n/formats';
import { describeApiError } from '@/lib/api/api-request';
import { focusShellTarget } from '@/lib/focus';
import { libraryApi } from '@/lib/library/library-api';
import {
  describeLibraryError,
  isHiddenFromViewer,
} from '@/lib/library/library-errors';
import { logger } from '@/lib/logger';
import { libraryPath, recordPath, threadPath } from '@/lib/shell-route';
import { AgentScriptChange } from './agent-script-change';
import { RecordSkeleton } from './record-page';
import { useStartTraining } from './training-block';
import { Comparison, HEADING } from './training-comparison';

const OUTLINE_SM = buttonVariants({
  variant: 'outline',
  size: 'sm',
  className: 'pointer-coarse:h-11',
});

/**
 * UXRD TR-02: a training's result, read on open (read-on-open); the starter's screen reads it again on every
 * `tree` note of the training's conversation, whose id is the training's (KD-2). A 404 or 403 is «Не найдено».
 */
export function TrainingPage({
  id,
  trainingId,
}: {
  id: string;
  trainingId: string;
}) {
  const t = useTranslations('library.training');
  const format = useFormatter();
  const view = useResource(
    () => libraryApi.training(id, trainingId),
    `training:${id}:${trainingId}`,
    'library',
  );
  useReloadOnTree(
    view.data?.startedByMe === true ? trainingId : null,
    view.reload,
  );

  if (isHiddenFromViewer(view.error))
    return <ThreadNotice variant="library-not-found" />;
  if (view.status === 'error') {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <p className="text-foreground text-sm leading-5">{t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={view.reload}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (view.data === undefined) return <RecordSkeleton />;

  const data = view.data;
  return (
    <div className="h-full overflow-y-auto">
      <TrainingHeader id={id} trainingId={trainingId} view={data} />
      <div className="mx-auto flex w-full max-w-(--thread-max-width) min-w-0 flex-col gap-6 px-4 py-4 md:py-6">
        <p className="text-muted-foreground text-sm leading-5">
          {t('startedBy', {
            name: data.startedBy,
            at: formatListTime(format, data.startedAt),
            version: data.baseVersion,
          })}
        </p>
        <Summary
          id={id}
          trainingId={trainingId}
          view={data}
          reload={view.reload}
        />
        {!data.startedByMe && (
          <p className="text-muted-foreground text-sm leading-5">
            {t('textsHidden')}
          </p>
        )}
        <Changes view={data} />
        <Comparison view={data} />
      </div>
    </div>
  );
}

function TrainingHeader({
  id,
  trainingId,
  view,
}: {
  id: string;
  trainingId: string;
  view: TrainingView;
}) {
  const t = useTranslations('library');
  useEffect(() => {
    focusShellTarget('page-title');
  }, [trainingId]);
  return (
    <PageHeader
      title={t('training.title', { name: view.agent.name })}
      parent={{ title: t('screen.title'), href: libraryPath() }}
    >
      {view.startedByMe && (
        <ShellLink href={threadPath(trainingId)} className={OUTLINE_SM}>
          {t('training.openConversation')}
        </ShellLink>
      )}
      <ShellLink href={recordPath(id)} className={OUTLINE_SM}>
        {t('memory.openDeepAgent')}
      </ShellLink>
    </PageHeader>
  );
}

/** Part 1 «Итог»: status and spend, the recommendation, the buttons and the training's course. */
function Summary({
  id,
  trainingId,
  view,
  reload,
}: {
  id: string;
  trainingId: string;
  view: TrainingView;
  reload: () => void;
}) {
  const t = useTranslations('library.training');
  const tErrors = useTranslations('errors');
  const format = useFormatter();
  const tTaskStatus = useTranslations('agents.taskStatus');
  const [confirming, setConfirming] = useState(false);
  const { starting, startError, train } = useStartTraining(id);
  const usd = (value: number) => format.number(value, 'usd');
  const count = (verdict: Verdict) =>
    view.comparisons.filter((element) => element.verdict === verdict).length;
  const version = view.proposal.version;

  async function activate(): Promise<void> {
    try {
      const activated = await libraryApi.activateTraining(id, trainingId);
      toast.success(t('activated', { version: activated.version }));
    } catch (cause) {
      logger.warn('library: training activation refused', {
        recordId: id,
        trainingId,
        failure: describeApiError(cause),
      });
      throw cause;
    } finally {
      reload();
    }
  }

  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4">
      <p className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs leading-4">
        <TrainingStatusLabel
          status={view.status}
          capped={view.cappedAt !== null}
          reason={view.failureReason}
        />
        {`· ${t('spent', { spent: usd(view.spentUsd), cap: usd(view.capUsd) })}`}
      </p>
      {view.status === 'done' && version === null && (
        <p className="text-foreground text-sm leading-5 whitespace-pre-wrap">
          {view.proposal.explanation === null
            ? t('nothingToImproveHidden')
            : t('nothingToImprove', { explanation: view.proposal.explanation })}
        </p>
      )}
      {view.recommended !== null && (
        <p className="text-foreground text-sm leading-5">
          {t(view.recommended ? 'recommended' : 'notRecommended', {
            wins: count('proposed_better'),
            losses: count('base_better'),
            equal: count('equal'),
          })}
        </p>
      )}
      {view.activatedAt !== null && (
        <p className="text-muted-foreground text-xs leading-4">
          {t('activeSince', { at: formatListTime(format, view.activatedAt) })}
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
      <ul
        aria-label={t('progress')}
        className="divide-border flex flex-col divide-y"
      >
        {view.pool.map((task) => {
          const unfinished =
            view.status !== 'running' && task.status === 'in_progress';
          return (
            <li key={task.number} className="flex items-start gap-2 py-1.5">
              <TaskStatusGlyph
                status={task.status}
                ended={view.status !== 'running'}
              />
              <span className="text-muted-foreground font-mono text-xs leading-5 tabular-nums">
                {task.number}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-foreground text-sm leading-5 break-words">
                  {task.subject}
                </span>
                <span className="text-muted-foreground text-xs leading-5">
                  {tTaskStatus(unfinished ? 'unfinished' : task.status)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
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
    </section>
  );
}

/** Part 2 «Что меняет версия»: the prompts in two columns as they are, then the changed scripts, then «Почему». */
function Changes({ view }: { view: TrainingView }) {
  const t = useTranslations('library');
  const { version, base, proposed, changes } = view.proposal;
  if (version === null || base === null || proposed === null) return null;

  const subagents = [
    ...new Set([...base.subagents, ...proposed.subagents].map((s) => s.name)),
  ]
    .map((name) => ({
      name,
      before: base.subagents.find((s) => s.name === name)?.prompt ?? '',
      after: proposed.subagents.find((s) => s.name === name)?.prompt ?? '',
    }))
    .filter((subagent) => subagent.before !== subagent.after);
  const scripts = [
    ...new Set([...base.scripts, ...proposed.scripts].map((s) => s.name)),
  ]
    .map((name) => ({
      name,
      before: base.scripts.find((s) => s.name === name) ?? null,
      after: proposed.scripts.find((s) => s.name === name) ?? null,
    }))
    .filter(({ before, after }) => !sameScript(before, after));

  return (
    <section className="flex flex-col gap-3">
      <h2 className={HEADING}>{t('training.changes', { version })}</h2>
      <PromptColumns
        title={t('training.agentPrompt')}
        before={base.prompt}
        after={proposed.prompt}
      />
      {subagents.map((subagent) => (
        <PromptColumns
          key={subagent.name}
          title={t('training.subagentPrompt', { name: subagent.name })}
          before={subagent.before}
          after={subagent.after}
        />
      ))}
      {scripts.length > 0 && (
        <div className="divide-border flex flex-col divide-y">
          {scripts.map((script) => (
            <AgentScriptChange
              key={script.name}
              before={script.before}
              after={script.after}
            />
          ))}
        </div>
      )}
      {changes !== null && (
        <div className="flex flex-col gap-1">
          <h3 className="text-foreground text-sm leading-5 font-medium">
            {t('training.why')}
          </h3>
          <p className="text-foreground text-sm leading-5 whitespace-pre-wrap">
            {changes}
          </p>
        </div>
      )}
    </section>
  );
}

const sameScript = (before: Script | null, after: Script | null): boolean =>
  JSON.stringify(before) === JSON.stringify(after);

function PromptColumns({
  title,
  before,
  after,
}: {
  title: string;
  before: string;
  after: string;
}) {
  const t = useTranslations('library.scripts.change');
  const column = (label: string, text: string) => (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <p className="text-muted-foreground text-xs leading-4">{label}</p>
      <p className="text-foreground text-sm leading-5 break-words whitespace-pre-wrap">
        {text}
      </p>
    </div>
  );
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-foreground text-sm leading-5 font-medium">{title}</h3>
      <div className="flex flex-col gap-3 md:flex-row">
        {column(t('before'), before)}
        {column(t('after'), after)}
      </div>
    </div>
  );
}
