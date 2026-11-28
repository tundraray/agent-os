'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import {
  isStartableKind,
  type AgentNode,
  type AgentStatus as AgentStatusValue,
  type AgentView,
  type RecordKind,
  type RecordSummary,
  type RunOrigin,
  type DeepAgentRunView,
  type TrainingStatus,
} from '@agent-os/contracts';
import {
  ArrowUpRightIcon,
  BanIcon,
  CircleIcon,
  type LucideIcon,
} from 'lucide-react';
import { useStore } from 'zustand';
import {
  AgentStatus,
  TrainingStatusLabel,
} from '@/components/agents/agent-status';
import { useInChat } from '@/components/library/use-in-chat';
import { RecordLabel } from '@/components/library/record-label';
import { useShellServices } from '@/components/shell/shell-actions';
import { RunButton } from '@/components/shell/workspace-panel';
import { StateBadge } from '@/components/state-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { builtinName, builtinRoleName } from '@/i18n/builtin-name';
import { formatListTime } from '@/i18n/formats';
import { describeApiError } from '@/lib/api/api-request';
import { useFeedSelector } from '@/lib/feed/feed-context';
import {
  isDeepAgentRun,
  type RunCardPartData,
  type TestRunCardPartData,
} from '@/lib/feed/to-feed';
import {
  changedAfterRun,
  recipientNote,
  recordNamed,
} from '@/lib/library/record-rules';
import { logger } from '@/lib/logger';
import {
  NEW_THREAD_TARGET,
  type SeedTarget,
} from '@/lib/threads/composer-seed';
import { agentPath, parseShellRoute, recordPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';

const LINK_CLASS =
  'text-primary focus-visible:ring-ring inline-flex shrink-0 items-center gap-1 rounded-sm text-sm leading-5 outline-none hover:underline focus-visible:ring-2 pointer-coarse:h-11';

/** A run card is a focus target of the strip «Агенты беседы» (`data-agent-id`, `tabIndex` −1), ringed like a decision card. */
const FOCUS_TARGET_CLASS =
  'focus-visible:ring-ring outline-none focus-visible:ring-2';

/**
 * The library record a run goes by (RN-01–RN-03): its origin when the run is the record itself — an
 * agent or a deep agent. A subagent's run and a conversation's root have none of their own.
 */
export function runRecord(agent: Pick<AgentView, 'origin'>): RunOrigin | null {
  return agent.origin !== null && agent.origin.subagent === null
    ? agent.origin
    : null;
}

/** The live row of a record (KD-2): `undefined` — the library list is not read, `null` — not in it. */
export function useLiveRecord(
  recordId: string | null,
): RecordSummary | null | undefined {
  const { libraryIndex } = useShellServices();
  return useStore(libraryIndex, (state) => {
    if (state.records === null) return undefined;
    return recordId === null ? null : (state.records.get(recordId) ?? null);
  });
}

/**
 * The live row of the record a start call names (data-model design-agents.md, KD-5; `recordNamed`): `undefined`
 * — the list is not read, `null` — no such record, the call starts a temporary agent.
 */
export function useRecordNamed(
  kind: RecordKind,
  name: string,
): RecordSummary | null | undefined {
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  return recordNamed(records, kind, name);
}

/**
 * MC-17 «{Вид} изменён после запуска: сейчас версия {N}» (state «Сведения»), only when the live record
 * is newer than the run's start; never for an unavailable record or an unread list. `children` — the
 * action beside it (the run card's «Запустить заново»; the agent page has none).
 */
export function ChangedAfterRun({
  origin,
  live,
  children,
}: {
  origin: RunOrigin;
  live: RecordSummary | null | undefined;
  children?: ReactNode;
}) {
  const t = useTranslations('agents.run');
  if (live == null || !changedAfterRun(origin, live)) return null;
  return (
    <div
      data-slot="changed-after-run"
      className="flex min-w-0 flex-wrap items-center justify-between gap-2"
    >
      <StateBadge state="info">
        {t('changedAfterRun', { kind: origin.kind, version: live.version })}
      </StateBadge>
      {children}
    </div>
  );
}

/** The conversation the card stands in: the agent page's own one, or the open conversation of the route. */
export function useCardThread(): SeedTarget {
  const pageThread = useFeedSelector(
    (state) =>
      state.view?.kind === 'agent' ? state.view.agent.threadId : null,
    null,
  );
  const route = parseShellRoute(usePathname());
  if (pageThread !== null) return pageThread;
  return route.kind === 'chat' && route.threadId !== undefined
    ? route.threadId
    : NEW_THREAD_TARGET;
}

/**
 * Part 8 with «Запустить заново»: the record goes as a chip into this conversation's field; nothing starts before
 * sending. A training tree's conversation has neither: a re-run there would be paid outside the run and its cap.
 */
function RerunLine({ origin }: { origin: RunOrigin }) {
  const live = useLiveRecord(origin.recordId);
  const inChat = useInChat();
  const thread = useCardThread();
  const t = useTranslations('agents.run');
  const inTraining = useFeedSelector(
    (state) => state.view?.training != null,
    false,
  );
  if (inTraining) return null;
  return (
    <ChangedAfterRun origin={origin} live={live}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="pointer-coarse:h-11"
        onClick={() => {
          // A run's record is never a skill (agent-guidance KD-5).
          if (live == null) return;
          const { id, kind, name } = live;
          if (!isStartableKind(kind)) return;
          inChat({ record: { id, kind, name } }, thread);
        }}
      >
        {t('rerun')}
      </Button>
    </ChangedAfterRun>
  );
}

/**
 * Part 7, MC-17: the first run of a colleague's record in the recipient's conversation. The author is the
 * origin's; the roles are the viewer's roles the record is shared with. Text only.
 */
function RecipientLine({
  origin,
  firstRun,
}: {
  origin: RunOrigin;
  firstRun: boolean;
}) {
  const live = useLiveRecord(origin.recordId);
  const t = useTranslations('agents.run');
  const locale = useLocale();
  const note = recipientNote(live, firstRun);
  if (note === null || origin.author === null) return null;
  const roles = note.roles.map((name) => builtinRoleName(name, locale));
  return (
    <p className="text-muted-foreground line-clamp-3 text-xs leading-4 font-medium">
      {t('recipient', {
        author: origin.author.name,
        count: roles.length,
        roles: roles.join(', '),
      })}
    </p>
  );
}

export type RunCardProps = {
  /** The started agent or deep agent with its subtree. */
  data: RunCardPartData;
};

function byCreation(a: AgentNode, b: AgentNode): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** The deep agent is done: the team's subagents it never called can be named (agent-run-card.md, «Не вызывался»). */
const RUN_ENDED: ReadonlySet<AgentStatusValue> = new Set([
  'completed',
  'failed',
  'stopped',
]);

/**
 * KD-7: the run's `DeepAgentRunView`, read when the card appears and again when the deep agent's status or
 * its number of children changes. `null` until the first answer and after a failed read: the steps then show
 * without the team's rows, and the failure goes to the log.
 */
function useDeepAgentRun(
  agentId: string,
  status: AgentStatusValue,
  children: number,
): DeepAgentRunView | null {
  const { apiClient } = useShellServices();
  const [run, setRun] = useState<DeepAgentRunView | null>(null);
  useEffect(() => {
    // An answer that arrives after a newer read started, or after the card left, is dropped.
    let current = true;
    apiClient.getRun(agentId).then(
      (view) => {
        if (current) setRun(view);
      },
      (error: unknown) => {
        logger.warn('deep agent run read failed', {
          ...describeApiError(error),
          agentId,
          status,
          children,
        });
        if (current) setRun(null);
      },
    );
    return () => {
      current = false;
    };
  }, [apiClient, agentId, status, children]);
  return run;
}

/** A row of the card's step list: a call of the deep agent, a call refused by the limit, a subagent never called. */
type RunRow =
  | { kind: 'step'; at: string; step: AgentNode }
  | { kind: 'refused'; at: string; subagent: string }
  | { kind: 'not_called'; subagent: string };

/** Steps and limit refusals in call order; after the end, the team's subagents without a step. */
function runRows(
  steps: readonly AgentNode[],
  run: DeepAgentRunView | null,
  ended: boolean,
): RunRow[] {
  const calls: RunRow[] = [
    ...steps.map((step): RunRow => ({
      kind: 'step',
      at: step.createdAt,
      step,
    })),
    ...(run?.limitRefusals ?? []).map((refusal): RunRow => ({
      kind: 'refused',
      ...refusal,
    })),
  ];
  const at = (row: RunRow): number =>
    row.kind === 'not_called' ? Infinity : Date.parse(row.at);
  // Array.prototype.sort is stable: a step and a refusal at the same moment keep steps first.
  calls.sort((a, b) => at(a) - at(b));
  if (run === null || !ended) return calls;
  // A step the feed already has but an earlier read did not counts as called as well.
  const called = new Set(
    [...run.steps, ...steps].flatMap((step) =>
      step.origin?.subagent == null ? [] : [step.origin.subagent],
    ),
  );
  const notCalled = run.team
    .filter((member) => !called.has(member.name))
    .map((member): RunRow => ({ kind: 'not_called', subagent: member.name }));
  return [...calls, ...notCalled];
}

/** Rows share the card's columns: status icon, subagent name (as wide as the longest, up to 160 px), text. */
const ROW_CLASS =
  'col-span-full grid h-7 grid-cols-subgrid items-center pointer-coarse:h-11';
const OPENS_CLASS =
  'overflow-hidden transition-[height] duration-(--duration-fast) starting:h-0 motion-reduce:transition-none';
const SUBAGENT_CLASS = 'min-w-0 truncate text-sm leading-5 font-medium';
const ROW_TEXT_CLASS =
  'text-muted-foreground min-w-0 truncate text-sm leading-5';

/** One agent the deep agent started: a 28 px link row; a row added after mount opens over 150 ms. */
function StepRow({ step, appeared }: { step: AgentNode; appeared: boolean }) {
  const t = useTranslations('agents');
  const subagent = step.origin?.subagent ?? null;
  return (
    <li className={cn(ROW_CLASS, appeared && OPENS_CLASS)}>
      <Link
        href={agentPath(step.agentId)}
        aria-label={t('run.stepLabel', {
          hasSubagent: subagent === null || subagent === '' ? 'no' : 'yes',
          subagent: subagent ?? '',
          description: step.description,
          status: t(`status.${step.status}`),
        })}
        title={step.description}
        className="hover:bg-accent focus-visible:ring-ring col-span-full grid h-full grid-cols-subgrid items-center rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <AgentStatus variant="icon" status={step.status} className="shrink-0" />
        <span className={SUBAGENT_CLASS}>{subagent}</span>
        <span className={ROW_TEXT_CLASS}>{step.description}</span>
      </Link>
    </li>
  );
}

/** A row without an agent behind it (MC-17): «предел вызовов исчерпан» or «не вызывался»; not a link. */
function MutedRow({
  Icon,
  subagent,
  note,
  opens,
}: {
  Icon: LucideIcon;
  subagent: string;
  note: string;
  opens: boolean;
}) {
  return (
    <li className={cn(ROW_CLASS, 'px-1', opens && OPENS_CLASS)}>
      <span className="sr-only">{`${subagent}, ${note}`}</span>
      <span
        aria-hidden
        className="inline-flex size-4 items-center justify-center"
      >
        <Icon className="text-muted-foreground size-3.5" />
      </span>
      <span aria-hidden className={cn(SUBAGENT_CLASS, 'text-muted-foreground')}>
        {subagent}
      </span>
      <span aria-hidden className={ROW_TEXT_CLASS}>
        {note}
      </span>
    </li>
  );
}

/**
 * The live run card of agent-run-card.md (UXRD CV-01, RN-01, MC-17): the «Глубокий агент» variant exactly when
 * the node is a deep agent's run, otherwise «Агент», two lines with the record label when the agent comes
 * from the library. Status changes recolour icons and labels only.
 */
export function RunCard({ data }: RunCardProps) {
  const format = useFormatter();
  const locale = useLocale();
  const t = useTranslations('agents');
  const statusLabel = t(`status.${data.status}`);
  const origin = runRecord(data);
  const record =
    origin === null ? null : { ...origin, name: builtinName(origin, locale) };
  const time = (
    <time
      dateTime={data.createdAt}
      className="text-muted-foreground shrink-0 text-xs leading-4 font-medium tabular-nums"
    >
      {formatListTime(format, data.createdAt)}
    </time>
  );
  if (!isDeepAgentRun(data) || record === null) {
    return (
      <div
        role="group"
        aria-label={t('run.label', {
          name: data.description,
          status: statusLabel,
        })}
        tabIndex={-1}
        data-slot="run-card"
        data-variant="agent"
        data-agent-id={data.agentId}
        className={cn(
          'bg-card text-card-foreground mx-auto flex w-full max-w-(--prose-max-width) min-w-0 flex-col gap-1 rounded-lg border px-3 py-2',
          FOCUS_TARGET_CLASS,
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <AgentStatus
            variant="label"
            status={data.status}
            className="shrink-0"
          />
          <span
            title={data.description}
            className="min-w-0 flex-1 truncate text-sm leading-5 font-medium"
          >
            {data.description}
          </span>
          {time}
          <Link
            href={agentPath(data.agentId)}
            aria-label={t('run.openLabel', { description: data.description })}
            className={LINK_CLASS}
          >
            {t('run.open')}
            <ArrowUpRightIcon aria-hidden className="size-3.5" />
          </Link>
        </div>
        {record !== null && (
          <>
            <RecordLabel
              origin={record}
              variant="under"
              href={recordPath(record.recordId)}
            />
            <RecipientLine origin={record} firstRun={data.firstRun} />
            <RerunLine origin={record} />
          </>
        )}
      </div>
    );
  }

  return <DeepAgentRunCard data={data} origin={record} time={time} />;
}

/**
 * The «Глубокий агент» variant (AC-27.1–AC-27.3): the header is the record label with the version the run
 * started on — the origin's, never the live one; the steps are the deep agent's children from the feed, named by
 * `origin.subagent`; limit refusals and, after the end, uncalled subagents come from `DeepAgentRunView`.
 */
function DeepAgentRunCard({
  data,
  origin,
  time,
}: {
  data: RunCardPartData;
  origin: RunOrigin;
  time: ReactNode;
}) {
  const briefQuestion = data.briefQuestion;
  // Rows present at first render (a reload, a re-read) do not animate; only steps added later open.
  const [initialStepIds] = useState(
    () => new Set(data.children.map((child) => child.agentId)),
  );
  const run = useDeepAgentRun(data.agentId, data.status, data.children.length);
  const rows = runRows(
    [...data.children].sort(byCreation),
    run,
    RUN_ENDED.has(data.status),
  );
  const t = useTranslations('agents');
  return (
    <div
      role="group"
      aria-label={t('run.label', {
        name: origin.name,
        status: t(`status.${data.status}`),
      })}
      tabIndex={-1}
      data-slot="run-card"
      data-variant="deep-agent"
      data-agent-id={data.agentId}
      className={cn(
        'bg-card text-card-foreground mx-auto flex w-full max-w-(--prose-max-width) min-w-0 flex-col gap-1 rounded-lg border p-3',
        FOCUS_TARGET_CLASS,
      )}
    >
      {/* Below 640 px the label takes its own line under the status and the time: the name a full line, the chips whole below it. */}
      <div className="flex min-w-0 items-center justify-between gap-3 max-sm:flex-wrap max-sm:gap-y-1 sm:h-6">
        <AgentStatus
          variant="label"
          status={data.status}
          className="shrink-0"
        />
        <RecordLabel
          origin={origin}
          variant="row"
          showVersion
          href={recordPath(origin.recordId)}
          className="min-w-0 flex-1 overflow-hidden max-sm:order-last max-sm:basis-full max-sm:*:whitespace-nowrap max-sm:[&>:first-child]:basis-full sm:flex-nowrap"
        />
        {time}
      </div>
      {briefQuestion !== undefined && (
        <p
          title={briefQuestion}
          className="text-muted-foreground truncate text-sm leading-5"
        >
          {briefQuestion}
        </p>
      )}
      <RecipientLine origin={origin} firstRun={data.firstRun} />
      {rows.length > 0 && (
        <ul className="grid grid-cols-[auto_fit-content(10rem)_minmax(0,1fr)] gap-x-2">
          {rows.map((row, index) =>
            row.kind === 'step' ? (
              <StepRow
                key={row.step.agentId}
                step={row.step}
                appeared={!initialStepIds.has(row.step.agentId)}
              />
            ) : row.kind === 'refused' ? (
              <MutedRow
                key={`refused-${row.subagent}-${row.at}-${index}`}
                Icon={BanIcon}
                subagent={row.subagent}
                note={t('run.limitReached')}
                opens={false}
              />
            ) : (
              <MutedRow
                key={`not-called-${row.subagent}`}
                Icon={CircleIcon}
                subagent={row.subagent}
                note={t('run.notCalled')}
                opens
              />
            ),
          )}
        </ul>
      )}
      <RerunLine origin={origin} />
      <Link
        href={agentPath(data.agentId)}
        className={cn(LINK_CLASS, 'self-start')}
      >
        {t('run.openRun')}
        <ArrowUpRightIcon aria-hidden className="size-3.5" />
      </Link>
    </div>
  );
}

/**
 * The «Проверка» variant (agent-run-card.md, CT-06, MC-14): the trainer's work on the agent from the conversation's
 * `training.run`. Only the last card shows the run's status and its step; an earlier one keeps its rounds' result.
 */
export function TestRunCard({ data }: { data: TestRunCardPartData }) {
  const format = useFormatter();
  const t = useTranslations('chat.testRun.card');
  const tAgents = useTranslations('agents');
  const run = useFeedSelector(
    (state) =>
      state.view?.kind === 'thread' ? (state.view.training?.run ?? null) : null,
    null,
  );
  if (run === null) return null;
  const status: TrainingStatus = !data.last
    ? 'done'
    : run.phase === 'working'
      ? 'running'
      : run.phase === 'ended'
        ? run.status
        : 'done';
  const name = run.agent?.name ?? '';
  const [fixRound] = data.rounds;
  const title =
    data.first || fixRound === undefined
      ? t('title', { named: run.agent === null ? 'no' : 'yes', name })
      : t('fixTitle', { fix: fixRound.number - 1, name });
  const statusWords = tAgents(
    status === 'failed'
      ? 'trainingStatus.failedNoReason'
      : status === 'stopped' && run.capped
        ? 'trainingStatus.capped'
        : `trainingStatus.${status}`,
  );
  return (
    <div
      role="group"
      aria-label={tAgents('run.label', { name: title, status: statusWords })}
      data-slot="run-card"
      data-variant="test-run"
      className="bg-card text-card-foreground mx-auto flex w-full max-w-(--prose-max-width) min-w-0 flex-col gap-1 rounded-lg border p-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0">
          <TrainingStatusLabel
            status={status}
            capped={run.capped}
            reason={null}
          />
        </span>
        <span
          title={title}
          className="min-w-0 flex-1 truncate text-sm leading-5 font-medium"
        >
          {title}
        </span>
        <time
          dateTime={data.createdAt}
          className="text-muted-foreground shrink-0 text-xs leading-4 font-medium tabular-nums"
        >
          {formatListTime(format, data.createdAt)}
        </time>
      </div>
      {status === 'running' && run.step !== null && (
        <p
          title={run.step}
          className="text-muted-foreground truncate text-sm leading-5"
        >
          {t('now', { task: run.step })}
        </p>
      )}
      {data.rounds.map(
        (round) =>
          round.passed !== null &&
          round.total !== null && (
            <p key={round.number} className="text-foreground text-sm leading-5">
              {round.number === 1
                ? t('firstRound', { passed: round.passed, total: round.total })
                : t('fixRound', {
                    fix: round.number - 1,
                    passed: round.passed,
                    total: round.total,
                  })}
            </p>
          ),
      )}
      {data.first && status !== 'running' && run.agent?.deleted !== true && (
        <p className="text-foreground text-sm leading-5">
          {t(run.agent === null ? 'notCreated' : 'inLibrary')}
        </p>
      )}
      <RunButton className={RUN_BUTTON} />
    </div>
  );
}

const RUN_BUTTON = buttonVariants({
  variant: 'outline',
  size: 'sm',
  className: 'mt-1 self-start pointer-coarse:h-11',
});
