"use client";

import { useId, useState, type ReactNode, type Ref } from "react";
import { CircleMinus, Info, LoaderCircle, MoreHorizontalIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useStore } from "zustand";
import { EXECUTOR_ROLE_MAX_LENGTH, type ExecutorSourceState, type WorkflowExecutor } from "@agent-os/contracts";
import { CAPTION } from "@/components/admin/admin-form";
import { failedText } from "@/components/i18n/server-text";
import { useShellServices } from "@/components/shell/shell-actions";
import { StateBadge } from "@/components/state-badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { formatRecordModel } from "@/lib/agents/format";
import { describeApiError } from "@/lib/api/api-request";
import { builtinName } from "@/lib/i18n/builtin-name";
import { libraryApi } from "@/lib/library/library-api";
import { logger } from "@/lib/logger";
import type { AgentRecord } from "@/lib/library/update-workflows";
import { cn } from "cn";

export type ExecutorItemProps = {
  executor: WorkflowExecutor;
  /** The executor's report is the workflow's answer: only shown here, chosen in «Кто пишет ответ». */
  final: boolean;
  /** The source's state for the viewer, from the saved record's `executorSources`. */
  sourceState: ExecutorSourceState | undefined;
  /** The author's systems: any other system of the executor is marked as lost. */
  allowedServers: readonly string[];
  roleError: ReactNode;
  /** A check of the executor's other fields: shown under the summary, fixed in the panel. */
  cardError: ReactNode;
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
  const t = useTranslations("library");
  const tErrors = useTranslations("errors");
  const locale = useLocale();
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const [taking, setTaking] = useState(false);
  const [takeError, setTakeError] = useState<ReactNode>(null);

  const source = executor.source;
  const sourceSummary = source === null ? undefined : records?.get(source.recordId);
  const sourceName = sourceSummary === undefined ? executor.name : builtinName(sourceSummary, locale);
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
      if (agent.kind !== "agent") {
        logger.warn("library: an executor's source is no longer an agent", { recordId: source.recordId, kind: agent.kind });
        setTakeError(t("executor.gone", { source: sourceName }));
        return;
      }
      onTakeNewVersion(agent);
    } catch (cause) {
      // Handled here: the failure is shown on the card and the form stays as it was (Invariant 1).
      logger.warn("library: source read for a new executor version failed", {
        recordId: source.recordId,
        ...describeApiError(cause),
      });
      // Not in MC-13: the source's read failed, and MC-13 has no text for it.
      setTakeError(failedText(tErrors, "takeVersion", cause));
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
            aria-label={t("executor.editName", { name: executor.name })}
            aria-describedby={updated || gone ? sourceId : undefined}
            onClick={onEdit}
            className="min-w-0 truncate rounded-sm text-left text-sm leading-5 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring pointer-coarse:min-h-11"
          >
            {executor.name}
          </button>
          {final && <StateBadge variant="source">{t("team.final")}</StateBadge>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("row.actions", { name: executor.name })}
                className="shrink-0 pointer-coarse:size-11"
              />
            }
          >
            <MoreHorizontalIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-45">
            <DropdownMenuItem onClick={onEdit}>{t("executor.edit")}</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              {t("executor.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={roleId} className={cn(CAPTION, "text-muted-foreground")}>
          {t("executor.role")}
        </label>
        <Textarea
          id={roleId}
          value={executor.role}
          rows={1}
          maxLength={EXECUTOR_ROLE_MAX_LENGTH}
          placeholder={t("executor.rolePlaceholder")}
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
            {t("executor.updated", { source: sourceName })}
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
            {t("executor.takeNewVersion")}
          </Button>
        </div>
      )}
      {gone && (
        <p id={sourceId} className={cn(CAPTION, "flex items-center gap-1.5 text-muted-foreground")}>
          <CircleMinus aria-hidden className="size-3.5 shrink-0" />
          {t("executor.gone", { source: sourceName })}
        </p>
      )}
      {takeError !== null && (
        <p role="alert" className={cn(CAPTION, "text-destructive")}>
          {takeError}
        </p>
      )}
      {dropped.length > 0 && <p className={cn(CAPTION, "text-muted-foreground")}>{t("droppedServers", { servers: dropped.join(", ") })}</p>}
    </li>
  );
}

/** «Haiku · Sentry, Jira ⊖ у вас недоступна · до 3 раз» (executor-item.md, part 5). */
function Summary({ executor, allowedServers }: { executor: WorkflowExecutor; allowedServers: readonly string[] }) {
  const { servers } = executor;
  const tFormats = useTranslations("formats");
  const t = useTranslations("library");
  return (
    <p className={cn(CAPTION, "flex flex-wrap items-center gap-x-1 text-muted-foreground")}>
      <span>{formatRecordModel(tFormats, executor.model)}</span>
      <span aria-hidden>·</span>
      {servers.length === 0 ? (
        <span>{t("team.noServers")}</span>
      ) : (
        servers.map((server, index) => (
          <span key={server} className="inline-flex items-center gap-1">
            {server}
            {!allowedServers.includes(server) && <StateBadge state="off">{t("agentFields.unavailable")}</StateBadge>}
            {index < servers.length - 1 && ","}
          </span>
        ))
      )}
      <span aria-hidden>·</span>
      <span className="tabular-nums">{t("team.upTo", { count: executor.maxRuns })}</span>
    </p>
  );
}
