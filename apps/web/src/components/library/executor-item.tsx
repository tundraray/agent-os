"use client";

import { useId, useState, type Ref } from "react";
import { CircleMinus, Info, LoaderCircle, MoreHorizontalIcon } from "lucide-react";
import { useStore } from "zustand";
import { EXECUTOR_ROLE_MAX_LENGTH, type ExecutorSourceState, type WorkflowExecutor } from "@agent-os/contracts";
import { CAPTION } from "@/components/admin/admin-form";
import { useShellServices } from "@/components/shell/shell-actions";
import { StateBadge } from "@/components/state-badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { formatModel } from "@/lib/agents/format";
import { describeApiError } from "@/lib/api/api-request";
import { libraryApi } from "@/lib/library/library-api";
import { droppedServersText, failureReason } from "@/lib/library/library-errors";
import { logger } from "@/lib/logger";
import type { AgentRecord } from "@/lib/library/update-workflows";
import { cn } from "cn";

/** UXRD MC-13. */
const TEXT = {
  role: "За что отвечает и когда звать",
  rolePlaceholder: "Например: собирает ошибки Sentry за период из задания",
  final: "пишет ответ",
  maxRuns: (count: number) => `до ${count} раз`,
  noServers: "без систем",
  lostServer: "у вас недоступна",
  updated: (source: string) => `Агент «${source}» обновлён в библиотеке`,
  takeNewVersion: "Взять новую версию",
  gone: (source: string) => `Агент «${source}» удалён или закрыт для вас — обновить нельзя`,
  edit: "Изменить",
  remove: "Убрать из команды",
  editName: (name: string) => `${name}, изменить`,
  actions: (name: string) => `Действия: ${name}`,
  // Not in MC-13: the source's read failed, and MC-13 has no text for it.
  takeFailed: (reason: string) => `Не удалось взять новую версию: ${reason}`,
} as const;

export type ExecutorItemProps = {
  executor: WorkflowExecutor;
  /** The executor's report is the workflow's answer: only shown here, chosen in «Кто пишет ответ». */
  final: boolean;
  /** The source's state for the viewer, from the saved record's `executorSources`. */
  sourceState: ExecutorSourceState | undefined;
  /** The author's systems: any other system of the executor is marked as lost. */
  allowedServers: readonly string[];
  roleError: string | undefined;
  /** A check of the executor's other fields: shown under the summary, fixed in the panel. */
  cardError: string | undefined;
  /** Systems the last taken version brought that the author has no access to. */
  dropped: readonly string[];
  nameRef: Ref<HTMLButtonElement>;
  onEdit: () => void;
  onRemove: () => void;
  /** The source agent as read now: the form takes its version, nothing is sent (DC-4). */
  onTakeNewVersion: (agent: AgentRecord) => void;
  onRoleChange: (role: string) => void;
};

/**
 * One member of the workflow's team (executor-item.md; UXRD WF-01): the name opens the panel, the
 * responsibility line is edited on the card, the summary names model, systems and the number of calls.
 * The source line shows only when the source agent changed (with «Взять новую версию») or is gone (without an
 * action; the executor stays). Names, roles and instructions are other employees' text: rendered as text only.
 */
export function ExecutorItem({
  executor,
  final,
  sourceState,
  allowedServers,
  roleError,
  cardError,
  dropped,
  nameRef,
  onEdit,
  onRemove,
  onTakeNewVersion,
  onRoleChange,
}: ExecutorItemProps) {
  const id = useId();
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const [taking, setTaking] = useState(false);
  const [takeError, setTakeError] = useState<string | null>(null);

  const source = executor.source;
  const sourceName = (source !== null ? records?.get(source.recordId)?.name : undefined) ?? executor.name;
  // The row of a changed source goes once the form holds its latest version; «Отменить изменения» brings it back.
  const updated =
    source !== null &&
    sourceState?.state === "changed" &&
    sourceState.latestVersion !== null &&
    source.version < sourceState.latestVersion;
  const gone = source !== null && sourceState?.state === "gone";
  const sourceId = `${id}-source`;
  const roleId = `${id}-role`;
  const roleErrorId = `${id}-role-error`;
  const cardErrorId = `${id}-card-error`;

  const take = async (): Promise<void> => {
    if (source === null || taking) return;
    setTaking(true);
    setTakeError(null);
    try {
      const agent = await libraryApi.get(source.recordId);
      if (agent.kind !== "agent") throw new Error(TEXT.gone(sourceName));
      onTakeNewVersion(agent);
    } catch (cause) {
      // Handled here: the failure is shown on the card and the form stays as it was (Invariant 1).
      logger.warn("library: source read for a new executor version failed", {
        recordId: source.recordId,
        ...describeApiError(cause),
      });
      setTakeError(TEXT.takeFailed(failureReason(cause)));
    } finally {
      setTaking(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-card-foreground transition-colors duration-150 focus-within:bg-accent hover:bg-accent motion-reduce:transition-none">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <button
            ref={nameRef}
            type="button"
            aria-label={TEXT.editName(executor.name)}
            aria-describedby={updated || gone ? sourceId : undefined}
            onClick={onEdit}
            className="min-w-0 truncate rounded-sm text-left text-sm leading-5 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring pointer-coarse:min-h-11"
          >
            {executor.name}
          </button>
          {final && <StateBadge variant="source">{TEXT.final}</StateBadge>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={TEXT.actions(executor.name)}
                className="shrink-0 pointer-coarse:size-11"
              />
            }
          >
            <MoreHorizontalIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-45">
            <DropdownMenuItem onClick={onEdit}>{TEXT.edit}</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              {TEXT.remove}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={roleId} className={cn(CAPTION, "text-muted-foreground")}>
          {TEXT.role}
        </label>
        <Textarea
          id={roleId}
          value={executor.role}
          rows={1}
          maxLength={EXECUTOR_ROLE_MAX_LENGTH}
          placeholder={TEXT.rolePlaceholder}
          aria-invalid={roleError !== undefined}
          aria-describedby={roleError === undefined ? undefined : roleErrorId}
          // One to three lines by its content, then it scrolls inside.
          className="min-h-9 max-h-20 overflow-y-auto bg-background pointer-coarse:text-base"
          onChange={(event) => onRoleChange(event.target.value)}
        />
        {roleError !== undefined && (
          <p id={roleErrorId} className={cn(CAPTION, "text-destructive")}>
            {roleError}
          </p>
        )}
      </div>
      <Summary executor={executor} allowedServers={allowedServers} />
      {cardError !== undefined && (
        <p id={cardErrorId} role="alert" tabIndex={-1} data-card-error className={cn(CAPTION, "text-destructive")}>
          {cardError}
        </p>
      )}
      {updated && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id={sourceId} className={cn(CAPTION, "flex items-center gap-1.5 text-foreground")}>
            <Info aria-hidden className="size-3.5 shrink-0 text-info" />
            {TEXT.updated(sourceName)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={taking}
            className="ml-auto pointer-coarse:h-11"
            onClick={() => void take()}
          >
            {taking && <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />}
            {TEXT.takeNewVersion}
          </Button>
        </div>
      )}
      {gone && (
        <p id={sourceId} className={cn(CAPTION, "flex items-center gap-1.5 text-muted-foreground")}>
          <CircleMinus aria-hidden className="size-3.5 shrink-0" />
          {TEXT.gone(sourceName)}
        </p>
      )}
      {takeError !== null && (
        <p role="alert" className={cn(CAPTION, "text-destructive")}>
          {takeError}
        </p>
      )}
      {dropped.length > 0 && <p className={cn(CAPTION, "text-muted-foreground")}>{droppedServersText(dropped)}</p>}
    </li>
  );
}

/** «Haiku · Sentry, Jira ⊖ у вас недоступна · до 3 раз» (executor-item.md, part 5). */
function Summary({ executor, allowedServers }: { executor: WorkflowExecutor; allowedServers: readonly string[] }) {
  const { servers } = executor;
  return (
    <p className={cn(CAPTION, "flex flex-wrap items-center gap-x-1 text-muted-foreground")}>
      <span>{formatModel(executor.model)}</span>
      <span aria-hidden>·</span>
      {servers.length === 0 ? (
        <span>{TEXT.noServers}</span>
      ) : (
        servers.map((server, index) => (
          <span key={server} className="inline-flex items-center gap-1">
            {server}
            {!allowedServers.includes(server) && <StateBadge state="off">{TEXT.lostServer}</StateBadge>}
            {index < servers.length - 1 && ","}
          </span>
        ))
      )}
      <span aria-hidden>·</span>
      <span className="tabular-nums">{TEXT.maxRuns(executor.maxRuns)}</span>
    </p>
  );
}
