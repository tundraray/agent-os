"use client";

import Link from "next/link";
import { memo, useState, type ReactNode } from "react";
import { useFormatter, useMessages, useTranslations } from "next-intl";
import {
  BanIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleMinusIcon,
  CircleQuestionMarkIcon,
  CircleStopIcon,
  CircleXIcon,
  KeyRoundIcon,
  UnplugIcon,
  type LucideIcon,
} from "lucide-react";
import { useAuiState, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  IdSchema,
  RecordKindSchema,
  ToolCallStateSchema,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
  type RecordKind,
  type ToolOutcome,
  type ToolRefusalReason,
} from "@agent-os/contracts";
import { z } from "zod";
import { agentStatusGlyph, FadeSlot, StatusGlyph } from "@/components/agents/agent-status";
import { useLiveRecord } from "@/components/agents/run-card";
import { ValueRows } from "@/components/agents/value-rows";
import { ShellLink } from "@/components/shell/shell-link";
import { refusalText } from "@/lib/access/access-texts";
import type { ErrorsTranslator } from "@/lib/agents/format";
import { isRunCode, NO_RUN_VALUE, runCodeView } from "@/lib/agents/run-code";
import { flatRows, valueRows } from "@/lib/agents/value-rows";
import type { ToolCallArtifact } from "@/lib/feed/to-feed";
import { builtinToolLabels } from "@/lib/i18n/builtin-name";
import type { ChatTranslator } from "@/lib/i18n/messages";
import { formatListTime } from "@/lib/i18n/formats";
import { describeRefusal, type RefusalText } from "@/lib/library/library-errors";
import { logger } from "@/lib/logger";
import { ACCOUNT_PATH, recordPath } from "@/lib/shell-route";
import { cn } from "@/lib/utils";
import {
  CollapsibleRoot as Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible-root";

/** The eleven outcomes of tool-call.md: the nine finished ones and two of an open call. */
type CallOutcome = ToolOutcome | "running" | "awaiting_confirmation";

type OutcomeLook = { Icon: LucideIcon; tone: string; showsResult: boolean };

/** Icons and colour roles of the outcomes (tool-call.md, States); the MC-22 texts are `chat.tool.outcome`. */
const OUTCOME_LOOK: Record<CallOutcome, OutcomeLook> = {
  running: { ...agentStatusGlyph("working"), showsResult: false },
  success: { Icon: CircleCheckIcon, tone: "text-success", showsResult: true },
  empty: { Icon: CircleIcon, tone: "text-muted-foreground", showsResult: true },
  tool_error: { Icon: CircleXIcon, tone: "text-destructive", showsResult: false },
  transport_failure: { Icon: UnplugIcon, tone: "text-destructive", showsResult: false },
  refused: { Icon: BanIcon, tone: "text-destructive", showsResult: false },
  auth_required: { Icon: KeyRoundIcon, tone: "text-warning", showsResult: false },
  awaiting_confirmation: { ...agentStatusGlyph("awaiting_confirmation"), showsResult: false },
  rejected: { Icon: CircleMinusIcon, tone: "text-muted-foreground", showsResult: false },
  interrupted: { Icon: CircleStopIcon, tone: "text-muted-foreground", showsResult: false },
  unknown: { Icon: CircleQuestionMarkIcon, tone: "text-warning", showsResult: false },
};

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
 * reads as `unknown` and is warned about once.
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

const RefusalDetailSchema = z.object({ model: z.string() });

/** The refused model of a refusal by model: `refusalDetail.model` of the result, never the call's arguments. */
function refusedModel(artifact: unknown): string | null {
  const detail = RefusalDetailSchema.safeParse(field(artifact, "refusalDetail"));
  return detail.success ? detail.data.model : null;
}

function refusalReasonOf(artifact: unknown): ToolRefusalReason | null {
  const reason = ToolRefusalReasonSchema.safeParse(field(artifact, "refusalReason"));
  return reason.success ? reason.data : null;
}

type ReasonLine = { content: ReactNode; hint: string | undefined };

/**
 * MC-10 or MC-22 text of a refusal (`refusalText`); a code outside them (or none) reads as the platform's
 * refusal with the code as its hint (KD-6).
 */
function refusalOf(t: ErrorsTranslator, artifact: unknown): ReasonLine {
  const reason = refusalReasonOf(artifact);
  const text = reason === null ? null : refusalText(t, reason, refusedModel(artifact));
  return text !== null
    ? { content: text, hint: undefined }
    : { content: t("platformRefusal"), hint: textField(artifact, "refusalReason") ?? undefined };
}

/** The library's create and start tools: their refusals name the record (MC-16, MC-17; DC-02, RN-06). */
const LIBRARY_TOOLS = new Set(["start_agent", "start_workflow", "draft_record"]);

/**
 * The record a library call names and its kind: `agent` of `start_agent` (only a record id — not a fork
 * or an executor's name), `workflow` of `start_workflow`, `recordId` and `kind` of `draft_record`.
 */
function libraryCallOf(toolName: string, args: unknown): { recordId: string | null; kind: RecordKind | null } {
  const arg = (key: string): unknown =>
    typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
  const id = (value: unknown): string | null => {
    const parsed = IdSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
  if (toolName === "start_agent") return { recordId: id(arg("agent")), kind: "agent" };
  if (toolName === "start_workflow") return { recordId: id(arg("workflow")), kind: "workflow" };
  const kind = RecordKindSchema.safeParse(arg("kind"));
  return { recordId: id(arg("recordId")), kind: kind.success ? kind.data : null };
}

function ReasonParagraph({ content, hint }: ReasonLine) {
  return (
    <p
      data-slot="tool-fallback-reason"
      title={hint}
      className="text-muted-foreground px-2 pb-1.5 ps-14 text-xs leading-4"
    >
      {content}
    </p>
  );
}

const LINK_CLASS = "text-foreground underline underline-offset-2";

/**
 * The refusal line of a library call: the MC-16 / MC-17 text with «Открыть» or «Открыть в редакторе» to the
 * record's page; a refusal without a library text (`model_not_connected`, `read_only` on a colleague's
 * record, `invalid_arguments`) keeps the general line. Whose the record is comes from the library list.
 */
function LibraryRefusalLine({ toolName, args, artifact }: { toolName: string; args: unknown; artifact: unknown }) {
  const t = useTranslations("errors");
  const call = libraryCallOf(toolName, args);
  // No list holds an empty id: a call without a record reads as one the list does not hold.
  const live = useLiveRecord(call.recordId ?? "");
  const refusal: RefusalText | null = describeRefusal(t, refusalReasonOf(artifact), {
    tool: toolName,
    kind: call.kind ?? live?.kind ?? "agent",
    model: refusedModel(artifact),
    recordId: call.recordId,
    own: live?.mine === true,
    company: live != null && live.author === null,
  });
  if (refusal === null) return <ReasonParagraph {...refusalOf(t, artifact)} />;
  const { action } = refusal;
  return (
    <ReasonParagraph
      hint={undefined}
      content={
        <>
          {refusal.text}
          {action !== null ? (
            <>
              {" "}
              <ShellLink href={recordPath(action.recordId)} className={LINK_CLASS}>
                {action.label}
              </ShellLink>
            </>
          ) : null}
        </>
      }
    />
  );
}

/**
 * The line under the header, shown even when collapsed: the refusal reason (MC-22), or the MC-10 way to
 * sign in to the server's account; other outcomes have none. A library call's refusal is `LibraryRefusalLine`.
 */
function reasonLine(
  t: ErrorsTranslator,
  tChat: ChatTranslator,
  outcome: CallOutcome,
  artifact: unknown,
  server: string,
): ReasonLine | null {
  if (outcome === "refused") return refusalOf(t, artifact);
  if (outcome === "auth_required") {
    return {
      content: tChat.rich("tool.authRequired", {
        server,
        link: (chunks) => (
          <Link href={ACCOUNT_PATH} className={LINK_CLASS}>
            {chunks}
          </Link>
        ),
      }),
      hint: undefined,
    };
  }
  return null;
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
  const format = useFormatter();
  const t = useTranslations("errors");
  const tChat = useTranslations("chat");
  const { tools } = useMessages();

  const outcome = outcomeOf(artifact);
  const look = OUTCOME_LOOK[outcome];
  const outcomeText = tChat(`tool.outcome.${outcome}`);
  const server = textField(artifact, "server");
  // A built-in tool's labels come from the catalogue (MC-9); an MCP tool's from its server, in the answer.
  const builtin = server === null ? builtinToolLabels(tools, toolName) : null;
  const toolTitle = server === null ? null : textField(artifact, "toolTitle");
  const toolLabel = builtin?.title ?? toolTitle ?? toolName;
  const argLabels = ArgLabelsSchema.safeParse(field(artifact, "argLabels"));
  const labels = builtin?.args ?? (argLabels.success ? argLabels.data : undefined);
  const runCode = isRunCode(toolName, server) ? runCodeView(args, labels) : null;
  /**
   * The second header line: a code run's description (code-execution UXRD, KD-4), or «name · server» of a
   * titled MCP tool; without a title the server stands in the first line.
   */
  const secondLine =
    runCode?.description ?? (toolTitle !== null && server !== null ? `${toolName} · ${server}` : null);
  const at =
    textField(artifact, "startedAt") ?? textField(artifact, "finishedAt") ?? messageCreatedAt.toISOString();
  const time = formatListTime(format, at);
  // The library line reads the library list from the shell, so other blocks never mount it.
  const libraryRefusal = outcome === "refused" && LIBRARY_TOOLS.has(toolName);
  const reason = libraryRefusal ? null : reasonLine(t, tChat, outcome, artifact, server ?? toolName);
  /** A code run that returned nothing shows «—» in place of its end (KD-5). */
  const shownResult = runCode !== null && (result === undefined || result === "") ? NO_RUN_VALUE : result;
  const resultText =
    look.showsResult && shownResult !== undefined
      ? typeof shownResult === "string"
        ? shownResult
        : JSON.stringify(shownResult, null, 2)
      : null;
  /** A successful code run's printed lines under its end (KD-3); absent when the script printed nothing. */
  const output = runCode !== null && look.showsResult ? textField(artifact, "output") : null;

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
        aria-label={tChat("tool.trigger", { tool: toolLabel, outcome: outcomeText, time })}
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
          {server !== null && secondLine === null ? (
            <span className="text-muted-foreground min-w-0 truncate text-xs">{server}</span>
          ) : null}
          <span className={cn("ms-auto shrink-0 text-xs whitespace-nowrap", look.tone)}>{outcomeText}</span>
          <time dateTime={at} className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {time}
          </time>
        </span>
        {secondLine !== null ? (
          <span
            data-slot="tool-fallback-second-line"
            title={secondLine}
            className="text-muted-foreground block h-4 w-full truncate ps-12 text-xs leading-4"
          >
            {secondLine}
          </span>
        ) : null}
      </CollapsibleTrigger>
      {libraryRefusal ? (
        <LibraryRefusalLine toolName={toolName} args={args} artifact={artifact} />
      ) : reason !== null ? (
        <ReasonParagraph {...reason} />
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
            label={tChat("tool.arguments")}
            rows={runCode?.rows ?? valueRows(args, labels)}
            script={runCode?.script}
            raw={argsText}
            disclosure
            density="data"
          />
          {resultText !== null ? (
            <ValueRows
              label={tChat("tool.result")}
              rows={flatRows(parsedResult(shownResult))}
              raw={resultText}
              disclosure={false}
              density="data"
            />
          ) : null}
          {output !== null && output !== "" ? (
            <ValueRows label={tChat("tool.scriptOutput")} rows={null} raw={output} disclosure={false} density="data" />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

export const ToolFallback = memo(ToolFallbackImpl);
ToolFallback.displayName = "ToolFallback";
