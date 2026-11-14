"use client";

import {
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/elements/attachment.aui";
import { File, getFileHref } from "@/components/file";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui";
import { Image as MessageImage } from "@/components/image";
import { MarkdownText } from "@/components/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { AgentReport } from "@/components/agents/agent-report";
import { DecisionCard } from "@/components/agents/decision-card";
import { EventLine } from "@/components/agents/event-line";
import { InterruptButton } from "@/components/agents/interrupt-button";
import { QueueTray } from "@/components/agents/queue-tray";
import { RunCard } from "@/components/agents/run-card";
import { TooltipIconButton } from "@/components/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useFeed, useFeedSelector } from "@/lib/feed/feed-context";
import {
  controls,
  FEED_PART,
  trayEntries,
  type DecisionPartData,
  type EventPartData,
  type OptimisticEntry,
  type ReportPartData,
  type RunCardPartData,
} from "@/lib/feed/to-feed";
import { cn } from "@/lib/utils";
import {
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  ComposerPrimitive,
  type DataMessagePartComponent,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  AudioLinesIcon,
  CheckIcon,
  CopyIcon,
  MicIcon,
  PhoneIcon,
  SquareIcon,
  PlayIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FC,
  type FormEvent,
  type PropsWithChildren,
} from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

const DefaultToolGroup: FC<PropsWithChildren<{ group: ThreadGroupPart }>> = ({
  group,
  children,
}) => {
  const [open, setOpen] = useState(false);

  return (
    <ToolGroupRoot
      variant="ghost"
      open={open || group.counts.requiresAction > 0}
      onOpenChange={setOpen}
    >
      <ToolGroupTrigger
        count={group.indices.length}
        active={group.status.type === "running"}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

const shouldShowComposerResume = (s: AssistantState) =>
  !!s.thread.canResume && s.composer.type === "thread" && s.composer.isEmpty;

const reasoningDuration = (timing: ThreadGroupPart["timing"]) =>
  timing?.completedAt === undefined
    ? undefined
    : Math.round((timing.completedAt - timing.startedAt) / 1000);

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`. When `TaskGroup` is set, tool calls that carry a nested
 * conversation and have no registered UI render through it instead of the
 * tool group; without it they render like any other tool call.
 * `ComposerExtra` renders at the start of the composer's action row.
 * `DeletedNotice`, when set, marks the thread as deleted elsewhere (E-8): it
 * renders after the feed in place of the tray and the composer.
 * `FeedHeader` renders above the first message of the feed (the agent page's
 * meta line and inherited history). `TaskBrief`, when set, replaces the task's
 * text with the workflow brief under the caption «Бриф» (AV-03).
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  TaskGroup?: ComponentType<{ group: ThreadGroupPart }> | undefined;
  ComposerExtra?: ComponentType | undefined;
  DeletedNotice?: ComponentType | undefined;
  FeedHeader?: ComponentType | undefined;
  TaskBrief?: ComponentType | undefined;
};

const messageGroupBy = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});

type ThreadGroupKey =
  | "group-chainOfThought"
  | "group-reasoning"
  | "group-tool"
  | "group-task";

const TASK_GROUP_PATH: readonly ThreadGroupKey[] = [
  "group-chainOfThought",
  "group-task",
];

const taskAwareGroupBy = (
  part: Parameters<typeof messageGroupBy>[0],
  context?: Parameters<typeof messageGroupBy>[1],
): readonly ThreadGroupKey[] => {
  const path = messageGroupBy(part, context);
  return part.type === "tool-call" &&
    part.messages !== undefined &&
    path.length > 0 &&
    !context?.toolUIs?.[part.toolName]?.length
    ? TASK_GROUP_PATH
    : path;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
  /**
   * The thread the page shows is still resolving or loading its history: the feed is only the
   * skeleton, the composer stays docked and editable, sending is blocked until the history arrives.
   */
  historyPending?: boolean | undefined;
  /** The composer's placeholder: the conversation's by default, MC-12 on an agent page. */
  composerPlaceholder?: string | undefined;
};

const DEFAULT_PLACEHOLDER = "Спросите что-нибудь…";

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

/** TH-05: feed skeleton; fades in after 150 ms so fast loads do not flash. */
const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    aria-label="Загружаем беседу…"
    className="animate-in fade-in fill-mode-both flex flex-col gap-y-6 [animation-delay:150ms] [animation-duration:200ms] motion-reduce:animate-none"
  >
    <span className="sr-only">Загружаем беседу…</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
);

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
  historyPending = false,
  composerPlaceholder = DEFAULT_PLACEHOLDER,
}) => {
  const isNewChat = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot
        isEmpty={isNewChat && !historyPending}
        autoFocus={autoFocus}
        historyPending={historyPending}
        placeholder={composerPlaceholder}
      />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{
  isEmpty: boolean;
  autoFocus: boolean;
  historyPending: boolean;
  placeholder: string;
}> = ({ isEmpty, autoFocus, historyPending, placeholder }) => {
  const { Welcome = ThreadWelcome, DeletedNotice, FeedHeader } = useContext(ThreadComponentsContext);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--composer-bg" as string]:
          "color-mix(in oklab, var(--color-muted) 30%, transparent)",
        ["--composer-radius" as string]: "1rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth motion-reduce:scroll-auto"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "md:justify-center",
          )}
        >
          {historyPending ? (
            <ThreadHistorySkeleton />
          ) : (
            <>
              <AuiIf condition={isNewChatView}>
                <Welcome />
              </AuiIf>
              <AuiIf condition={isHistoryLoadingView}>
                <ThreadHistorySkeleton />
              </AuiIf>

              {FeedHeader && (
                <div data-slot="aui_feed-header" className="mb-6 flex flex-col gap-y-3 px-2">
                  <FeedHeader />
                </div>
              )}

              <ThreadLoadEarlier />

              <div
                data-slot="aui_message-group"
                className="mb-14 flex flex-col gap-y-6 empty:hidden"
              >
                <ThreadPrimitive.Messages>
                  {() => <ThreadMessage />}
                </ThreadPrimitive.Messages>
              </div>
            </>
          )}

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-[max(1.5rem,env(safe-area-inset-bottom))]",
              // Below 768 px the composer stays at the bottom even in an empty thread (D-10).
              isEmpty
                ? "max-md:sticky max-md:bottom-0 max-md:mt-auto"
                : "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            {!historyPending && <ThreadFollowupSuggestions />}
            {DeletedNotice ? (
              <DeletedNotice />
            ) : (
              <>
                <FeedTray />
                <Composer
                  autoFocus={autoFocus}
                  sendBlocked={historyPending}
                  placeholder={placeholder}
                />
              </>
            )}
            {!historyPending && (
              <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
                <ThreadSuggestions />
              </AuiIf>
            )}
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isSpoken = useAuiState((s) => s.message.metadata.modality === "voice");
  const isFeedPart = useAuiState((s) => feedKindOf(s) === "part");

  if (isSpoken) return <SpokenMessage />;
  if (isFeedPart) return <FeedPartMessage />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

/** `FeedMessageMeta.kind` of a feed message (lib/feed/to-feed.ts); undefined for any other runtime. */
const feedKindOf = (s: AssistantState): unknown => s.message.metadata.custom["kind"];

/**
 * MC-9, MC-10: the caption above a message or an answer. On a conversation the task is the first
 * message with no caption, an employee's message never has one; a message the employee did not write
 * names its source, and on an agent page the answer that ended a turn is «Отчёт» (AV-04).
 */
function sourceCaption(custom: Record<string, unknown>, onAgentPage: boolean): string | null {
  switch (custom["kind"]) {
    case "task":
      return onAgentPage ? "Задание" : null;
    case "parent": {
      if (custom["fromConversation"] === true) return "От беседы";
      const sender = custom["senderDescription"];
      // The feed knows the sender's description only for an agent's parent; MC-10 has no other wording.
      return typeof sender === "string" ? `От агента «${sender}»` : "От агента";
    }
    case "answer":
      return custom["report"] === true ? "Отчёт" : null;
    default:
      return null;
  }
}

const useSourceCaption = (): string | null => {
  const onAgentPage = useFeedSelector((state) => state.view?.kind === "agent", false);
  return useAuiState((s) => sourceCaption(s.message.metadata.custom, onAgentPage));
};

const SourceCaption: FC<{ text: string; className?: string }> = ({ text, className }) => (
  <p
    data-slot="aui_message-source"
    className={cn("text-muted-foreground text-xs leading-4 font-medium", className)}
  >
    {text}
  </p>
);

const RunCardPart: DataMessagePartComponent<RunCardPartData> = ({ data }) => (
  <RunCard data={data} />
);

const DecisionPart: DataMessagePartComponent<DecisionPartData> = ({ data }) => {
  const feed = useFeed();
  // Decision parts come only from a feed; a screen without its store has nothing to decide with.
  if (feed === null) return null;
  return (
    <DecisionCard
      confirmation={data.confirmation}
      byChat={data.byChat}
      onDecide={(approve, args) => feed.decide(data.confirmation.decisionId, approve, args)}
    />
  );
};

const ReportPart: DataMessagePartComponent<ReportPartData> = ({ data }) => (
  <AgentReport data={data} />
);

const EventPart: DataMessagePartComponent<EventPartData> = ({ data }) => (
  <EventLine data={data} />
);

/** The feed's `data-*` parts by name (spike S-1, e): each renders its own component. */
const FEED_PART_COMPONENTS = {
  data: {
    by_name: {
      [FEED_PART.runCard]: RunCardPart,
      [FEED_PART.decision]: DecisionPart,
      [FEED_PART.report]: ReportPart,
      [FEED_PART.event]: EventPart,
    },
  },
};

/**
 * A card, a report or an event line of the feed (UXRD Screen 1, «Раскладка»): in the prose column with
 * 16 px above and below. The feed spaces messages 24 px apart, so a block pulls 8 px in on each side;
 * a block right after another drops its top pull, so two blocks also stand 16 px apart.
 */
const FeedPartMessage: FC = () => (
  <MessagePrimitive.Root
    data-slot="aui_feed-part"
    data-feed-block=""
    className="fade-in animate-in -my-2 duration-150 motion-reduce:animate-none [[data-feed-block]+&]:mt-0"
  >
    <MessagePrimitive.Parts components={FEED_PART_COMPONENTS} />
  </MessagePrimitive.Root>
);

type VoiceRunPosition = "single" | "start" | "middle" | "end";

const useVoiceRunPosition = (): VoiceRunPosition =>
  useAuiState((s) => {
    const before =
      s.thread.messages[s.message.index - 1]?.metadata.modality === "voice";
    const after =
      s.thread.messages[s.message.index + 1]?.metadata.modality === "voice";
    if (before) return after ? "middle" : "end";
    return after ? "start" : "single";
  });

const SpokenText: TextMessagePartComponent = ({ text }) => (
  <p className="aui-spoken-message-text m-0">{text}</p>
);

const SpokenMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const position = useVoiceRunPosition();
  const isSpeaking = useAuiState(
    (s) =>
      s.message.role === "assistant" && s.message.status?.type === "running",
  );
  const opensExchange = position === "start" || position === "single";

  return (
    <MessagePrimitive.Root
      data-slot="aui_spoken-message-root"
      data-role={role}
      data-voice-run={position}
      className={cn(
        "aui-spoken-message bg-muted/40 mx-2 px-3 py-1.5 [contain-intrinsic-size:auto_48px] [content-visibility:auto]",
        position === "single" && "rounded-xl py-2",
        position === "start" && "rounded-t-xl pt-2",
        position === "middle" && "-mt-6",
        position === "end" && "-mt-6 rounded-b-xl pb-2",
      )}
    >
      {opensExchange && (
        <div
          data-slot="aui_spoken-exchange-header"
          className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs"
        >
          <PhoneIcon className="size-3" aria-hidden />
          <span>Голосовой разговор</span>
        </div>
      )}
      <div
        data-slot="aui_spoken-message-content"
        className="text-foreground flex items-start gap-2 text-sm leading-relaxed"
      >
        <span className="text-muted-foreground mt-1 shrink-0" aria-hidden>
          {role === "user" ? (
            <MicIcon className="size-3.5" />
          ) : (
            <AudioLinesIcon className="size-3.5" />
          )}
        </span>
        <span className="sr-only">
          {role === "user" ? "Вы сказали" : "Ассистент сказал"}
        </span>
        <div className="min-w-0 flex-1 wrap-break-word">
          <MessagePrimitive.Parts components={{ Text: SpokenText }} />
          {isSpeaking && (
            <span
              data-slot="aui_spoken-message-indicator"
              role="status"
              className="text-muted-foreground ms-1 animate-pulse font-sans motion-reduce:animate-none"
              aria-label="Ассистент говорит"
            >
              ●
            </span>
          )}
        </div>
        <SpokenActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const SpokenActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="always"
      className="aui-spoken-action-bar text-muted-foreground flex shrink-0 gap-1"
    >
      <ActionBarPrimitive.Copy render={<TooltipIconButton tooltip="Копировать" className="size-6" />}><AuiIf condition={(s) => s.message.isCopied}>
                      <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out motion-reduce:animate-none" />
                    </AuiIf><AuiIf condition={(s) => !s.message.isCopied}>
                      <CopyIcon className="animate-in zoom-in-75 fade-in duration-150 motion-reduce:animate-none" />
                    </AuiIf></ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
};

const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1']):not([disabled])";

const nextFocusable = (start: Element) => {
  for (
    let element = start.nextElementSibling;
    element;
    element = element.nextElementSibling
  ) {
    const target = element.matches(FOCUSABLE_SELECTOR)
      ? element
      : element.querySelector(FOCUSABLE_SELECTOR);
    if (target instanceof HTMLElement) return target;
  }
  return null;
};

const ThreadLoadEarlier: FC = () => {
  const visible = useAuiState(
    (s) => s.thread.hasEarlier || s.thread.isLoadingEarlier,
  );
  const loading = useAuiState((s) => s.thread.isLoadingEarlier);
  const slotRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<Element | null>(null);

  // The last page removes the button; a keyboard user on it continues from the
  // next control in tab order rather than from the document body.
  useLayoutEffect(() => {
    const focused = focusedRef.current;
    const slot = slotRef.current;
    if (visible || !focused || focused.isConnected || !slot) return;
    focusedRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    nextFocusable(slot)?.focus();
  }, [visible]);

  return (
    <div
      ref={slotRef}
      className="contents"
      onFocus={(event) => {
        focusedRef.current = event.target;
      }}
    >
      <span role="status" className="sr-only">
        {loading ? "Загружаем предыдущие сообщения…" : ""}
      </span>
      {visible && (
        <ThreadPrimitive.LoadEarlier render={<Button variant="ghost" size="sm" data-slot="aui_thread-load-earlier" className="aui-thread-load-earlier text-muted-foreground mb-6 self-center rounded-full" />}><span
                            className={cn(loading && "shimmer motion-reduce:animate-none")}
                          >
                            {loading ? "Загружаем предыдущие сообщения…" : "Показать предыдущие сообщения"}
                          </span></ThreadPrimitive.LoadEarlier>
      )}
    </div>
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom render={<TooltipIconButton tooltip="К последнему сообщению" variant="outline" className="aui-thread-scroll-to-bottom motion-reduce:transition-none dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible" />}><ArrowDownIcon /></ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col px-2">
      <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200 motion-reduce:animate-none">
        Чем могу помочь?
      </p>
      <p className="aui-thread-welcome-message-inner-2 text-muted-foreground fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-sm duration-200 motion-reduce:animate-none">
        Задайте вопрос, попросите текст или разбор задачи.
      </p>
    </div>
  );
};

// TH-03: one column below 640 px, a 2×2 grid from 640 px; the cards cascade in 40 ms apart.
const ThreadSuggestions: FC = () => {
  return (
    <div
      role="group"
      aria-label="Подсказки"
      className="aui-thread-welcome-suggestions grid w-full grid-cols-1 gap-2 sm:grid-cols-2 [&>*:nth-child(2)]:[animation-delay:40ms] [&>*:nth-child(3)]:[animation-delay:80ms] [&>*:nth-child(4)]:[animation-delay:120ms]"
    >
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <SuggestionPrimitive.Trigger
      send
      render={
        <button
          type="button"
          className="aui-thread-welcome-suggestion border-border hover:border-foreground/25 hover:bg-accent/50 focus-visible:ring-ring fade-in slide-in-from-bottom-2 animate-in fill-mode-both flex min-h-14 w-full flex-col justify-center rounded-xl border px-4 py-2.5 text-start transition-colors duration-200 outline-none focus-visible:ring-3 motion-reduce:animate-none motion-reduce:transition-none"
        />
      }
    >
      <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1 text-foreground text-sm font-medium" />{" "}
      <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 text-muted-foreground text-[13px] empty:hidden" />
    </SuggestionPrimitive.Trigger>
  );
};

// Enter submits the form (requestSubmit); a prevented submit skips the root's own send.
const preventSubmit = (event: FormEvent<HTMLFormElement>) =>
  event.preventDefault();

/** UXRD MC-27, verbatim. */
const SEND_FAILED = "Не удалось отправить сообщение. Попробуйте ещё раз.";

/** Failures whose text went back to the field: a remounted composer does not paste it again. */
const returnedFailures = new WeakSet<object>();

/**
 * KD-4: the server did not take the message — the field gets its text back (the library cleared it
 * before sending) and MC-27 stands under it until the next send. Text typed meanwhile stays after it.
 */
const useSendFailure = (): boolean => {
  const aui = useAui();
  const failure = useFeedSelector((state) => state.sendFailure, null);

  useEffect(() => {
    if (failure === null || returnedFailures.has(failure)) return;
    returnedFailures.add(failure);
    const typed = aui.composer.getState().text;
    aui.composer.setText(typed === "" ? failure.text : `${failure.text}\n${typed}`);
  }, [aui, failure]);

  return failure !== null;
};

/** CV-04: the queue tray of the screen's feed above the composer; nothing without a feed. */
const FeedTray: FC = () => (useFeed() === null ? null : <FeedQueueTray />);

const NO_OPTIMISTIC: readonly OptimisticEntry[] = [];

const FeedQueueTray: FC = () => {
  const view = useFeedSelector((state) => state.view, null);
  const optimistic = useFeedSelector((state) => state.optimistic, NO_OPTIMISTIC);
  const tray = useMemo(() => trayEntries(view, optimistic), [view, optimistic]);
  return <QueueTray tray={tray} />;
};

const Composer: FC<{ autoFocus: boolean; sendBlocked: boolean; placeholder: string }> = ({
  autoFocus,
  sendBlocked,
  placeholder,
}) => {
  const sendFailed = useSendFailure();
  const failureId = useId();

  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative flex w-full flex-col"
      onSubmit={sendBlocked ? preventSubmit : undefined}
    >
      {/* Attachments are hidden (D-04): no dropzone, pasting a file adds nothing. */}
      <div
        data-slot="aui_composer-shell"
        className="border-foreground/10 focus-within:border-foreground/25 flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] motion-reduce:transition-none"
      >
        <ComposerAttachments />
        <ComposerPrimitive.Input
          placeholder={placeholder}
          className="aui-composer-input caret-primary placeholder:text-muted-foreground max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
          rows={1}
          autoFocus={autoFocus}
          enterKeyHint="send"
          aria-label="Сообщение"
          aria-describedby={sendFailed ? failureId : undefined}
          name="message"
          addAttachmentOnPaste={false}
          data-shell-focus="composer"
        />
        <ComposerAction sendBlocked={sendBlocked} />
      </div>
      {sendFailed && (
        <p
          id={failureId}
          data-slot="aui_composer-send-failure"
          className="text-destructive mt-1 px-2.5 text-xs leading-4 font-medium"
        >
          {SEND_FAILED}
        </p>
      )}
    </ComposerPrimitive.Root>
  );
};

/**
 * KD-2 UXRD: «Прервать» next to «Отправить» while the agent works (`controls().interrupt`); a pending
 * decision, an idle agent and a screen without a feed have none.
 */
const FeedInterrupt: FC = () => {
  const feed = useFeed();
  const canInterrupt = useFeedSelector((state) => controls(state.view).interrupt, false);
  if (feed === null || !canInterrupt) return null;
  return <InterruptButton onInterrupt={(text) => feed.interrupt(text)} />;
};

/** «Отправить» stays available while the agent works (FR-16); stopping the agent is «Прервать». */
const ComposerAction: FC<{ sendBlocked: boolean }> = ({ sendBlocked }) => {
  const { ComposerExtra } = useContext(ThreadComponentsContext);

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="aui-composer-action-start flex items-center gap-1.5">
        {ComposerExtra && <ComposerExtra />}
      </div>
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate render={<TooltipIconButton tooltip="Голосовой ввод" side="bottom" type="button" variant="ghost" size="icon" className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full" aria-label="Начать голосовой ввод" />}><MicIcon className="aui-composer-dictate-icon size-4" /></ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation render={<TooltipIconButton tooltip="Остановить диктовку" side="bottom" type="button" variant="ghost" size="icon" className="aui-composer-stop-dictation text-destructive size-7 rounded-full" aria-label="Остановить диктовку" />}><SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current motion-reduce:animate-none" /></ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <FeedInterrupt />
        <AuiIf condition={(s) => !shouldShowComposerResume(s)}>
          <ComposerPrimitive.Send disabled={sendBlocked} render={<TooltipIconButton tooltip="Отправить" side="bottom" type="button" variant="default" size="icon" className="aui-composer-send size-7 rounded-full" aria-label="Отправить" />}><ArrowUpIcon className="aui-composer-send-icon size-4" /></ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={shouldShowComposerResume}>
          <ComposerPrimitive.Resume render={<TooltipIconButton tooltip="Продолжить генерацию" side="bottom" type="button" variant="default" size="icon" className="aui-composer-resume size-7 rounded-full" aria-label="Продолжить генерацию" />}><PlayIcon className="aui-composer-resume-icon size-4" /></ComposerPrimitive.Resume>
        </AuiIf>
      </div>
    </div>
  );
};

/**
 * TH-08 under a failed reply: fixed text only — never the server or model error, and no
 * regeneration (the server owns the run).
 */
const MessageError: FC = () => (
  <MessagePrimitive.Error>
    <ReplyErrorBlock />
  </MessagePrimitive.Error>
);

const ReplyErrorBlock: FC = () => (
  <div
    data-slot="message-error"
    className="border-destructive-border bg-destructive-subtle mt-2 flex items-start gap-2 rounded-md border p-3 text-sm"
  >
    <TriangleAlertIcon aria-hidden className="text-destructive mt-0.5 size-4 shrink-0" />
    <p role="alert" className="text-foreground line-clamp-2 min-w-0">
      Не удалось получить ответ.
    </p>
  </div>
);

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
    TaskGroup: TaskGroupComponent,
  } = useContext(ThreadComponentsContext);
  const groupBy = TaskGroupComponent ? taskAwareGroupBy : messageGroupBy;
  const isBlank = useAuiState(isBlankReply);
  const caption = useSourceCaption();

  const ACTION_BAR_PT = "pt-1.5";
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className={cn(
        "group/message fade-in slide-in-from-bottom-1 animate-in relative duration-150 motion-reduce:animate-none [contain-intrinsic-size:auto_200px] [content-visibility:auto]",
        !isBlank && "-mb-7.5 pb-7.5",
      )}
    >
      {isBlank ? (
        <MessageError />
      ) : (
        <>
          <div
            data-slot="aui_assistant-message-content"
            className="text-foreground px-2 leading-relaxed wrap-break-word"
          >
            {caption !== null && <SourceCaption text={caption} className="mb-1" />}
            <MessagePrimitive.GroupedParts groupBy={groupBy}>
              {({ part, children }) => {
                switch (part.type) {
                  case "group-chainOfThought":
                    return <div data-slot="aui_chain-of-thought">{children}</div>;
                  case "group-task":
                    return TaskGroupComponent ? (
                      <TaskGroupComponent group={part} />
                    ) : null;
                  case "group-tool":
                    if (ToolGroup) {
                      return <ToolGroup group={part}>{children}</ToolGroup>;
                    }
                    return (
                      <DefaultToolGroup group={part}>{children}</DefaultToolGroup>
                    );
                  case "group-reasoning": {
                    if (ReasoningGroup) {
                      return (
                        <ReasoningGroup group={part}>{children}</ReasoningGroup>
                      );
                    }
                    const running = part.status.type === "running";
                    return (
                      <ReasoningRoot streaming={running}>
                        <ReasoningTrigger
                          active={running}
                          duration={reasoningDuration(part.timing)}
                        />
                        <ReasoningContent aria-busy={running}>
                          <ReasoningText>{children}</ReasoningText>
                        </ReasoningContent>
                      </ReasoningRoot>
                    );
                  }
                  case "text":
                    return <MarkdownText />;
                  case "reasoning":
                    return <Reasoning {...part} />;
                  case "tool-call":
                    return part.toolUI ?? <ToolFallbackComponent {...part} />;
                  case "data":
                    return part.dataRendererUI;
                  case "file":
                    return (
                      <div data-slot="aui_assistant-message-file" className="py-1">
                        <MessageFile {...part} />
                      </div>
                    );
                  case "image":
                    return (
                      <div data-slot="aui_assistant-message-image" className="py-1">
                        <MessageImage {...part} />
                      </div>
                    );
                  case "indicator":
                    return (
                      <span
                        data-slot="aui_assistant-message-indicator"
                        className="animate-pulse font-sans motion-reduce:animate-none"
                        aria-label="Ассистент отвечает…"
                      >
                        {"●"}
                      </span>
                    );
                  default:
                    return null;
                }
              }}
            </MessagePrimitive.GroupedParts>
            <MessageError />
          </div>

          <div
            data-slot="aui_assistant-message-footer"
            className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
          >
            <AssistantActionBar />
          </div>
        </>
      )}
    </MessagePrimitive.Root>
  );
};

// A reply with no parts that is not being generated (e.g. the stub an error before the first token
// leaves) shows no row: only its error block, if any.
const isBlankReply = (s: AssistantState) =>
  s.message.parts.length === 0 && s.message.status?.type !== "running";

const hasVisibleText = (s: AssistantState) =>
  s.message.parts.some((part) => part.type === "text" && part.text.trim() !== "");

// The feed's draft is `complete` for the library (so «Отправить» stays open) and is still being written.
const isGeneratingReply = (s: AssistantState) =>
  s.message.status?.type === "running" || feedKindOf(s) === "draft";

/**
 * TH-10: the action bar stays rendered (and in Tab order) on every message. Only the last message
 * shows it at rest; earlier ones reveal it on hover or focus within the message, and a coarse
 * pointer always shows it. Hidden by opacity only — never display:none or visibility:hidden.
 */
const useActionBarVisibility = () => {
  const isLast = useAuiState((s) => s.message.isLast);
  return isLast
    ? undefined
    : "opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none";
};

const MessageCopy: FC<{ className?: string }> = ({ className }) => (
  <>
    <AuiIf condition={hasVisibleText}>
      <ActionBarPrimitive.Copy
        render={<TooltipIconButton tooltip="Копировать" className={className} />}
      >
        <AuiIf condition={(s) => s.message.isCopied}>
          <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out motion-reduce:animate-none" />
        </AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}>
          <CopyIcon className="animate-in zoom-in-75 fade-in duration-150 motion-reduce:animate-none" />
        </AuiIf>
      </ActionBarPrimitive.Copy>
    </AuiIf>
    <CopiedStatus />
  </>
);

/** Live region mounted before the copy so screen readers announce «Скопировано» reliably. */
const CopiedStatus: FC = () => {
  const isCopied = useAuiState((s) => s.message.isCopied);
  return (
    <span role="status" className="sr-only">
      {isCopied ? "Скопировано" : ""}
    </span>
  );
};

const AssistantActionBar: FC = () => {
  const visibility = useActionBarVisibility();
  return (
    <AuiIf condition={(s) => !isGeneratingReply(s)}>
      <ActionBarPrimitive.Root
        className={cn(
          "aui-assistant-action-bar-root text-muted-foreground -ms-1 flex gap-1",
          visibility,
        )}
      >
        <MessageCopy />
        <AuiIf condition={(s) => s.thread.capabilities.feedback}>
          <ActionBarPrimitive.FeedbackPositive render={<TooltipIconButton tooltip="Полезный ответ" className="data-[submitted=true]:bg-accent data-[submitted=true]:text-accent-foreground" />}><ThumbsUpIcon /></ActionBarPrimitive.FeedbackPositive>
          <ActionBarPrimitive.FeedbackNegative render={<TooltipIconButton tooltip="Неполезный ответ" className="data-[submitted=true]:bg-accent data-[submitted=true]:text-accent-foreground" />}><ThumbsDownIcon /></ActionBarPrimitive.FeedbackNegative>
        </AuiIf>
      </ActionBarPrimitive.Root>
    </AuiIf>
  );
};

const MessageFile: FileMessagePartComponent = (part) => {
  const image = part.mimeType.toLowerCase().startsWith("image/")
    ? getFileHref(part.data, part.mimeType, part.sourceType)
    : null;
  if (!image) return <File {...part} />;
  return (
    <MessageImage
      type="image"
      image={image}
      status={part.status}
      {...(part.filename !== undefined && { filename: part.filename })}
    />
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <MessageFile {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <MessageImage {...part} />
  </div>
);

const UserMessage: FC = () => {
  const { TaskBrief } = useContext(ThreadComponentsContext);
  const isTask = useAuiState((s) => feedKindOf(s) === "task");
  // AV-03: a workflow coordinator's task reads as its brief.
  const Brief = isTask ? TaskBrief : undefined;
  const sourceCaptionText = useSourceCaption();
  const caption = Brief ? "Бриф" : sourceCaptionText;
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="group/message fade-in slide-in-from-bottom-1 animate-in motion-reduce:animate-none grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      {caption !== null && (
        <SourceCaption text={caption} className="col-start-2 -mb-1 justify-self-end" />
      )}
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-(--composer-radius) px-4 py-2 wrap-break-word empty:hidden">
          {Brief ? (
            <Brief />
          ) : (
            <MessagePrimitive.Parts
              components={{ File: UserFilePart, Image: UserImagePart }}
            />
          )}
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  const visibility = useActionBarVisibility();
  return (
    <ActionBarPrimitive.Root
      className={cn(
        "aui-user-action-bar-root text-muted-foreground flex flex-col items-end",
        visibility,
      )}
    >
      <MessageCopy className="aui-user-action-copy" />
    </ActionBarPrimitive.Root>
  );
};
