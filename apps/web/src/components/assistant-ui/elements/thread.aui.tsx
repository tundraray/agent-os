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
import { TooltipIconButton } from "@/components/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { regenerateAfterError } from "@/lib/config";
import { focusAfterNewChat } from "@/lib/focus";
import { cn } from "@/lib/utils";
import {
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  ComposerPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
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
  RotateCwIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
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
 * `DeletedNotice`, when set, marks the thread as deleted elsewhere (E-8): the
 * composer is not rendered and a failed reply shows it instead of the error block.
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
};

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
}) => {
  const isNewChat = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot
        isEmpty={isNewChat && !historyPending}
        autoFocus={autoFocus}
        historyPending={historyPending}
      />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{
  isEmpty: boolean;
  autoFocus: boolean;
  historyPending: boolean;
}> = ({ isEmpty, autoFocus, historyPending }) => {
  const { Welcome = ThreadWelcome, DeletedNotice } = useContext(ThreadComponentsContext);

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
            {!DeletedNotice && <Composer autoFocus={autoFocus} sendBlocked={historyPending} />}
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

  if (isSpoken) return <SpokenMessage />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

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

const Composer: FC<{ autoFocus: boolean; sendBlocked: boolean }> = ({
  autoFocus,
  sendBlocked,
}) => {
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
          placeholder="Спросите что-нибудь…"
          className="aui-composer-input caret-primary placeholder:text-muted-foreground max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
          rows={1}
          autoFocus={autoFocus}
          enterKeyHint="send"
          aria-label="Сообщение"
          name="message"
          addAttachmentOnPaste={false}
          data-shell-focus="composer"
        />
        <ComposerAction sendBlocked={sendBlocked} />
      </div>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC<{ sendBlocked: boolean }> = ({ sendBlocked }) => {
  const { ComposerExtra } = useContext(ThreadComponentsContext);
  // The stop control only cancels the send while no run it could stop is going.
  const isSending = useAuiState(
    (s) =>
      s.composer.submission !== undefined &&
      !(s.thread.isRunning && s.thread.capabilities.cancel),
  );

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
        <AuiIf
          condition={(s) =>
            (!s.composer.canCancel ||
              (s.thread.voice !== undefined &&
                s.composer.submission === undefined)) &&
            !shouldShowComposerResume(s)
          }
        >
          <ComposerPrimitive.Send disabled={sendBlocked} render={<TooltipIconButton tooltip="Отправить" side="bottom" type="button" variant="default" size="icon" className="aui-composer-send size-7 rounded-full" aria-label="Отправить" />}><ArrowUpIcon className="aui-composer-send-icon size-4" /></ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={shouldShowComposerResume}>
          <ComposerPrimitive.Resume render={<TooltipIconButton tooltip="Продолжить генерацию" side="bottom" type="button" variant="default" size="icon" className="aui-composer-resume size-7 rounded-full" aria-label="Продолжить генерацию" />}><PlayIcon className="aui-composer-resume-icon size-4" /></ComposerPrimitive.Resume>
        </AuiIf>
        <AuiIf
          condition={(s) =>
            s.composer.canCancel &&
            (s.thread.voice === undefined ||
              s.composer.submission !== undefined)
          }
        >
          <ComposerPrimitive.Cancel render={<Button type="button" variant="default" size="icon" className="aui-composer-cancel size-7 rounded-full" aria-label={isSending ? "Отменить отправку" : "Остановить"} />}><SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" /></ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

const REGENERATE_CLASS =
  "pointer-coarse:h-11 active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100";

/**
 * TH-08 under a failed reply: fixed text only — never the server or model error. With the
 * `regenerateAfterError` switch on, the last reply gets «Перегенерировать» inside the block (D-14).
 * With the `DeletedNotice` slot set (E-8) the slot replaces the block.
 */
const MessageError: FC = () => {
  const { DeletedNotice } = useContext(ThreadComponentsContext);
  return (
    <MessagePrimitive.Error>
      {DeletedNotice ? <DeletedNotice /> : <ReplyErrorBlock />}
    </MessagePrimitive.Error>
  );
};

const ReplyErrorBlock: FC = () => {
  const textId = useId();
  return (
    <div
      data-slot="message-error"
      className="border-destructive-border bg-destructive-subtle mt-2 flex items-start gap-2 rounded-md border p-3 text-sm"
    >
      <TriangleAlertIcon aria-hidden className="text-destructive mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col items-start gap-2">
        <p id={textId} role="alert" className="text-foreground line-clamp-2">
          {regenerateAfterError
            ? "Не удалось получить ответ. Попробуйте перегенерировать."
            : "Не удалось получить ответ."}
        </p>
        {regenerateAfterError && (
          <AuiIf condition={(s) => s.message.isLast}>
            <ActionBarPrimitive.Reload
              aria-describedby={textId}
              onClick={focusAfterNewChat}
              render={<Button variant="outline" size="sm" className={REGENERATE_CLASS} />}
            >
              <RotateCwIcon aria-hidden />
              Перегенерировать
            </ActionBarPrimitive.Reload>
          </AuiIf>
        )}
      </div>
    </div>
  );
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
    TaskGroup: TaskGroupComponent,
  } = useContext(ThreadComponentsContext);
  const groupBy = TaskGroupComponent ? taskAwareGroupBy : messageGroupBy;
  const isBlank = useAuiState(isBlankReply);

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

const isGeneratingReply = (s: AssistantState) =>
  s.message.status?.type === "running";

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
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="group/message fade-in slide-in-from-bottom-1 animate-in motion-reduce:animate-none grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-(--composer-radius) px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts
            components={{ File: UserFilePart, Image: UserImagePart }}
          />
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
