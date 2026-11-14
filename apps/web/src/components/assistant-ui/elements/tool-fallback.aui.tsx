"use client";

import { memo, useState } from "react";
import {
  BanIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleMinusIcon,
  CircleQuestionMarkIcon,
  CircleStopIcon,
  CircleXIcon,
  UnplugIcon,
  type LucideIcon,
} from "lucide-react";
import { useAuiState, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  ToolCallStateSchema,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
  type ToolOutcome,
  type ToolRefusalReason,
} from "@agent-os/contracts";
import { z } from "zod";
import { agentStatusGlyph, FadeSlot, StatusGlyph } from "@/components/agents/agent-status";
import { ValueRows } from "@/components/agents/value-rows";
import { formatTime } from "@/lib/agents/format";
import { flatRows, valueRows } from "@/lib/agents/value-rows";
import type { ToolCallArtifact } from "@/lib/feed/to-feed";
import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import {
  CollapsibleRoot as Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible-root";

/** The ten outcomes of tool-call.md: the eight finished ones and two of an open call. */
type CallOutcome = ToolOutcome | "running" | "awaiting_confirmation";

type OutcomeLook = { label: string; Icon: LucideIcon; tone: string; showsResult: boolean };

/** MC-22 texts, icons and colour roles (tool-call.md, States). */
const OUTCOME_LOOK: Record<CallOutcome, OutcomeLook> = {
  running: { label: "выполняется", ...agentStatusGlyph("working"), showsResult: false },
  success: { label: "готово", Icon: CircleCheckIcon, tone: "text-success", showsResult: true },
  empty: { label: "пустой результат", Icon: CircleIcon, tone: "text-muted-foreground", showsResult: true },
  tool_error: { label: "ошибка инструмента", Icon: CircleXIcon, tone: "text-destructive", showsResult: false },
  transport_failure: { label: "нет связи с сервером", Icon: UnplugIcon, tone: "text-destructive", showsResult: false },
  refused: { label: "отказано", Icon: BanIcon, tone: "text-destructive", showsResult: false },
  awaiting_confirmation: { label: "ждёт подтверждения", ...agentStatusGlyph("awaiting_confirmation"), showsResult: false },
  rejected: { label: "отклонено", Icon: CircleMinusIcon, tone: "text-muted-foreground", showsResult: false },
  interrupted: { label: "прервано", Icon: CircleStopIcon, tone: "text-muted-foreground", showsResult: false },
  unknown: { label: "исход неизвестен", Icon: CircleQuestionMarkIcon, tone: "text-warning", showsResult: false },
};

/** MC-22 refusal reasons; any other code reads as one line with the code as its hint (KD-6). */
const REFUSAL_TEXT: Partial<Record<ToolRefusalReason, string>> = {
  no_access: "Нет доступа к серверу",
  tool_not_in_definition: "Инструмент не входит в набор агента",
  depth_limit: "Достигнут предел вложенности",
  not_allowed: "Шаблон не разрешает этот вызов",
};
const PLATFORM_REFUSAL_TEXT = "Платформа отказала в вызове";

const ArgLabelsSchema = z.record(z.string(), z.string());

/** Values outside the built contract, each warned about once per page. */
const warnedValues = new Set<string>();

function warnOnce(field: string, value: unknown): void {
  const key = `${field}:${String(value)}`;
  if (warnedValues.has(key)) return;
  warnedValues.add(key);
  logger.warn("[web-feed] tool call carries a value outside the contract", { field, value: String(value) });
}

/** A field of the part's `artifact`, which assistant-ui types as `unknown`. */
function field(artifact: unknown, key: keyof ToolCallArtifact): unknown {
  if (typeof artifact !== "object" || artifact === null) return undefined;
  const value: unknown = Reflect.get(artifact, key);
  return value;
}

function textField(artifact: unknown, key: keyof ToolCallArtifact): string | null {
  const value = field(artifact, key);
  return typeof value === "string" ? value : null;
}

/**
 * The outcome of a call from the `artifact` toFeed puts on its part. A value the contract does not hold
 * reads as «исход неизвестен» and is warned about once.
 */
function outcomeOf(artifact: unknown): CallOutcome {
  const state = ToolCallStateSchema.safeParse(field(artifact, "state"));
  if (!state.success) {
    warnOnce("state", field(artifact, "state"));
    return "unknown";
  }
  if (state.data === "requested" || state.data === "sending") return "running";
  if (state.data === "awaiting_confirmation") return "awaiting_confirmation";
  const outcome = ToolOutcomeSchema.safeParse(field(artifact, "outcome"));
  if (!outcome.success) {
    warnOnce("outcome", field(artifact, "outcome"));
    return "unknown";
  }
  return outcome.data;
}

/** MC-22 text of a refusal; a code outside MC-22 (or none) reads as one line with the code as its hint. */
function refusalOf(artifact: unknown): { text: string; hint: string | undefined } {
  const code = textField(artifact, "refusalReason");
  const reason = ToolRefusalReasonSchema.safeParse(code);
  const text = reason.success ? REFUSAL_TEXT[reason.data] : undefined;
  return text !== undefined ? { text, hint: undefined } : { text: PLATFORM_REFUSAL_TEXT, hint: code ?? undefined };
}

/** A result that is JSON text reads as its value; any other result stays as it is. */
function parsedResult(result: unknown): unknown {
  if (typeof result !== "string") return result;
  try {
    const value: unknown = JSON.parse(result);
    return value;
  } catch {
    return result;
  }
}

/**
 * One tool call as tool-call.md draws it: outcome icon, tool, server, outcome text and time in a 32 px
 * header — the tool's title when it has one, with «name · server» on a second 16 px line; the refusal
 * reason under it even when collapsed; when expanded, the arguments as rows with their JSON disclosure
 * and, for a finished call with a result, the result — as rows when it is a flat object. Decisions are
 * not taken here — DecisionCard does that (KD-5).
 */
const ToolFallbackImpl: ToolCallMessagePartComponent = ({ toolName, args, argsText, result, artifact }) => {
  const [open, setOpen] = useState(false);
  const messageCreatedAt = useAuiState((s) => s.message.createdAt);

  const outcome = outcomeOf(artifact);
  const look = OUTCOME_LOOK[outcome];
  const server = textField(artifact, "server");
  const toolTitle = textField(artifact, "toolTitle");
  const toolLabel = toolTitle ?? toolName;
  /** The second header line of a titled MCP tool; without a title the server stands in the first line. */
  const technical = toolTitle !== null && server !== null ? `${toolName} · ${server}` : null;
  const argLabels = ArgLabelsSchema.safeParse(field(artifact, "argLabels"));
  const at =
    textField(artifact, "startedAt") ?? textField(artifact, "finishedAt") ?? messageCreatedAt.toISOString();
  const time = formatTime(at);
  const refusal = outcome === "refused" ? refusalOf(artifact) : null;
  const resultText =
    look.showsResult && result !== undefined
      ? typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2)
      : null;

  return (
    <Collapsible
      data-slot="tool-fallback-root"
      data-outcome={outcome}
      open={open}
      onOpenChange={setOpen}
      className="border-border my-1 w-full rounded-lg border"
    >
      <CollapsibleTrigger
        data-slot="tool-fallback-trigger"
        aria-label={`${toolLabel}: ${look.label}, ${time}`}
        className="group/trigger hover:bg-accent focus-visible:ring-ring flex w-full min-w-0 flex-col rounded-lg px-2 text-start text-sm outline-none focus-visible:ring-2"
      >
        <span className="flex h-8 w-full min-w-0 items-center gap-2 pointer-coarse:h-11">
          <ChevronRightIcon
            aria-hidden
            className="text-muted-foreground size-4 shrink-0 transition-transform duration-(--duration-panel) group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
          />
          <FadeSlot swapKey={outcome} className={look.tone}>
            <StatusGlyph Icon={look.Icon} spinning={outcome === "running"} />
          </FadeSlot>
          <span className="text-foreground min-w-0 truncate" title={toolLabel}>
            {toolLabel}
          </span>
          {server !== null && technical === null ? (
            <span className="text-muted-foreground min-w-0 truncate text-xs">{server}</span>
          ) : null}
          <span className={cn("ms-auto shrink-0 text-xs whitespace-nowrap", look.tone)}>{look.label}</span>
          <time dateTime={at} className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {time}
          </time>
        </span>
        {technical !== null ? (
          <span
            data-slot="tool-fallback-technical"
            title={technical}
            className="text-muted-foreground block h-4 w-full truncate ps-12 text-xs leading-4"
          >
            {technical}
          </span>
        ) : null}
      </CollapsibleTrigger>
      {refusal !== null ? (
        <p
          data-slot="tool-fallback-refusal"
          title={refusal.hint}
          className="text-muted-foreground px-2 pb-1.5 ps-14 text-xs leading-4"
        >
          {refusal.text}
        </p>
      ) : null}
      <CollapsibleContent
        data-slot="tool-fallback-content"
        className={cn(
          "overflow-hidden",
          "data-open:animate-collapsible-down data-closed:animate-collapsible-up [--tw-duration:var(--duration-panel)] motion-reduce:animate-none",
        )}
      >
        <div className="flex flex-col gap-2 px-2 pt-1 pb-2">
          <ValueRows
            label="Аргументы"
            rows={valueRows(args, argLabels.success ? argLabels.data : undefined)}
            raw={argsText}
            disclosure
            density="data"
          />
          {resultText !== null ? (
            <ValueRows
              label="Результат"
              rows={flatRows(parsedResult(result))}
              raw={resultText}
              disclosure={false}
              density="data"
            />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

export const ToolFallback = memo(ToolFallbackImpl);
ToolFallback.displayName = "ToolFallback";
