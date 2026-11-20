"use client";

import Link from "next/link";
import { Bot, Workflow, X } from "lucide-react";
import { useStore } from "zustand";
import type { ChipRecord, RecordKind, RecordSummary, RunOrigin } from "@agent-os/contracts";
import { StateBadge } from "@/components/state-badge";
import { useShellServices } from "@/components/shell/shell-actions";
import { kindWord } from "@/lib/library/library-errors";
import { cn } from "cn";

/**
 * Where the label reads the record from: a library row, or a run's origin — then the name, author
 * and version are the origin's and the audience is the live row of `libraryIndex` — or a message's
 * chip: the name and kind are the chip's, everything else the live row's when the list holds it.
 */
type RecordLabelSource =
  | { summary: RecordSummary; origin?: never; chip?: never }
  | { origin: RunOrigin; summary?: never; chip?: never }
  | { chip: ChipRecord; summary?: never; origin?: never };

type RecordLabelVariant =
  /** «Строка»: the label names the record itself. */
  | { variant: "row"; onRemove?: never }
  /** «Под названием»: a caption under another title (a run card, a decision card, the agent tree). */
  | { variant: "under"; onRemove?: never }
  /** «Чип»: a chosen record that can be removed; source and audience go to the hint. */
  | { variant: "chip"; onRemove: () => void };

export type RecordLabelProps = RecordLabelSource &
  RecordLabelVariant & {
    /** The record page the name links to; no link without it, and none on an unavailable record. */
    href?: string;
    /** «версия {N}» — only where the number explains the behaviour (a run card, the agent page). */
    showVersion?: boolean;
    /** `false` — the source is plain from the place («Мои» in the library, the header of one's own editor). */
    showSource?: boolean;
    className?: string;
  };

type LabelData = {
  name: string;
  kind: RecordKind;
  version: number;
  /** The library list is read and the record is not in it: deleted or closed for the viewer. */
  unavailable: boolean;
  company: boolean;
  mine: boolean;
  author: string | null;
  /** «только вы», the viewer's roles, «от компании»; `null` — nothing to say (the list is not read). */
  audience: string | null;
};

/**
 * The record label (design-system record-label.md, UXRD MC-17): name, source and audience in plain
 * words. Text written by other employees is rendered as text only.
 */
export function RecordLabel(props: RecordLabelProps) {
  const data = useLabelData(props);
  if (props.variant === "chip") return <RecordChip data={data} onRemove={props.onRemove} className={props.className} />;

  const showSource = props.showSource ?? true;
  const source = !showSource || data.company ? null : data.mine ? "моя" : data.author;
  const under = props.variant === "under";
  const nameClass = under
    ? "text-muted-foreground"
    : "text-foreground text-sm leading-5 font-medium";

  return (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1",
        under ? "text-muted-foreground text-xs leading-4 font-medium" : "text-sm leading-5",
        props.className,
      )}
    >
      {props.href !== undefined && !data.unavailable ? (
        <Link
          href={props.href}
          title={data.name}
          className={cn(
            nameClass,
            "focus-visible:ring-ring min-w-0 truncate rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2",
          )}
        >
          {data.name}
        </Link>
      ) : (
        <span title={data.name} className={cn(nameClass, "min-w-0 truncate")}>
          {data.name}
        </span>
      )}
      <span className="sr-only">{spokenRest(data, props.showVersion === true)}</span>
      {source !== null && (
        <span aria-hidden className={under ? undefined : "text-muted-foreground"}>
          · {source}
        </span>
      )}
      <span aria-hidden className="contents">
        <AudienceBadge data={data} />
      </span>
      {props.showVersion === true && (
        <span aria-hidden className="text-muted-foreground text-xs leading-4 tabular-nums">
          · версия {data.version}
        </span>
      )}
    </span>
  );
}

function AudienceBadge({ data }: { data: LabelData }) {
  if (data.unavailable) return <StateBadge state="off">{`${kindWord(data.kind)} недоступен`}</StateBadge>;
  if (data.audience === null) return null;
  return <StateBadge variant="source">{data.audience}</StateBadge>;
}

function RecordChip({ data, onRemove, className }: { data: LabelData; onRemove: () => void; className?: string }) {
  const KindIcon = data.kind === "agent" ? Bot : Workflow;
  const hint = [data.company ? null : data.mine ? "моя" : data.author, data.audience].filter(Boolean).join(" · ");
  return (
    <span
      role="group"
      aria-label={data.name}
      title={hint === "" ? data.name : `${data.name} · ${hint}`}
      className={cn(
        "bg-muted animate-in fade-in-0 inline-flex h-7 max-w-full items-center gap-1.5 rounded-full py-1 pr-1 pl-2.5 duration-150 motion-reduce:animate-none",
        className,
      )}
    >
      <KindIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      <span className="text-foreground min-w-0 truncate text-sm leading-5 font-medium">{data.name}</span>
      <button
        type="button"
        aria-label={`Убрать: ${data.name}`}
        onClick={onRemove}
        className="text-muted-foreground hover:bg-accent focus-visible:bg-accent focus-visible:ring-ring inline-flex size-5 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </span>
  );
}

/** What a screen reader hears after the name, as one phrase (MC-17). */
function spokenRest(data: LabelData, withVersion: boolean): string {
  const parts: string[] = [];
  if (data.unavailable) parts.push(`${kindWord(data.kind)} недоступен`);
  else if (data.company) parts.push("от компании");
  else {
    if (data.mine) parts.push(`мой ${kindWord(data.kind)}`);
    // A chip whose row is not read yet has no known author.
    else if (data.author !== null) parts.push(`автор ${data.author}`);
    if (data.audience !== null) parts.push(data.audience);
  }
  if (withVersion) parts.push(`версия ${data.version}`);
  return parts.length === 0 ? "" : `, ${parts.join(", ")}`;
}

function useLabelData(props: RecordLabelSource): LabelData {
  const { libraryIndex, currentUser } = useShellServices();
  const summary = props.summary;
  const recordId = props.summary?.id ?? props.origin?.recordId ?? props.chip?.id ?? "";
  // A summary is the live row itself; an origin or a chip looks its record up in the library list.
  const live = useStore(libraryIndex, (state): RecordSummary | null | undefined => {
    if (summary !== undefined) return summary;
    return state.records === null ? undefined : (state.records.get(recordId) ?? null);
  });
  const viewerId = useStore(currentUser, (state) => state.user?.id ?? null);

  if (props.chip !== undefined) {
    const company = live != null && live.author === null;
    const mine = live != null && live.mine;
    return {
      name: props.chip.name,
      kind: props.chip.kind,
      version: live?.version ?? 0,
      unavailable: live === null,
      company,
      mine,
      author: live?.author?.name ?? null,
      audience: audienceOf(live, company, mine),
    };
  }
  const header =
    props.summary !== undefined
      ? { ...props.summary, recordId: props.summary.id }
      : { ...props.origin, recordId: props.origin.recordId };

  const company = header.author === null;
  const mine = live != null ? live.mine : header.author !== null && header.author.id === viewerId;
  return {
    name: header.name,
    kind: header.kind,
    version: header.version,
    unavailable: live === null,
    company,
    mine,
    author: header.author?.name ?? null,
    audience: audienceOf(live, company, mine),
  };
}

function audienceOf(live: RecordSummary | null | undefined, company: boolean, mine: boolean): string | null {
  if (live === null) return null;
  if (company) return "от компании";
  if (live === undefined) return null;
  if (mine && live.audience.roles.length === 0) return "только вы";
  // The viewer sees only the roles they are in themselves.
  const roles = live.audience.roles.filter((role) => role.member).map((role) => role.name);
  return roles.length > 0 ? roles.join(", ") : null;
}
