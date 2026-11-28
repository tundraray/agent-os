'use client';

import Link from 'next/link';
import { memo, type ReactNode } from 'react';
import { useFormatter, useMessages, useTranslations } from 'next-intl';
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
  PencilOffIcon,
  UnplugIcon,
  type LucideIcon,
} from 'lucide-react';
import {
  useAuiState,
  type ToolCallMessagePartComponent,
} from '@assistant-ui/react';
import {
  IdSchema,
  LIST_RECORDS_TOOL,
  MANAGE_SCHEDULE_TOOL,
  MEMORY_TOOLS,
  NOTEPAD_CREATE_TOOL,
  NOTEPAD_TOOLS,
  SCHEDULE_ACCESS_DROPPED_LINE,
  ScheduleToolActionSchema,
  START_AGENT_TOOL,
  START_DEEP_AGENT_TOOL,
  scriptNameOf,
  ToolCallStateSchema,
  TRY_SCRIPT_TOOL,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
  type ChatRecordTool,
  type RecordKind,
  type ToolOutcome,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import { z } from 'zod';
import {
  agentStatusGlyph,
  FadeSlot,
  StatusGlyph,
} from '@/components/agents/agent-status';
import { useLiveRecord, useRecordNamed } from '@/components/agents/run-card';
import { ValueRows } from '@/components/agents/value-rows';
import { ScheduleCard } from '@/components/schedules/schedule-card';
import { ShellLink } from '@/components/shell/shell-link';
import { refusalText } from '@/lib/access/access-texts';
import { NO_RUN_VALUE, runCodeView } from '@/lib/agents/run-code';
import { flatRows, valueRows } from '@/lib/agents/value-rows';
import {
  isRecordTool,
  RECORD_CHANGE_TOOLS,
  type ToolCallArtifact,
} from '@/lib/feed/to-feed';
import { toolCallLabels } from '@/i18n/builtin-name';
import type {
  AgentsTranslator,
  ChatTranslator,
  ErrorsTranslator,
} from '@/i18n/catalog';
import { formatListTime } from '@/i18n/formats';
import {
  describeRefusal,
  type RefusalText,
} from '@/lib/library/library-errors';
import { logger } from '@/lib/logger';
import { ACCOUNT_PATH, recordPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import {
  CollapsibleRoot as Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './collapsible-root';
import {
  SEARCH_MARK_CLASS,
  useCallMarkProps,
  useOpenOnMark,
} from './search-target';

/** The outcomes of tool-call.md: the finished ones and two of an open call. */
type CallOutcome = ToolOutcome | 'running' | 'awaiting_confirmation';

type OutcomeLook = { Icon: LucideIcon; tone: string; showsResult: boolean };

/** Icons and colour roles of the outcomes (tool-call.md, States); the MC-22 texts are `chat.tool.outcome`. */
const OUTCOME_LOOK: Record<CallOutcome, OutcomeLook> = {
  running: { ...agentStatusGlyph('working'), showsResult: false },
  success: { Icon: CircleCheckIcon, tone: 'text-success', showsResult: true },
  empty: { Icon: CircleIcon, tone: 'text-muted-foreground', showsResult: true },
  tool_error: {
    Icon: CircleXIcon,
    tone: 'text-destructive',
    showsResult: false,
  },
  transport_failure: {
    Icon: UnplugIcon,
    tone: 'text-destructive',
    showsResult: false,
  },
  refused: { Icon: BanIcon, tone: 'text-destructive', showsResult: false },
  auth_required: {
    Icon: KeyRoundIcon,
    tone: 'text-warning',
    showsResult: false,
  },
  awaiting_confirmation: {
    ...agentStatusGlyph('awaiting_confirmation'),
    showsResult: false,
  },
  rejected: {
    Icon: CircleMinusIcon,
    tone: 'text-muted-foreground',
    showsResult: false,
  },
  recorded: {
    Icon: PencilOffIcon,
    tone: 'text-muted-foreground',
    showsResult: false,
  },
  interrupted: {
    Icon: CircleStopIcon,
    tone: 'text-muted-foreground',
    showsResult: false,
  },
  unknown: {
    Icon: CircleQuestionMarkIcon,
    tone: 'text-warning',
    showsResult: false,
  },
};

const ArgLabelsSchema = z.record(z.string(), z.string());
const RecordedSchema = z.array(z.string()).min(1);
const MemoryArgsSchema = z.object({ description: z.string() });
const NotepadCreateArgsSchema = z.object({ title: z.string() });
/** The first line of a notepad tool's result on one document; `.` stops at its end (design-notepad.md, «Веб»). */
const NOTEPAD_RESULT_TITLE = /^Document \d+: (.*)/;

/**
 * The title of a notepad call's document (self-learning MC-13): `notepad_create`'s argument, the others' first
 * result line; null for the lists and before the result.
 */
function notepadTitle(
  toolName: string,
  args: unknown,
  result: unknown,
): string | null {
  if (toolName === NOTEPAD_CREATE_TOOL)
    return NotepadCreateArgsSchema.safeParse(args).data?.title ?? null;
  return typeof result === 'string'
    ? (NOTEPAD_RESULT_TITLE.exec(result)?.[1] ?? null)
    : null;
}

/** Values outside the built contract, each warned about once per page. */
const warnedValues = new Set<string>();

function warnOnce(field: string, value: unknown): void {
  const key = `${field}:${String(value)}`;
  if (warnedValues.has(key)) return;
  warnedValues.add(key);
  logger.warn('[web-feed] tool call carries a value outside the contract', {
    field,
    value: String(value),
  });
}

/** A field of the part's `artifact`, which assistant-ui types as `unknown`. */
function field(artifact: unknown, key: keyof ToolCallArtifact): unknown {
  if (typeof artifact !== 'object' || artifact === null) return undefined;
  const value: unknown = Reflect.get(artifact, key);
  return value;
}

function textField(
  artifact: unknown,
  key: keyof ToolCallArtifact,
): string | null {
  const value = field(artifact, key);
  return typeof value === 'string' ? value : null;
}

/**
 * The outcome of a call from the `artifact` toFeed puts on its part. A value the contract does not hold
 * reads as `unknown` and is warned about once.
 */
function outcomeOf(artifact: unknown): CallOutcome {
  const state = ToolCallStateSchema.safeParse(field(artifact, 'state'));
  if (!state.success) {
    warnOnce('state', field(artifact, 'state'));
    return 'unknown';
  }
  if (state.data === 'requested' || state.data === 'sending') return 'running';
  if (state.data === 'awaiting_confirmation') return 'awaiting_confirmation';
  const outcome = ToolOutcomeSchema.safeParse(field(artifact, 'outcome'));
  if (!outcome.success) {
    warnOnce('outcome', field(artifact, 'outcome'));
    return 'unknown';
  }
  return outcome.data;
}

const RefusalDetailSchema = z.object({ model: z.string() });

/** The refused model of a refusal by model: `refusalDetail.model` of the result, never the call's arguments. */
function refusedModel(artifact: unknown): string | null {
  const detail = RefusalDetailSchema.safeParse(
    field(artifact, 'refusalDetail'),
  );
  return detail.success ? detail.data.model : null;
}

function refusalReasonOf(artifact: unknown): ToolRefusalReason | null {
  const reason = ToolRefusalReasonSchema.safeParse(
    field(artifact, 'refusalReason'),
  );
  return reason.success ? reason.data : null;
}

type ReasonLine = { content: ReactNode };

/**
 * MC-10 or MC-22 text of a refusal (`refusalText`); a code the catalogue does not hold (or none) reads as
 * the platform's refusal, with nothing of the raw code shown.
 */
function refusalOf(t: ErrorsTranslator, artifact: unknown): ReasonLine {
  const reason = refusalReasonOf(artifact);
  const text =
    reason === null ? null : refusalText(t, reason, refusedModel(artifact));
  return { content: text ?? t('platformRefusal') };
}

/** The library's start tools: their refusals name the record (MC-16, MC-17; DC-02, RN-06). */
const LIBRARY_TOOLS = new Set<string>([
  START_AGENT_TOOL,
  START_DEEP_AGENT_TOOL,
]);

/**
 * The name a start call gives and the kind it starts (data-model design-agents.md, KD-5): `agent` of
 * `start_agent`, `deepAgent` of `start_deep_agent`; an empty name when the argument is not a string.
 */
function libraryCallOf(
  toolName: string,
  args: unknown,
): { name: string; kind: RecordKind } {
  const arg = (key: string): string => {
    const value: unknown =
      typeof args === 'object' && args !== null
        ? Reflect.get(args, key)
        : undefined;
    return typeof value === 'string' ? value : '';
  };
  return toolName === START_AGENT_TOOL
    ? { name: arg('agent'), kind: 'agent' }
    : { name: arg('deepAgent'), kind: 'deep_agent' };
}

function ReasonParagraph({ content }: ReasonLine) {
  return (
    <p
      data-slot="tool-fallback-reason"
      className="text-muted-foreground px-2 pb-1.5 ps-14 text-xs leading-4"
    >
      {content}
    </p>
  );
}

const LINK_CLASS = 'text-foreground underline underline-offset-2';

/**
 * The refusal line of a library call: the MC-16 / MC-17 text with «Открыть» to the page of the record its name
 * starts, found in the library list, which also says whose it is. A refusal without a library text
 * (`model_not_connected`, `invalid_arguments`) and a call no record answers — a temporary agent — keep the
 * general line.
 */
function LibraryRefusalLine({
  toolName,
  args,
  artifact,
}: {
  toolName: string;
  args: unknown;
  artifact: unknown;
}) {
  const t = useTranslations('errors');
  const call = libraryCallOf(toolName, args);
  const live = useRecordNamed(call.kind, call.name);
  const refusal: RefusalText | null =
    live == null
      ? null
      : describeRefusal(t, refusalReasonOf(artifact), {
          tool: toolName,
          kind: call.kind,
          model: refusedModel(artifact),
          recordId: live.id,
          own: live.mine,
        });
  if (refusal === null) return <ReasonParagraph {...refusalOf(t, artifact)} />;
  const { action } = refusal;
  return (
    <ReasonParagraph
      content={
        <>
          {refusal.text}
          {action !== null ? (
            <>
              {' '}
              <ShellLink
                href={recordPath(action.recordId)}
                className={LINK_CLASS}
              >
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
 * MC-23: a record tool's block names its record — «Чтение «{имя}»», «Создание «{имя}»» — by the name the feed
 * knows, else by the live library list; a record known by neither reads by the catalogue's title.
 */
function useRecordToolTitle(
  toolName: ChatRecordTool,
  args: unknown,
  artifact: unknown,
): string | null {
  const t = useTranslations('agents.recordTool');
  const recordId = IdSchema.safeParse(
    typeof args === 'object' && args !== null
      ? Reflect.get(args, 'recordId')
      : undefined,
  );
  // No list holds an empty id: a call without a record reads as one the list does not hold.
  const live = useLiveRecord(recordId.success ? recordId.data : '');
  if (toolName === LIST_RECORDS_TOOL) return t(LIST_RECORDS_TOOL);
  const name = textField(artifact, 'recordName') ?? live?.name ?? null;
  return name === null ? null : t(toolName, { name });
}

/** A record tool's block: the library list is read only here, so other blocks never subscribe to it. */
function RecordToolBlock(props: ToolBlockProps & { toolName: ChatRecordTool }) {
  const title = useRecordToolTitle(props.toolName, props.args, props.artifact);
  return <ToolBlock {...props} title={title} />;
}

/**
 * The line under the header, shown even when collapsed: the refusal reason (MC-22), or the MC-10 way to
 * sign in to the server's account; other outcomes have none. A library call's refusal is `LibraryRefusalLine`.
 * A record tool that changes a record reads its refusal as «Не сохранено:» and the platform's text as is (KD-4),
 * except an `unattended` one.
 */
function reasonLine(
  t: ErrorsTranslator,
  tChat: ChatTranslator,
  tAgents: AgentsTranslator,
  {
    outcome,
    artifact,
    server,
    toolName,
    result,
  }: {
    outcome: CallOutcome;
    artifact: unknown;
    server: string;
    toolName: string;
    result: unknown;
  },
): ReasonLine | null {
  // A schedule's run had no one to confirm the change: MC-2 for a record tool too, nothing was attempted (IM-03).
  if (outcome === 'refused' && refusalReasonOf(artifact) === 'unattended') {
    return refusalOf(t, artifact);
  }
  if (
    outcome === 'refused' &&
    RECORD_CHANGE_TOOLS.has(toolName) &&
    typeof result === 'string' &&
    result !== ''
  ) {
    return { content: tAgents('recordCard.notSaved', { reason: result }) };
  }
  if (outcome === 'refused') return refusalOf(t, artifact);
  if (outcome === 'auth_required') {
    return {
      content: tChat.rich('tool.authRequired', {
        server,
        link: (chunks) => (
          <Link href={ACCOUNT_PATH} className={LINK_CLASS}>
            {chunks}
          </Link>
        ),
      }),
    };
  }
  return null;
}

/** A result that is JSON text reads as its value; any other result stays as it is. */
function parsedResult(result: unknown): unknown {
  if (typeof result !== 'string') return result;
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
const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolCallId,
  toolName,
  args,
  argsText,
  result,
  artifact,
}) => {
  const props = {
    callId: toolCallId,
    toolName,
    args,
    argsText,
    result,
    artifact,
  };
  if (toolName === MANAGE_SCHEDULE_TOOL)
    return <ScheduleToolBlock {...props} />;
  return isRecordTool(toolName) ? (
    <RecordToolBlock {...props} toolName={toolName} />
  ) : (
    <ToolBlock {...props} />
  );
};

/** The first line of a `manage_schedule` result (chat-scheduling design-server.md, «Карточка результата в ленте»). */
const SCHEDULE_RESULT_TITLE = /^Schedule (\S+): (.+)$/;
const ScheduleActionArgsSchema = z.object({
  action: ScheduleToolActionSchema,
});

/** Calls whose result did not read as a schedule, each warned about once per page. */
const warnedScheduleCalls = new Set<string>();

/**
 * chat-scheduling KD-1: a successful `manage_schedule` call is its usual block with the schedule card under it; a
 * failed one is the block alone. A result whose first line is not `Schedule <id>: <name>` leaves the block alone too.
 */
function ScheduleToolBlock(props: ToolBlockProps) {
  const block = <ToolBlock {...props} />;
  if (outcomeOf(props.artifact) !== 'success') return block;
  const lines =
    typeof props.result === 'string' ? props.result.split('\n') : [];
  const title = SCHEDULE_RESULT_TITLE.exec(lines[0] ?? '');
  const action = ScheduleActionArgsSchema.safeParse(props.args).data?.action;
  if (title === null || action === undefined) {
    if (!warnedScheduleCalls.has(props.callId)) {
      warnedScheduleCalls.add(props.callId);
      // Only the action: the result and the arguments carry the schedule's instruction.
      logger.warn(
        '[web-feed] manage_schedule result does not name a schedule',
        {
          action: action ?? null,
        },
      );
    }
    return block;
  }
  return (
    <>
      {block}
      <ScheduleCard
        scheduleId={title[1]}
        name={title[2]}
        action={action}
        accessDropped={lines[1] === SCHEDULE_ACCESS_DROPPED_LINE}
      />
    </>
  );
}

type ToolBlockProps = {
  /** The call's id: an opened search match finds the block by it (KD-7). */
  callId: string;
  toolName: string;
  args: unknown;
  argsText: string;
  result: unknown;
  artifact: unknown;
  /** The block's own title (a record tool's, MC-23); the catalogue's or the server's when absent or null. */
  title?: string | null;
};

function ToolBlock({
  callId,
  toolName,
  args,
  argsText,
  result,
  artifact,
  title,
}: ToolBlockProps) {
  // The block an opened search match points at is expanded and marked (search-result.md, «Цель совпадения»).
  const [open, setOpen] = useOpenOnMark((mark) => mark.callId === callId);
  const markProps = useCallMarkProps(callId);
  const messageCreatedAt = useAuiState((s) => s.message.createdAt);
  const format = useFormatter();
  const t = useTranslations('errors');
  const tChat = useTranslations('chat');
  const tAgents = useTranslations('agents');
  const { tools } = useMessages();

  const outcome = outcomeOf(artifact);
  const look = OUTCOME_LOOK[outcome];
  const outcomeText = tChat(`tool.outcome.${outcome}`);
  const server = textField(artifact, 'server');
  const scriptName = scriptNameOf(toolName, server);
  const trial = server === null && toolName === TRY_SCRIPT_TOOL;
  const toolTitle =
    server !== null || scriptName !== null
      ? textField(artifact, 'toolTitle')
      : null;
  const sentLabels = ArgLabelsSchema.safeParse(field(artifact, 'argLabels'));
  const { title: catalogueTitle, args: labels } = toolCallLabels(tools, {
    tool: toolName,
    server,
    toolTitle,
    argLabels: sentLabels.success ? sentLabels.data : undefined,
  });
  const toolLabel = title ?? scriptName ?? catalogueTitle;
  const runCode = runCodeView(
    {
      tool: toolName,
      server,
      args,
      scriptCode: textField(artifact, 'scriptCode'),
    },
    tools,
  );
  const memoryDescription =
    server === null && MEMORY_TOOLS.some((name) => name === toolName)
      ? (MemoryArgsSchema.safeParse(args).data?.description ?? null)
      : null;
  const documentTitle =
    server === null && NOTEPAD_TOOLS.some((name) => name === toolName)
      ? notepadTitle(toolName, args, result)
      : null;
  /**
   * The second header line: a code run's description (code-execution UXRD, KD-4) or draft name, a saved
   * script's «скрипт агента · {описание}» (self-learning KD-4), a memory call's record
   * description or a notepad call's document title (self-learning MC-13), or «name · server» of a titled MCP
   * tool; without a title the server stands in the first line.
   */
  const secondLine =
    (scriptName !== null && toolTitle !== null
      ? tChat('tool.savedScript', { description: toolTitle })
      : null) ??
    runCode?.description ??
    memoryDescription ??
    documentTitle ??
    (toolTitle !== null && server !== null ? `${toolName} · ${server}` : null);
  const at =
    textField(artifact, 'startedAt') ??
    textField(artifact, 'finishedAt') ??
    messageCreatedAt.toISOString();
  const time = formatListTime(format, at);
  // The library line reads the library list from the shell, so other blocks never mount it.
  const libraryRefusal = outcome === 'refused' && LIBRARY_TOOLS.has(toolName);
  const reason = libraryRefusal
    ? null
    : reasonLine(t, tChat, tAgents, {
        outcome,
        artifact,
        server: server ?? toolName,
        toolName,
        result,
      });
  /** A code run that returned nothing shows «—» in place of its end (KD-5). */
  const shownResult =
    runCode !== null && (result === undefined || result === '')
      ? NO_RUN_VALUE
      : result;
  const resultText =
    look.showsResult && shownResult !== undefined
      ? typeof shownResult === 'string'
        ? shownResult
        : JSON.stringify(shownResult, null, 2)
      : null;
  /** A successful code run's printed lines under its end (KD-3); absent when the script printed nothing. */
  const output =
    runCode !== null && look.showsResult ? textField(artifact, 'output') : null;
  /** MC-10: the tools a code run in a training tree recorded and did not send; no line when there were none. */
  const recorded =
    RecordedSchema.safeParse(field(artifact, 'recorded')).data ?? null;

  return (
    <Collapsible
      data-slot="tool-fallback-root"
      data-outcome={outcome}
      {...markProps}
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'border-border my-1 w-full rounded-lg border',
        SEARCH_MARK_CLASS,
      )}
    >
      <CollapsibleTrigger
        data-slot="tool-fallback-trigger"
        aria-label={tChat('tool.trigger', {
          tool: toolLabel,
          outcome: outcomeText,
          time,
        })}
        className="group/trigger hover:bg-accent focus-visible:ring-ring flex w-full min-w-0 flex-col rounded-lg px-2 text-start text-sm outline-none focus-visible:ring-2"
      >
        <span className="flex h-8 w-full min-w-0 items-center gap-2 pointer-coarse:h-11">
          <ChevronRightIcon
            aria-hidden
            className="text-muted-foreground size-4 shrink-0 transition-transform duration-(--duration-panel) group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
          />
          <FadeSlot swapKey={outcome} className={look.tone}>
            <StatusGlyph Icon={look.Icon} spinning={outcome === 'running'} />
          </FadeSlot>
          <span
            className={cn(
              'text-foreground min-w-0 truncate',
              scriptName !== null && 'font-mono',
            )}
            title={toolLabel}
          >
            {toolLabel}
          </span>
          {server !== null && secondLine === null ? (
            <span className="text-muted-foreground min-w-0 truncate text-xs">
              {server}
            </span>
          ) : null}
          <span
            className={cn(
              'ms-auto shrink-0 text-xs whitespace-nowrap',
              look.tone,
            )}
          >
            {outcomeText}
          </span>
          <time
            dateTime={at}
            className="text-muted-foreground shrink-0 text-xs tabular-nums"
          >
            {time}
          </time>
        </span>
        {secondLine !== null ? (
          <span
            data-slot="tool-fallback-second-line"
            title={secondLine}
            className={cn(
              'text-muted-foreground block h-4 w-full truncate ps-12 text-xs leading-4',
              trial && 'font-mono',
            )}
          >
            {secondLine}
          </span>
        ) : null}
      </CollapsibleTrigger>
      {libraryRefusal ? (
        <LibraryRefusalLine
          toolName={toolName}
          args={args}
          artifact={artifact}
        />
      ) : reason !== null ? (
        <ReasonParagraph {...reason} />
      ) : null}
      <CollapsibleContent
        data-slot="tool-fallback-content"
        className={cn(
          'overflow-hidden',
          'data-open:animate-collapsible-down data-closed:animate-collapsible-up [--tw-duration:var(--duration-panel)] motion-reduce:animate-none',
        )}
      >
        <div className="flex flex-col gap-2 px-2 pt-1 pb-2">
          <ValueRows
            label={tChat('tool.arguments')}
            rows={runCode?.rows ?? valueRows(args, labels)}
            script={runCode?.script}
            raw={argsText}
            disclosure
            density="data"
          />
          {resultText !== null ? (
            <ValueRows
              label={tChat('tool.result')}
              rows={flatRows(parsedResult(shownResult))}
              raw={resultText}
              disclosure={false}
              density="data"
            />
          ) : null}
          {output !== null && output !== '' ? (
            <ValueRows
              label={tChat('tool.scriptOutput')}
              rows={null}
              raw={output}
              disclosure={false}
              density="data"
            />
          ) : null}
          {recorded !== null ? (
            <p className="text-muted-foreground flex items-start gap-1.5 text-xs leading-4">
              <PencilOffIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 break-words">
                {tChat('tool.recordedLine')}{' '}
                <span className="font-mono">{recorded.join(', ')}</span>
              </span>
            </p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export const ToolFallback = memo(ToolFallbackImpl);
ToolFallback.displayName = 'ToolFallback';
