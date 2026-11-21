"use client";

import Link from "next/link";
import { Bot, Workflow, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useStore } from "zustand";
import { BUILTIN_ROLE_KEY, type ChipRecord, type RecordKind, type RecordSummary, type RunOrigin } from "@agent-os/contracts";
import { StateBadge } from "@/components/state-badge";
import { useShellServices } from "@/components/shell/shell-actions";
import { builtinName } from "@/lib/i18n/builtin-name";
import type { LibraryTranslator } from "@/lib/i18n/messages";
import type { Locale } from "@/lib/i18n/pick-locale";
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
 * words. Text written by other employees is rendered as text only. A built-in record's name, and the
 * built-in role among the audience, show in the page's language.
 */
export function RecordLabel(props: RecordLabelProps) {
  const t = useTranslations("library");
  const data = useLabelData(props, t);
  if (props.variant === "chip") return <RecordChip data={data} onRemove={props.onRemove} className={props.className} />;

  const showSource = props.showSource ?? true;
  const source = !showSource || data.company ? null : data.mine ? t("label.mine") : data.author;

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
      <span className="sr-only">{spokenRest(t, data, props.showVersion === true)}</span>
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
          {t("label.version", { version: data.version })}
        </span>
      )}
    </span>
  );
}

function AudienceBadge({ data }: { data: LabelData }) {
  const t = useTranslations("library");
  if (data.unavailable) return <StateBadge state="off">{t("label.unavailable", { kind: data.kind })}</StateBadge>;
  if (data.audience === null) return null;
  return <StateBadge variant="source">{data.audience}</StateBadge>;
}

function RecordChip({ data, onRemove, className }: { data: LabelData; onRemove: () => void; className?: string }) {
  const t = useTranslations("library");
  const KindIcon = data.kind === "agent" ? Bot : Workflow;
  const hint = [data.company ? null : data.mine ? t("label.mine") : data.author, data.audience].filter(Boolean).join(" · ");
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
        aria-label={t("label.remove", { name: data.name })}
        onClick={onRemove}
        className="text-muted-foreground hover:bg-accent focus-visible:bg-accent focus-visible:ring-ring inline-flex size-5 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </span>
  );
}

/** What a screen reader hears after the name, as one phrase (MC-17). */
function spokenRest(t: LibraryTranslator, data: LabelData, withVersion: boolean): string {
  const parts: string[] = [];
  if (data.unavailable) parts.push(t("label.unavailable", { kind: data.kind }));
  else if (data.company) parts.push(t("label.company"));
  else {
    if (data.mine) parts.push(t("label.spoken.mine", { kind: data.kind }));
    // A chip whose row is not read yet has no known author.
    else if (data.author !== null) parts.push(t("label.spoken.author", { name: data.author }));
    if (data.audience !== null) parts.push(data.audience);
  }
  if (withVersion) parts.push(t("label.spoken.version", { version: data.version }));
  return parts.length === 0 ? "" : `, ${parts.join(", ")}`;
}

function useLabelData(props: RecordLabelSource, t: LibraryTranslator): LabelData {
  const { libraryIndex, currentUser } = useShellServices();
  const locale = useLocale();
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
      name: builtinName({ builtinKey: live?.builtinKey ?? null, name: props.chip.name }, locale),
      kind: props.chip.kind,
      version: live?.version ?? 0,
      unavailable: live === null,
      company,
      mine,
      author: live?.author?.name ?? null,
      audience: audienceOf(t, locale, { live, company, mine }),
    };
  }
  const header =
    props.summary !== undefined
      ? { ...props.summary, recordId: props.summary.id }
      : { ...props.origin, recordId: props.origin.recordId };

  const company = header.author === null;
  const mine = live != null ? live.mine : header.author !== null && header.author.id === viewerId;
  return {
    name: builtinName(header, locale),
    kind: header.kind,
    version: header.version,
    unavailable: live === null,
    company,
    mine,
    author: header.author?.name ?? null,
    audience: audienceOf(t, locale, { live, company, mine }),
  };
}

type AudienceOf = {
  live: RecordSummary | null | undefined;
  company: boolean;
  mine: boolean;
};

function audienceOf(t: LibraryTranslator, locale: Locale, { live, company, mine }: AudienceOf): string | null {
  if (live === null) return null;
  if (company) return t("label.company");
  if (live === undefined) return null;
  if (mine && live.audience.roles.length === 0) return t("label.onlyYou");
  // The viewer sees only the roles they are in themselves.
  const roles = live.audience.roles
    .filter((role) => role.member)
    .map((role) => builtinName({ builtinKey: BUILTIN_ROLE_KEY, name: role.name }, locale));
  return roles.length > 0 ? roles.join(", ") : null;
}
