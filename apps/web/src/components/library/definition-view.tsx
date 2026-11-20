"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import { useStore } from "zustand";
import {
  ALL_SERVERS,
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
import { formatModel } from "@/lib/agents/format";
import { kindWord } from "@/lib/library/library-errors";
import { RECORD_FIELD_LABELS, type ChangedField, type RecordField } from "@/lib/library/record-rules";
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
};

const TASK_ONLY_TEXT =
  "Workflow получает только задание, которое вы подтверждаете перед запуском: вопрос, границы и результат. Беседу он не видит.";
const CAPTION = "text-muted-foreground text-xs leading-4 font-medium";

/**
 * A record's definition, read-only (design-system definition-view.md; UXRD MC-9, MC-12, MC-15).
 * Instructions, rules, executor names and roles are other employees' text: rendered as plain text
 * with the author's line breaks, never as markdown or HTML. A server is named as the MCP registry
 * names it, without a description (design-web.md, KD-8).
 */
export function DefinitionView({ definition, missingRights, variant, recipient, changed = [], recordHref }: DefinitionViewProps) {
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
        />
      )}
    </div>
  );
}

function RecipientNote({ kind, recipient }: { kind: RecordKind; recipient: DefinitionRecipient }) {
  const shared = recipient.roles.length > 0 ? ` ${kindWord(kind, true)} открыт вашей роли ${recipient.roles.join(", ")}.` : "";
  return (
    <div role="note" className="bg-info-subtle border-info-border flex gap-2 rounded-md border p-3">
      <Info aria-hidden className="text-info mt-px size-4 shrink-0" />
      <p className="text-foreground text-xs leading-4 font-medium">
        {`Автор — ${recipient.author}.${shared}`} Работает с вашими правами и подключёнными аккаунтами.
        Изменения в системах — только после вашего подтверждения. {`Убрать ${kindWord(kind)} может автор или администратор.`}
      </p>
    </div>
  );
}

type RowProps = { label: string; changed?: boolean; children: ReactNode };

/** «подпись — значение»: the label left in a 140 px column from 560 px of width, above the value below it. */
function Row({ label, changed = false, children }: RowProps) {
  return (
    <div className="grid gap-0.5 @[35rem]:grid-cols-[8.75rem_minmax(0,1fr)] @[35rem]:gap-x-4">
      <dt className={cn(CAPTION, "flex flex-wrap items-center gap-1.5 @[35rem]:pt-0.5")}>
        {label}
        {changed && <StateBadge variant="source">изменено</StateBadge>}
      </dt>
      <dd className="text-foreground min-w-0 text-sm leading-5">{children}</dd>
    </div>
  );
}

function DescriptionRow({ description, changed }: { description: string; changed: boolean }) {
  return (
    <Row label={RECORD_FIELD_LABELS.description} changed={changed}>
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
};

function AgentRows({ content, missing, variant, isChanged, recordHref }: AgentRowsProps) {
  return (
    <>
      <Row label={RECORD_FIELD_LABELS.prompt} changed={isChanged("prompt")}>
        <LongText text={content.prompt} collapsible={variant === "card"} />
      </Row>
      <Row label={RECORD_FIELD_LABELS.model} changed={isChanged("model")}>
        {formatModel(content.model)}
      </Row>
      <Row label={RECORD_FIELD_LABELS.maxTurns} changed={isChanged("maxTurns")}>
        <span className="tabular-nums">{content.maxTurns}</span>
      </Row>
      <Row label={RECORD_FIELD_LABELS.servers} changed={isChanged("servers")}>
        <Servers servers={content.servers} missing={missing} />
      </Row>
      {content.agents.length > 0 && (
        <Row label={RECORD_FIELD_LABELS.agents} changed={isChanged("agents")}>
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
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {ids.map((id, index) => {
        const summary = records?.get(id);
        const comma = index < ids.length - 1 ? <span aria-hidden>,</span> : null;
        return (
          <span key={id} className="inline-flex min-w-0 items-center gap-0.5">
            {summary === undefined ? (
              <StateBadge state="off">{`${kindWord("agent")} недоступен`}</StateBadge>
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
  if (servers.includes(ALL_SERVERS)) return <>все системы</>;
  if (servers.length === 0) return <>без систем</>;
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {servers.map((server, index) => (
        <span key={server} className="inline-flex items-center gap-1.5">
          {index > 0 && <span aria-hidden className="text-muted-foreground">·</span>}
          {server}
          {missing.includes(server) && <StateBadge state="off">у вас недоступна</StateBadge>}
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
};

function WorkflowRows({ description, content, missingRights, variant, changed, isChanged }: WorkflowRowsProps) {
  const { coordinator, finalExecutor } = content;
  return (
    <>
      <dl className="flex flex-col gap-2">
        <DescriptionRow description={description} changed={isChanged("description")} />
      </dl>
      <p className={CAPTION}>{TASK_ONLY_TEXT}</p>
      <dl className="flex flex-col gap-2">
        <Row label={`Команда · ${content.executors.length}`}>
          <Team content={content} missingRights={missingRights} variant={variant} changed={changed} />
        </Row>
        {coordinator.rules !== "" && (
          <Row label={RECORD_FIELD_LABELS.rules} changed={isChanged("rules")}>
            <LongText text={coordinator.rules} collapsible={variant === "card"} />
          </Row>
        )}
        <Row label={RECORD_FIELD_LABELS.finalExecutor} changed={isChanged("finalExecutor")}>
          {finalExecutor ?? "Координатор сам"}
        </Row>
        <Row label="Координатор" changed={isChanged("coordinatorModel") || isChanged("coordinatorMaxTurns")}>
          <span className="tabular-nums">{`${formatModel(coordinator.model)} · до ${coordinator.maxTurns} шагов`}</span>
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
};

/** The team as a set, not a queue: executors in alphabetical order, without numbers or arrows. */
function Team({ content, missingRights, variant, changed }: TeamProps) {
  const listId = useId();
  const [details, setDetails] = useState(variant === "page");
  const executors = [...content.executors].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const changedNames = changed.flatMap((item) => (item.field === "executor" ? [item.executor] : []));
  const removed = changedNames.filter((name) => !content.executors.some((executor) => executor.name === name));

  return (
    <div className="flex flex-col gap-1">
      <span className={CAPTION}>Кого и когда звать, решает координатор по строкам команды.</span>
      <ul id={listId} aria-label="Команда, кого и когда звать, решает координатор" className="flex flex-col gap-1">
        {executors.map((executor) => (
          <ExecutorItem
            key={executor.name}
            executor={executor}
            final={executor.name === content.finalExecutor}
            changed={changedNames.includes(executor.name)}
            missing={missingServers(missingRights, executor.name)}
            details={details}
          />
        ))}
      </ul>
      {removed.length > 0 && <span className={CAPTION}>{`Убрано: ${removed.join(", ")}`}</span>}
      <Disclosure expanded={details} controls={listId} onToggle={() => setDetails((open) => !open)}>
        Подробнее
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
};

function ExecutorItem({ executor, final, changed, missing, details }: ExecutorItemProps) {
  return (
    <li className="flex flex-col gap-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate" title={`${executor.name} — ${executor.role}`}>
          <span className="font-medium">{executor.name}</span>
          <span className="text-muted-foreground"> — {executor.role}</span>
        </span>
        {final && <StateBadge variant="source">пишет ответ</StateBadge>}
        {changed && <StateBadge variant="source">изменено</StateBadge>}
      </span>
      {details && (
        <dl className="border-border ml-1 flex flex-col gap-2 border-l pl-3">
          <Row label={RECORD_FIELD_LABELS.model}>{formatModel(executor.model)}</Row>
          <Row label={RECORD_FIELD_LABELS.servers}>
            <Servers servers={executor.servers} missing={missing} />
          </Row>
          <Row label="Сколько раз можно звать">
            <span className="tabular-nums">{`до ${executor.maxRuns} раз`}</span>
          </Row>
          <Row label={RECORD_FIELD_LABELS.prompt}>
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
          {expanded ? "Свернуть" : "Показать целиком"}
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
