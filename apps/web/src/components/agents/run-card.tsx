"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useFormatter, useLocale } from "next-intl";
import type {
  AgentNode,
  AgentStatus as AgentStatusValue,
  AgentView,
  RecordSummary,
  RunOrigin,
  WorkflowRunView,
} from "@agent-os/contracts";
import { ArrowUpRightIcon, BanIcon, CircleIcon, type LucideIcon } from "lucide-react";
import { useStore } from "zustand";
import { AgentStatus } from "@/components/agents/agent-status";
import { useInChat } from "@/components/library/use-in-chat";
import { RecordLabel } from "@/components/library/record-label";
import { useShellServices } from "@/components/shell/shell-actions";
import { StateBadge } from "@/components/state-badge";
import { Button } from "@/components/ui/button";
import { AGENT_STATUS_LABEL } from "@/lib/agents/format";
import { builtinName } from "@/lib/i18n/builtin-name";
import { formatListTime } from "@/lib/i18n/formats";
import { describeApiError } from "@/lib/api/api-request";
import { useFeedSelector } from "@/lib/feed/feed-context";
import { isWorkflowCoordinator, type RunCardPartData } from "@/lib/feed/to-feed";
import { kindWord } from "@/lib/library/library-errors";
import { changedAfterRun, recipientNote } from "@/lib/library/record-rules";
import { logger } from "@/lib/logger";
import { NEW_THREAD_TARGET, type SeedTarget } from "@/lib/threads/composer-seed";
import { agentPath, parseShellRoute, recordPath } from "@/lib/shell-route";
import { cn } from "@/lib/utils";

const LINK_CLASS =
  "text-primary focus-visible:ring-ring inline-flex shrink-0 items-center gap-1 rounded-sm text-sm leading-5 outline-none hover:underline focus-visible:ring-2 pointer-coarse:h-11";

/**
 * The library record a run goes by (RN-01–RN-03): its origin when the run is the record itself — an
 * agent or a workflow coordinator. A workflow step and a conversation's root have none of their own.
 */
export function runRecord(agent: Pick<AgentView, "origin">): RunOrigin | null {
  return agent.origin !== null && agent.origin.executor === null ? agent.origin : null;
}

/** The live row of a record (KD-2): `undefined` — the library list is not read, `null` — not in it. */
export function useLiveRecord(recordId: string | null): RecordSummary | null | undefined {
  const { libraryIndex } = useShellServices();
  return useStore(libraryIndex, (state) => {
    if (state.records === null) return undefined;
    return recordId === null ? null : (state.records.get(recordId) ?? null);
  });
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
  if (live == null || !changedAfterRun(origin, live)) return null;
  return (
    <div data-slot="changed-after-run" className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <StateBadge state="info">{`${kindWord(origin.kind, true)} изменён после запуска: сейчас версия ${live.version}`}</StateBadge>
      {children}
    </div>
  );
}

/** The conversation the card stands in: the agent page's own one, or the open conversation of the route. */
function useCardThread(): SeedTarget {
  const pageThread = useFeedSelector(
    (state) => (state.view?.kind === "agent" ? state.view.agent.threadId : null),
    null,
  );
  const route = parseShellRoute(usePathname());
  if (pageThread !== null) return pageThread;
  return route.kind === "chat" && route.threadId !== undefined ? route.threadId : NEW_THREAD_TARGET;
}

/** Part 8 with «Запустить заново»: the record goes as a chip into this conversation's field; nothing starts before sending. */
function RerunLine({ origin }: { origin: RunOrigin }) {
  const live = useLiveRecord(origin.recordId);
  const inChat = useInChat();
  const thread = useCardThread();
  return (
    <ChangedAfterRun origin={origin} live={live}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="pointer-coarse:h-11"
        onClick={() => {
          if (live == null) return;
          inChat({ record: { id: live.id, kind: live.kind, name: live.name } }, thread);
        }}
      >
        Запустить заново
      </Button>
    </ChangedAfterRun>
  );
}

/**
 * Part 7, MC-17: the first run of a colleague's record in the recipient's conversation. The author is the
 * origin's; the roles are the viewer's roles the record is shared with. Text only.
 */
function RecipientLine({ origin, firstRun }: { origin: RunOrigin; firstRun: boolean }) {
  const live = useLiveRecord(origin.recordId);
  const note = recipientNote(live, firstRun);
  if (note === null || origin.author === null) return null;
  const roles = note.roles.length > 0 ? ` · для роли ${note.roles.join(", ")}` : "";
  return (
    <p className="text-muted-foreground line-clamp-3 text-xs leading-4 font-medium">
      {`${origin.author.name}${roles}: работает с вашими правами и аккаунтами, изменения — только после вашего подтверждения. Убрать может автор или администратор.`}
    </p>
  );
}

export type RunCardProps = {
  /** The started agent or workflow coordinator with its subtree. */
  data: RunCardPartData;
};

function byCreation(a: AgentNode, b: AgentNode): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** The coordinator is done: the team's executors it never called can be named (agent-run-card.md, «Не вызывался»). */
const RUN_ENDED: ReadonlySet<AgentStatusValue> = new Set(["completed", "failed", "stopped"]);

/**
 * KD-7: the run's `WorkflowRunView`, read when the card appears and again when the coordinator's status or
 * its number of children changes. `null` until the first answer and after a failed read: the steps then show
 * without the team's rows, and the failure goes to the log.
 */
function useWorkflowRun(agentId: string, status: AgentStatusValue, children: number): WorkflowRunView | null {
  const { apiClient } = useShellServices();
  const [run, setRun] = useState<WorkflowRunView | null>(null);
  useEffect(() => {
    // An answer that arrives after a newer read started, or after the card left, is dropped.
    let current = true;
    apiClient.getRun(agentId).then(
      (view) => {
        if (current) setRun(view);
      },
      (error: unknown) => {
        logger.warn("workflow run read failed", { ...describeApiError(error), agentId, status, children });
        if (current) setRun(null);
      },
    );
    return () => {
      current = false;
    };
  }, [apiClient, agentId, status, children]);
  return run;
}

/** A row of the card's step list: a call of the coordinator, a call refused by the limit, an executor never called. */
type RunRow =
  | { kind: "step"; at: string; step: AgentNode }
  | { kind: "refused"; at: string; executor: string }
  | { kind: "not_called"; executor: string };

/** Steps and limit refusals in call order; after the end, the team's executors without a step. */
function runRows(steps: readonly AgentNode[], run: WorkflowRunView | null, ended: boolean): RunRow[] {
  const calls: RunRow[] = [
    ...steps.map((step): RunRow => ({ kind: "step", at: step.createdAt, step })),
    ...(run?.limitRefusals ?? []).map((refusal): RunRow => ({ kind: "refused", ...refusal })),
  ];
  const at = (row: RunRow): number => (row.kind === "not_called" ? Infinity : Date.parse(row.at));
  // Array.prototype.sort is stable: a step and a refusal at the same moment keep steps first.
  calls.sort((a, b) => at(a) - at(b));
  if (run === null || !ended) return calls;
  // A step the feed already has but an earlier read did not counts as called as well.
  const called = new Set(
    [...run.steps, ...steps].flatMap((step) => (step.origin?.executor == null ? [] : [step.origin.executor])),
  );
  const notCalled = run.team
    .filter((member) => !called.has(member.name))
    .map((member): RunRow => ({ kind: "not_called", executor: member.name }));
  return [...calls, ...notCalled];
}

/** Rows share the card's columns: status icon, executor name (as wide as the longest, up to 160 px), text. */
const ROW_CLASS = "col-span-full grid h-7 grid-cols-subgrid items-center pointer-coarse:h-11";
const OPENS_CLASS =
  "overflow-hidden transition-[height] duration-(--duration-fast) starting:h-0 motion-reduce:transition-none";
const EXECUTOR_CLASS = "min-w-0 truncate text-sm leading-5 font-medium";
const ROW_TEXT_CLASS = "text-muted-foreground min-w-0 truncate text-sm leading-5";

/** One agent the coordinator started: a 28 px link row; a row added after mount opens over 150 ms. */
function StepRow({ step, appeared }: { step: AgentNode; appeared: boolean }) {
  const executor = step.origin?.executor ?? null;
  const spoken = [executor, step.description, AGENT_STATUS_LABEL[step.status]].filter((part) => part !== null && part !== "");
  return (
    <li className={cn(ROW_CLASS, appeared && OPENS_CLASS)}>
      <Link
        href={agentPath(step.agentId)}
        aria-label={spoken.join(", ")}
        title={step.description}
        className="hover:bg-accent focus-visible:ring-ring col-span-full grid h-full grid-cols-subgrid items-center rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <AgentStatus variant="icon" status={step.status} className="shrink-0" />
        <span className={EXECUTOR_CLASS}>{executor}</span>
        <span className={ROW_TEXT_CLASS}>{step.description}</span>
      </Link>
    </li>
  );
}

/** A row without an agent behind it (MC-17): «предел вызовов исчерпан» or «не вызывался»; not a link. */
function MutedRow({ Icon, executor, note, opens }: { Icon: LucideIcon; executor: string; note: string; opens: boolean }) {
  return (
    <li className={cn(ROW_CLASS, "px-1", opens && OPENS_CLASS)}>
      <span className="sr-only">{`${executor}, ${note}`}</span>
      <span aria-hidden className="inline-flex size-4 items-center justify-center">
        <Icon className="text-muted-foreground size-3.5" />
      </span>
      <span aria-hidden className={cn(EXECUTOR_CLASS, "text-muted-foreground")}>
        {executor}
      </span>
      <span aria-hidden className={ROW_TEXT_CLASS}>
        {note}
      </span>
    </li>
  );
}

/**
 * The live run card of agent-run-card.md (UXRD CV-01, RN-01, MC-17): the «Workflow» variant exactly when
 * the node is a workflow coordinator, otherwise «Агент», two lines with the record label when the agent comes
 * from the library. Status changes recolour icons and labels only.
 */
export function RunCard({ data }: RunCardProps) {
  const format = useFormatter();
  const locale = useLocale();
  const statusLabel = AGENT_STATUS_LABEL[data.status];
  const origin = runRecord(data);
  const record = origin === null ? null : { ...origin, name: builtinName(origin, locale) };
  const time = (
    <time dateTime={data.createdAt} className="text-muted-foreground shrink-0 text-xs leading-4 font-medium tabular-nums">
      {formatListTime(format, data.createdAt)}
    </time>
  );
  if (!isWorkflowCoordinator(data) || record === null) {
    return (
      <div
        role="group"
        aria-label={`${data.description}: ${statusLabel}`}
        data-slot="run-card"
        data-variant="agent"
        className="bg-card text-card-foreground mx-auto flex w-full max-w-(--prose-max-width) min-w-0 flex-col gap-1 rounded-lg border px-3 py-2"
      >
        <div className="flex min-w-0 items-center gap-3">
          <AgentStatus variant="label" status={data.status} className="shrink-0" />
          <span title={data.description} className="min-w-0 flex-1 truncate text-sm leading-5 font-medium">
            {data.description}
          </span>
          {time}
          <Link
            href={agentPath(data.agentId)}
            aria-label={`Открыть агента «${data.description}»`}
            className={LINK_CLASS}
          >
            Открыть
            <ArrowUpRightIcon aria-hidden className="size-3.5" />
          </Link>
        </div>
        {record !== null && (
          <>
            <RecordLabel origin={record} variant="under" href={recordPath(record.recordId)} />
            <RecipientLine origin={record} firstRun={data.firstRun} />
            <RerunLine origin={record} />
          </>
        )}
      </div>
    );
  }

  return <WorkflowRunCard data={data} origin={record} time={time} />;
}

/**
 * The «Workflow» variant (AC-27.1–AC-27.3): the header is the record label with the version the run started
 * on — the origin's, never the live one; the steps are the coordinator's children from the feed, named by
 * `origin.executor`; limit refusals and, after the end, uncalled executors come from `WorkflowRunView`.
 */
function WorkflowRunCard({ data, origin, time }: { data: RunCardPartData; origin: RunOrigin; time: ReactNode }) {
  const briefQuestion = data.briefQuestion;
  // Rows present at first render (a reload, a re-read) do not animate; only steps added later open.
  const [initialStepIds] = useState(() => new Set(data.children.map((child) => child.agentId)));
  const run = useWorkflowRun(data.agentId, data.status, data.children.length);
  const rows = runRows([...data.children].sort(byCreation), run, RUN_ENDED.has(data.status));
  return (
    <div
      role="group"
      aria-label={`${origin.name}: ${AGENT_STATUS_LABEL[data.status]}`}
      data-slot="run-card"
      data-variant="workflow"
      className="bg-card text-card-foreground mx-auto flex w-full max-w-(--prose-max-width) min-w-0 flex-col gap-1 rounded-lg border p-3"
    >
      <div className="flex h-6 min-w-0 items-center gap-3">
        <AgentStatus variant="label" status={data.status} className="shrink-0" />
        <RecordLabel
          origin={origin}
          variant="row"
          showVersion
          href={recordPath(origin.recordId)}
          className="min-w-0 flex-1 flex-nowrap overflow-hidden"
        />
        {time}
      </div>
      {briefQuestion !== undefined && (
        <p title={briefQuestion} className="text-muted-foreground truncate text-sm leading-5">
          {briefQuestion}
        </p>
      )}
      <RecipientLine origin={origin} firstRun={data.firstRun} />
      {rows.length > 0 && (
        <ul className="grid grid-cols-[auto_fit-content(10rem)_minmax(0,1fr)] gap-x-2">
          {rows.map((row, index) =>
            row.kind === "step" ? (
              <StepRow key={row.step.agentId} step={row.step} appeared={!initialStepIds.has(row.step.agentId)} />
            ) : row.kind === "refused" ? (
              <MutedRow
                key={`refused-${row.executor}-${row.at}-${index}`}
                Icon={BanIcon}
                executor={row.executor}
                note="предел вызовов исчерпан"
                opens={false}
              />
            ) : (
              <MutedRow
                key={`not-called-${row.executor}`}
                Icon={CircleIcon}
                executor={row.executor}
                note="не вызывался"
                opens
              />
            ),
          )}
        </ul>
      )}
      <RerunLine origin={origin} />
      <Link href={agentPath(data.agentId)} className={cn(LINK_CLASS, "self-start")}>
        Открыть запуск
        <ArrowUpRightIcon aria-hidden className="size-3.5" />
      </Link>
    </div>
  );
}
