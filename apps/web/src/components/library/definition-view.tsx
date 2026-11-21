"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useStore } from "zustand";
import {
  ALL_SERVERS,
  BUILTIN_ROLE_KEY,
  type AgentContent,
  type MissingRight,
  type RecordBody,
  type RecordKind,
  type WorkflowContent,
  type WorkflowExecutor,
} from "@agent-os/contracts";
import { Button } from "@/components/ui/button";
import { StateBadge } from "@/components/state-badge";
import { useShellServices } from "@/components/shell/shell-actions";
import { RecordLabel } from "@/components/library/record-label";
import { formatRecordModel, type ModelNames } from "@/lib/agents/format";
import { builtinName } from "@/lib/i18n/builtin-name";
import type { ChangedField, RecordField } from "@/lib/library/record-rules";
import { cn } from "cn";

/** «В карточке» — a draft card in the conversation; «На странице» — a colleague's, company's or panel record. */
export type DefinitionViewVariant = "card" | "page";

/** «Пояснение получателю» (AC-29.1, MC-6): the author and the viewer's roles the record is shared with. */
export type DefinitionRecipient = { author: string; roles: readonly string[] };

export type DefinitionViewProps = {
  definition: { readonly description: string } & RecordBody;
  /** What the viewer lacks to run the record: its servers are marked «у вас недоступна». */
  missingRights: readonly MissingRight[];
  variant: DefinitionViewVariant;
  /** Only on a colleague's record page. */
  recipient?: DefinitionRecipient | null;
  /** A draft's changed fields: each gets «изменено», a removed executor goes to «Убрано: …». */
  changed?: readonly ChangedField[];
  /** The record page of an agent this agent may start; its label has no link without it. */
  recordHref?: (recordId: string) => string;
  /** The viewer's models and default chat model: models read by title, a record without its own model by the default. */
  modelNames?: ModelNames;
};

const CAPTION = "text-muted-foreground text-xs leading-4 font-medium";

/**
 * A record's definition, read-only (design-system definition-view.md; UXRD MC-9, MC-12, MC-15).
 * Instructions, rules, executor names and roles are other employees' text: rendered as plain text
 * with the author's line breaks, never as markdown or HTML. A server is named as the MCP registry
 * names it, without a description (design-web.md, KD-8).
 */
export function DefinitionView({
  definition,
  missingRights,
  variant,
  recipient,
  changed = [],
  recordHref,
  modelNames,
}: DefinitionViewProps) {
  const isChanged = (field: RecordField) => changed.some((item) => item.field === field);
  return (
    <div className="@container flex flex-col gap-2">
      {recipient != null && <RecipientNote kind={definition.kind} recipient={recipient} />}
      {definition.kind === "agent" ? (
        <dl className="flex flex-col gap-2">
          <DescriptionRow description={definition.description} changed={isChanged("description")} />
          <AgentRows
            content={definition.content}
            missing={missingServers(missingRights, null)}
            variant={variant}
            isChanged={isChanged}
            recordHref={recordHref}
            modelNames={modelNames}
          />
        </dl>
      ) : (
        <WorkflowRows
          description={definition.description}
          content={definition.content}
          missingRights={missingRights}
          variant={variant}
          changed={changed}
          isChanged={isChanged}
          modelNames={modelNames}
        />
      )}
    </div>
  );
}

function RecipientNote({ kind, recipient }: { kind: RecordKind; recipient: DefinitionRecipient }) {
  const t = useTranslations("library");
  const locale = useLocale();
  const roles = recipient.roles.map((name) => builtinName({ builtinKey: BUILTIN_ROLE_KEY, name }, locale));
  return (
    <div role="note" className="bg-info-subtle border-info-border flex gap-2 rounded-md border p-3">
      <Info aria-hidden className="text-info mt-px size-4 shrink-0" />
      <p className="text-foreground text-xs leading-4 font-medium">
        {t("definition.recipient", { author: recipient.author, roleCount: roles.length, roles: roles.join(", "), kind })}
      </p>
    </div>
  );
}

type RowProps = { label: string; changed?: boolean; children: ReactNode };

/** «подпись — значение»: the label left in a 140 px column from 560 px of width, above the value below it. */
function Row({ label, changed = false, children }: RowProps) {
  const t = useTranslations("library.definition");
  return (
    <div className="grid gap-0.5 @[35rem]:grid-cols-[8.75rem_minmax(0,1fr)] @[35rem]:gap-x-4">
      <dt className={cn(CAPTION, "flex flex-wrap items-center gap-1.5 @[35rem]:pt-0.5")}>
        {label}
        {changed && <StateBadge variant="source">{t("changed")}</StateBadge>}
      </dt>
      <dd className="text-foreground min-w-0 text-sm leading-5">{children}</dd>
    </div>
  );
}

function DescriptionRow({ description, changed }: { description: string; changed: boolean }) {
  const tLibrary = useTranslations("library");
  return (
    <Row label={tLibrary("fields.description")} changed={changed}>
      <span className="break-words whitespace-pre-wrap">{description === "" ? "—" : description}</span>
    </Row>
  );
}

type AgentRowsProps = {
  content: AgentContent;
  missing: readonly string[];
  variant: DefinitionViewVariant;
  isChanged: (field: RecordField) => boolean;
  recordHref?: (recordId: string) => string;
  modelNames?: ModelNames;
};

function AgentRows({ content, missing, variant, isChanged, recordHref, modelNames }: AgentRowsProps) {
  const t = useTranslations("formats");
  const tLibrary = useTranslations("library");
  return (
    <>
      <Row label={tLibrary("fields.prompt")} changed={isChanged("prompt")}>
        <LongText text={content.prompt} collapsible={variant === "card"} />
      </Row>
      <Row label={tLibrary("fields.model")} changed={isChanged("model")}>
        {formatRecordModel(t, content.model, modelNames)}
      </Row>
      <Row label={tLibrary("fields.maxTurns")} changed={isChanged("maxTurns")}>
        <span className="tabular-nums">{content.maxTurns}</span>
      </Row>
      <Row label={tLibrary("fields.servers")} changed={isChanged("servers")}>
        <Servers servers={content.servers} missing={missing} />
      </Row>
      {content.agents.length > 0 && (
        <Row label={tLibrary("fields.agents")} changed={isChanged("agents")}>
          <StartableAgents ids={content.agents} recordHref={recordHref} />
        </Row>
      )}
    </>
  );
}

/** The agents this agent may start, labelled from the live library list; an agent not in it is unavailable. */
function StartableAgents({ ids, recordHref }: { ids: readonly string[]; recordHref?: (recordId: string) => string }) {
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const t = useTranslations("library");
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {ids.map((id, index) => {
        const summary = records?.get(id);
        const comma = index < ids.length - 1 ? <span aria-hidden>,</span> : null;
        return (
          <span key={id} className="inline-flex min-w-0 items-center gap-0.5">
            {summary === undefined ? (
              <StateBadge state="off">{t("label.unavailable", { kind: "agent" })}</StateBadge>
            ) : (
              <RecordLabel variant="row" summary={summary} href={recordHref?.(id)} />
            )}
            {comma}
          </span>
        );
      })}
    </span>
  );
}

/** «Sentry · Jira ⊖ у вас недоступна», «без систем» or «все системы» (definition-view.md, part 4). */
function Servers({ servers, missing }: { servers: readonly string[]; missing: readonly string[] }) {
  const t = useTranslations("library");
  if (servers.includes(ALL_SERVERS)) return <>{t("team.allServers")}</>;
  if (servers.length === 0) return <>{t("team.noServers")}</>;
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {servers.map((server, index) => (
        <span key={server} className="inline-flex items-center gap-1.5">
          {index > 0 && <span aria-hidden className="text-muted-foreground">·</span>}
          {server}
          {missing.includes(server) && <StateBadge state="off">{t("agentFields.unavailable")}</StateBadge>}
        </span>
      ))}
    </span>
  );
}

type WorkflowRowsProps = {
  description: string;
  content: WorkflowContent;
  missingRights: readonly MissingRight[];
  variant: DefinitionViewVariant;
  changed: readonly ChangedField[];
  isChanged: (field: RecordField) => boolean;
  modelNames?: ModelNames;
};

function WorkflowRows({ description, content, missingRights, variant, changed, isChanged, modelNames }: WorkflowRowsProps) {
  const { coordinator, finalExecutor } = content;
  const t = useTranslations("formats");
  const tLibrary = useTranslations("library");
  return (
    <>
      <dl className="flex flex-col gap-2">
        <DescriptionRow description={description} changed={isChanged("description")} />
      </dl>
      <p className={CAPTION}>{tLibrary("workflowFields.task")}</p>
      <dl className="flex flex-col gap-2">
        <Row label={tLibrary("team.title", { count: content.executors.length })}>
          <Team content={content} missingRights={missingRights} variant={variant} changed={changed} modelNames={modelNames} />
        </Row>
        {coordinator.rules !== "" && (
          <Row label={tLibrary("fields.rules")} changed={isChanged("rules")}>
            <LongText text={coordinator.rules} collapsible={variant === "card"} />
          </Row>
        )}
        <Row label={tLibrary("fields.finalExecutor")} changed={isChanged("finalExecutor")}>
          {finalExecutor ?? tLibrary("workflowFields.coordinator")}
        </Row>
        <Row label={tLibrary("fields.selfLearning")}>
          {tLibrary("definition.selfLearning", { state: content.selfLearning ? "on" : "off" })}
        </Row>
        <Row label={tLibrary("definition.coordinator")} changed={isChanged("coordinatorModel") || isChanged("coordinatorMaxTurns")}>
          <span className="tabular-nums">
            {tLibrary("definition.coordinatorSummary", {
              model: formatRecordModel(t, coordinator.model, modelNames),
              maxTurns: coordinator.maxTurns,
            })}
          </span>
        </Row>
      </dl>
    </>
  );
}

type TeamProps = {
  content: WorkflowContent;
  missingRights: readonly MissingRight[];
  variant: DefinitionViewVariant;
  changed: readonly ChangedField[];
  modelNames?: ModelNames;
};

/** The team as a set, not a queue: executors in alphabetical order, without numbers or arrows. */
function Team({ content, missingRights, variant, changed, modelNames }: TeamProps) {
  const listId = useId();
  const t = useTranslations("library.team");
  const locale = useLocale();
  const [details, setDetails] = useState(variant === "page");
  const executors = [...content.executors].sort((a, b) => a.name.localeCompare(b.name, locale));
  const changedNames = changed.flatMap((item) => (item.field === "executor" ? [item.executor] : []));
  const removed = changedNames.filter((name) => !content.executors.some((executor) => executor.name === name));

  return (
    <div className="flex flex-col gap-1">
      <span className={CAPTION}>{t("hint")}</span>
      <ul id={listId} aria-label={t("listLabel")} className="flex flex-col gap-1">
        {executors.map((executor) => (
          <ExecutorItem
            key={executor.name}
            executor={executor}
            final={executor.name === content.finalExecutor}
            changed={changedNames.includes(executor.name)}
            missing={missingServers(missingRights, executor.name)}
            details={details}
            modelNames={modelNames}
          />
        ))}
      </ul>
      {removed.length > 0 && <span className={CAPTION}>{t("removed", { names: removed.join(", ") })}</span>}
      <Disclosure expanded={details} controls={listId} onToggle={() => setDetails((open) => !open)}>
        {t("details")}
      </Disclosure>
    </div>
  );
}

type ExecutorItemProps = {
  executor: WorkflowExecutor;
  final: boolean;
  changed: boolean;
  missing: readonly string[];
  details: boolean;
  modelNames?: ModelNames;
};

function ExecutorItem({ executor, final, changed, missing, details, modelNames }: ExecutorItemProps) {
  const t = useTranslations("formats");
  const tLibrary = useTranslations("library");
  return (
    <li className="flex flex-col gap-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate" title={`${executor.name} — ${executor.role}`}>
          <span className="font-medium">{executor.name}</span>
          <span className="text-muted-foreground"> — {executor.role}</span>
        </span>
        {final && <StateBadge variant="source">{tLibrary("team.final")}</StateBadge>}
        {changed && <StateBadge variant="source">{tLibrary("definition.changed")}</StateBadge>}
      </span>
      {details && (
        <dl className="border-border ml-1 flex flex-col gap-2 border-l pl-3">
          <Row label={tLibrary("fields.model")}>{formatRecordModel(t, executor.model, modelNames)}</Row>
          <Row label={tLibrary("fields.servers")}>
            <Servers servers={executor.servers} missing={missing} />
          </Row>
          <Row label={tLibrary("team.maxRuns")}>
            <span className="tabular-nums">{tLibrary("team.upTo", { count: executor.maxRuns })}</span>
          </Row>
          <Row label={tLibrary("fields.prompt")}>
            <LongText text={executor.prompt} collapsible />
          </Row>
        </dl>
      )}
    </li>
  );
}

/**
 * The author's long text with their paragraphs and line breaks, as text. Collapsible — six lines
 * and «Показать целиком», and no button when the text is shorter.
 */
function LongText({ text, collapsible }: { text: string; collapsible: boolean }) {
  const textId = useId();
  const t = useTranslations("library.definition");
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!collapsible || element === null) return;
    setOverflows(element.scrollHeight > element.clientHeight);
  }, [collapsible, text]);

  const clamped = collapsible && !expanded;
  return (
    <div className="flex flex-col items-start gap-1">
      <p
        ref={ref}
        id={textId}
        className={cn("text-foreground text-base leading-6.5 break-words whitespace-pre-wrap", clamped && "line-clamp-6")}
      >
        {text === "" ? "—" : text}
      </p>
      {collapsible && (overflows || expanded) && (
        <Disclosure expanded={expanded} controls={textId} onToggle={() => setExpanded((open) => !open)}>
          {t(expanded ? "collapse" : "expand")}
        </Disclosure>
      )}
    </div>
  );
}

type DisclosureProps = { expanded: boolean; controls: string; onToggle: () => void; children: ReactNode };

function Disclosure({ expanded, controls, onToggle, children }: DisclosureProps) {
  return (
    <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
      <ChevronDown
        aria-hidden
        className={cn("transition-transform duration-150 motion-reduce:transition-none", expanded && "rotate-180")}
      />
      {children}
    </Button>
  );
}

/** Servers of the agent itself (`executor` `null`) or of one executor the viewer has no right to. */
function missingServers(missingRights: readonly MissingRight[], executor: string | null): string[] {
  return missingRights.filter((right) => right.executor === executor).flatMap((right) => right.servers);
}
