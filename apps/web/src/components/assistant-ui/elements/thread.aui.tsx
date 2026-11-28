'use client';

import {
  ComposerAttachments,
  UserMessageAttachments,
} from '@/components/assistant-ui/elements/attachment.aui';
import {
  useAgentMention,
  type AgentMention,
} from '@/components/assistant-ui/elements/agent-mention';
import { ComposerActions } from '@/components/assistant-ui/elements/composer-actions';
import { TestRunFooter } from '@/components/assistant-ui/elements/test-run-footer';
import {
  TEST_RUN_ICON,
  TestRunNote,
  TestRunSubmit,
  useTestRunStart,
  type TestRunStart,
} from '@/components/assistant-ui/elements/test-run-start';
import { File, getFileHref } from '@/components/file';
import { ThreadFollowupSuggestions } from '@/components/assistant-ui/elements/follow-up-suggestions.aui';
import { Image as MessageImage } from '@/components/image';
import { MarkdownText } from '@/components/markdown-text';
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from '@/components/assistant-ui/elements/reasoning.aui';
import {
  alignInUpperThird,
  SEARCH_MARK_CLASS,
  SEARCH_MARK_USER_BUBBLE_CLASS,
  SEARCH_MARK_USER_ROOT_CLASS,
  SearchMarkProvider,
  UPPER_THIRD_CLASS,
  useFeedSearchMark,
  useMessageMarkProps,
  useOpenOnMark,
  type SearchMark,
} from '@/components/assistant-ui/elements/search-target';
import { ToolFallback } from '@/components/assistant-ui/elements/tool-fallback.aui';
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from '@/components/assistant-ui/elements/tool-group.aui';
import { AgentReport } from '@/components/agents/agent-report';
import {
  DecisionCard,
  OfferCard,
  PlanCard,
} from '@/components/agents/decision-card';
import { InstructionsCard } from '@/components/agents/instructions-card';
import { QuestionCard } from '@/components/agents/question-card';
import {
  EventLine,
  AnswerRefusedLine,
  NewDivider,
} from '@/components/agents/event-line';
import { InterruptButton } from '@/components/agents/interrupt-button';
import { AgentsStrip } from '@/components/agents/agents-strip';
import { QueueTray } from '@/components/agents/queue-tray';
import { RunCard, TestRunCard } from '@/components/agents/run-card';
import { ScheduleCard } from '@/components/schedules/schedule-card';
import { Chip, RecordLabel } from '@/components/library/record-label';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useShellServices } from '@/components/shell/shell-actions';
import { useFeed, useFeedSelector } from '@/lib/feed/feed-context';
import { useSeenMark } from '@/lib/feed/use-seen-mark';
import {
  canInterrupt,
  FEED_PART,
  feedSeqOf,
  newDividerSeq,
  stripAgents,
  trayEntries,
  windowStartOf,
  type UnreadRange,
  type DecisionPartData,
  type EventPartData,
  type OptimisticEntry,
  type AnswerRefusedPartData,
  type OfferPartData,
  type PlanPartData,
  type ReportPartData,
  type RunCardPartData,
  type ScheduleCardPartData,
  type TestRunCardPartData,
} from '@/lib/feed/to-feed';
import { useTranslations } from 'next-intl';
import { replyFailureText } from '@/lib/access/access-texts';
import { describeLibraryError } from '@/lib/library/library-errors';
import { focusShellTarget, type FocusTarget } from '@/lib/focus';
import { recordPath, schedulePath } from '@/lib/shell-route';
import { ShellLink } from '@/components/shell/shell-link';
import type { ChatTranslator, ErrorsTranslator } from '@/i18n/catalog';
import {
  NEW_THREAD_TARGET,
  type SeedChip,
  type SeedTarget,
} from '@/lib/threads/composer-seed';
import type { SendFailure } from '@/lib/threads/shell-status-store';
import { cn } from '@/lib/utils';
import {
  AGENTS_QUESTION_CONFIRMATION,
  ChipRecordSchema,
  IDENTITY_INSTRUCTIONS_CONFIRMATION,
  ScheduleMarkSchema,
  type ChipRecord,
  type DecisionRequest,
  type ScheduleMark,
} from '@agent-os/contracts';
import { useStore } from 'zustand';
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
  useThreadViewport,
} from '@assistant-ui/react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  AudioLinesIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  MicIcon,
  PhoneIcon,
  SquareIcon,
  PlayIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TriangleAlertIcon,
} from 'lucide-react';
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
  type ReactNode,
  type RefObject,
} from 'react';

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

const DefaultToolGroup: FC<PropsWithChildren<{ group: ThreadGroupPart }>> = ({
  group,
  children,
}) => {
  // The calls of the group, so a search target among them opens it (KD-7).
  const callIds = useAuiState((s) =>
    group.indices
      .map((index) => {
        const part = s.message.parts[index];
        return part?.type === 'tool-call' ? part.toolCallId : '';
      })
      .join('\n'),
  );
  const [open, setOpen] = useOpenOnMark(
    (mark) => mark.callId !== null && callIds.split('\n').includes(mark.callId),
  );

  return (
    <ToolGroupRoot
      variant="ghost"
      open={open || group.counts.requiresAction > 0}
      onOpenChange={setOpen}
    >
      <ToolGroupTrigger
        count={group.indices.length}
        active={group.status.type === 'running'}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

const shouldShowComposerResume = (s: AssistantState) =>
  !!s.thread.canResume && s.composer.type === 'thread' && s.composer.isEmpty;

const reasoningDuration = (timing: ThreadGroupPart['timing']) =>
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
 * `DeletedNotice`, when set, marks the thread as deleted elsewhere (E-8): it
 * renders after the feed in place of the tray and the composer.
 * `FeedHeader` renders above the first message of the feed (the agent page's
 * meta line and inherited history). `TaskBrief`, when set, replaces the task's
 * text with the deep agent brief under the caption «Задание» (AV-03, deep-agents MC-22).
 * `Feed`, when set, takes the place of the whole feed — header, earlier entries
 * and messages — while the tray and the composer stay (a deep agent's tab
 * «Задачи», deep-agents DA-04).
 * `UserActions` adds buttons before «Копировать» in the action bar of a user message, `AssistantActions` — after it
 * in the action bar of an answer; `UserMessageBody` wraps a user message's bubble and its action bar and may put something in
 * their place (the conversation's «Изменить», improvements IM-13). Without them a message has only «Копировать».
 */
export type ThreadComponents = {
  UserActions?: ComponentType | undefined;
  AssistantActions?: ComponentType | undefined;
  UserMessageBody?: ComponentType<{ children: ReactNode }> | undefined;
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
  ReasoningGroup?:
    ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
  TaskGroup?: ComponentType<{ group: ThreadGroupPart }> | undefined;
  DeletedNotice?: ComponentType | undefined;
  FeedHeader?: ComponentType | undefined;
  TaskBrief?: ComponentType | undefined;
  Feed?: ComponentType | undefined;
};

const messageGroupBy = groupPartByType({
  reasoning: ['group-chainOfThought', 'group-reasoning'],
  'tool-call': ['group-chainOfThought', 'group-tool'],
  'standalone-tool-call': [],
});

type ThreadGroupKey =
  'group-chainOfThought' | 'group-reasoning' | 'group-tool' | 'group-task';

const TASK_GROUP_PATH: readonly ThreadGroupKey[] = [
  'group-chainOfThought',
  'group-task',
];

const taskAwareGroupBy = (
  part: Parameters<typeof messageGroupBy>[0],
  context?: Parameters<typeof messageGroupBy>[1],
): readonly ThreadGroupKey[] => {
  const path = messageGroupBy(part, context);
  return part.type === 'tool-call' &&
    part.messages !== undefined &&
    path.length > 0 &&
    !context?.toolUIs?.[part.toolName]?.length
    ? TASK_GROUP_PATH
    : path;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  /**
   * The thread the page shows is still resolving or loading its history: the feed is only the
   * skeleton, the composer stays docked and editable, sending is blocked until the history arrives.
   */
  historyPending?: boolean | undefined;
  /** The composer's placeholder: the conversation's by default, MC-12 on an agent page. */
  composerPlaceholder?: string | undefined;
  /**
   * The conversation's `composerSeed` target (custom-agents KD-5): its id, or `NEW_THREAD_TARGET` on `/`.
   * The composer takes the target's template text once and shows its chip; without it — no seed.
   */
  seedTarget?: SeedTarget | undefined;
  /**
   * Without `seedTarget`: the `composerSeed` target whose template text the composer takes once — no «+» and no chip
   * (the side chat's quote, improvements UXRD IM-05).
   */
  textTarget?: SeedTarget | undefined;
  /** The composer's focus target: 'composer' by default, the side chat's own field beside the main one. */
  focusTarget?: ComposerFocusTarget | undefined;
};

type ComposerFocusTarget = Extract<FocusTarget, 'composer' | 'aside-composer'>;

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
const ThreadHistorySkeleton: FC = () => {
  const t = useTranslations('chat');
  return (
    <div
      data-slot="aui_thread-history-skeleton"
      role="status"
      aria-label={t('historyLoading')}
      className="animate-in fade-in fill-mode-both flex flex-col gap-y-6 [animation-delay:150ms] [animation-duration:200ms] motion-reduce:animate-none"
    >
      <span className="sr-only">{t('historyLoading')}</span>
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
};

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  historyPending = false,
  composerPlaceholder,
  seedTarget,
  textTarget,
  focusTarget = 'composer',
}) => {
  const t = useTranslations('chat');
  const isNewChat = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot
        isEmpty={isNewChat && !historyPending}
        historyPending={historyPending}
        placeholder={composerPlaceholder ?? t('placeholder')}
        seedTarget={seedTarget}
        textTarget={textTarget}
        focusTarget={focusTarget}
      />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{
  isEmpty: boolean;
  historyPending: boolean;
  placeholder: string;
  seedTarget: SeedTarget | undefined;
  textTarget: SeedTarget | undefined;
  focusTarget: ComposerFocusTarget;
}> = ({
  isEmpty,
  historyPending,
  placeholder,
  seedTarget,
  textTarget,
  focusTarget,
}) => {
  const {
    Welcome = ThreadWelcome,
    DeletedNotice,
    FeedHeader,
    Feed,
  } = useContext(ThreadComponentsContext);
  const training = useFeedSelector(
    (state) => state.view?.training ?? null,
    null,
  );
  const t = useTranslations('chat.testRun');
  const feedRef = useRef<HTMLDivElement>(null);
  const mark = useFeedSearchMark(feedRef, historyPending);
  const { apiClient } = useShellServices();
  const unread = useSeenMark(useFeed(), apiClient);
  const windowStart = useFeedSelector(
    (state) => (state.view === null ? null : windowStartOf(state.view)),
    null,
  );
  const dividerSeq = useAuiState((s) =>
    newDividerSeq(s.thread.messages, unread, windowStart),
  );
  useOpenOnNewDivider({
    feedRef,
    unread,
    dividerSeq,
    windowStart,
    mark,
    historyPending,
  });

  return (
    <SearchMarkProvider value={mark}>
      <NewDividerContext.Provider value={dividerSeq}>
        <ThreadPrimitive.Root
          className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
          style={{
            ['--composer-bg' as string]:
              'color-mix(in oklab, var(--color-muted) 30%, transparent)',
            ['--composer-radius' as string]: '1rem',
            ['--composer-padding' as string]: '8px',
          }}
        >
          <ThreadPrimitive.Viewport
            turnAnchor="top"
            // Off by default with a top anchor: a card appended after the turn (a plan, a decision) is scrolled into view
            // unless the person has scrolled up; during a run the anchor still holds.
            autoScroll
            data-slot="aui_thread-viewport"
            className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth motion-reduce:scroll-auto"
          >
            <div
              ref={feedRef}
              className={cn(
                'mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4',
                isEmpty && 'md:justify-center',
              )}
            >
              {Feed ? (
                <div data-slot="aui_feed-replacement" className="mb-6 px-2">
                  <Feed />
                </div>
              ) : historyPending ? (
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
                    <div
                      data-slot="aui_feed-header"
                      className="mb-6 flex flex-col gap-y-3 px-2"
                    >
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
                  'aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-[max(1.5rem,env(safe-area-inset-bottom))]',
                  // Below 768 px the composer stays at the bottom even in an empty thread (D-10).
                  isEmpty
                    ? 'max-md:sticky max-md:bottom-0 max-md:mt-auto'
                    : 'sticky bottom-0 mt-auto rounded-t-(--composer-radius)',
                )}
              >
                <ThreadScrollToBottom />
                {!historyPending && <ThreadFollowupSuggestions />}
                {DeletedNotice ? (
                  <DeletedNotice />
                ) : training?.run != null ? (
                  <TestRunFooter
                    run={training.run}
                    composer={
                      <>
                        <FeedTray />
                        <Composer
                          sendBlocked={historyPending}
                          placeholder={t(
                            training.run.phase === 'result'
                              ? 'placeholderResult'
                              : 'placeholderDialog',
                          )}
                          chip={null}
                        />
                      </>
                    }
                  />
                ) : training !== null ? (
                  <TrainingLine
                    root={training.isRoot}
                    testRun={training.testRun}
                  />
                ) : (
                  <>
                    <FeedTray />
                    {seedTarget === undefined ? (
                      <Composer
                        sendBlocked={historyPending}
                        placeholder={placeholder}
                        chip={null}
                        textTarget={textTarget}
                        focusTarget={focusTarget}
                      />
                    ) : (
                      <SeededComposer
                        sendBlocked={historyPending}
                        placeholder={placeholder}
                        target={seedTarget}
                      />
                    )}
                  </>
                )}
                {!historyPending && (
                  <AuiIf
                    condition={(s) => isNewChatView(s) && s.composer.isEmpty}
                  >
                    <ThreadSuggestions />
                  </AuiIf>
                )}
              </ThreadPrimitive.ViewportFooter>
            </div>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </NewDividerContext.Provider>
    </SearchMarkProvider>
  );
};

/** The `seq` of the message the «Новое» divider stands before; null — no divider. */
const NewDividerContext = createContext<number | null>(null);

const NEW_DIVIDER_SELECTOR = '[data-slot="feed-divider"][data-variant="new"]';

/**
 * improvements Flow 3: a conversation with unread messages opens on the «Новое» divider in the upper third, once per
 * opening, with the search target's alignment. A search target wins: its mark stops this alignment and keeps it off.
 * Only the window the conversation opened with aligns (live-feed KD-3, AC-07.3): a divider that an earlier window
 * brings in leaves the feed where it is.
 */
function useOpenOnNewDivider({
  feedRef,
  unread,
  dividerSeq,
  windowStart,
  mark,
  historyPending,
}: {
  feedRef: RefObject<HTMLDivElement | null>;
  unread: UnreadRange | null;
  dividerSeq: number | null;
  windowStart: number | null;
  mark: SearchMark | null;
  historyPending: boolean;
}): void {
  const alignedFor = useRef<UnreadRange | null>(null);
  const openedWith = useRef<{ range: UnreadRange; start: number | null }>(null);
  useEffect(() => {
    if (unread !== null && openedWith.current?.range !== unread)
      openedWith.current = { range: unread, start: windowStart };
    if (
      unread === null ||
      dividerSeq === null ||
      mark !== null ||
      historyPending ||
      alignedFor.current === unread ||
      openedWith.current?.start !== windowStart
    )
      return;
    const feed = feedRef.current;
    const divider =
      feed?.querySelector<HTMLElement>(NEW_DIVIDER_SELECTOR) ?? null;
    if (feed === null || divider === null) return;
    alignedFor.current = unread;
    return alignInUpperThird(divider, feed);
  }, [feedRef, unread, dividerSeq, windowStart, mark, historyPending]);
}

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isSpoken = useAuiState((s) => s.message.metadata.modality === 'voice');
  const isFeedPart = useAuiState((s) => feedKindOf(s) === 'part');
  const dividerSeq = useContext(NewDividerContext);
  const afterDivider = useAuiState(
    (s) => dividerSeq !== null && feedSeqOf(s.message.id) === dividerSeq,
  );

  const message = isSpoken ? (
    <SpokenMessage />
  ) : isFeedPart ? (
    <FeedPartMessage />
  ) : role === 'user' ? (
    <UserMessage />
  ) : (
    <AssistantMessageComponent />
  );
  if (!afterDivider) return message;
  return (
    <>
      <NewDivider className={UPPER_THIRD_CLASS} />
      {message}
    </>
  );
};

/** `FeedMessageMeta.kind` of a feed message (lib/feed/to-feed.ts); undefined for any other runtime. */
const feedKindOf = (s: AssistantState): unknown =>
  s.message.metadata.custom['kind'];

/**
 * MC-9, MC-10 (the task captions — custom-agents MC-21): the caption above a message or an answer. On a conversation the task is the first
 * message with no caption, an employee's message never has one; a message the employee did not write
 * names its source, and on an agent page the answer that ended a turn is «Отчёт» (AV-04).
 */
function sourceCaption(
  t: ChatTranslator,
  custom: Record<string, unknown>,
  onAgentPage: boolean,
): string | null {
  switch (custom['kind']) {
    case 'task':
      return onAgentPage ? t('caption.assignment') : null;
    case 'parent': {
      if (custom['fromConversation'] === true) return t('caption.fromChat');
      const sender = custom['senderDescription'];
      // The feed knows the sender's description only for an agent's parent; MC-10 has no other wording.
      return typeof sender === 'string'
        ? t('caption.fromAgent', { sender })
        : t('caption.fromAgentUnnamed');
    }
    case 'answer':
      return custom['report'] === true ? t('caption.report') : null;
    default:
      return null;
  }
}

const useSourceCaption = (): string | null => {
  const t = useTranslations('chat');
  const onAgentPage = useFeedSelector(
    (state) => state.view?.kind === 'agent',
    false,
  );
  return useAuiState((s) =>
    sourceCaption(t, s.message.metadata.custom, onAgentPage),
  );
};

const SourceCaption: FC<{ text: string; className?: string }> = ({
  text,
  className,
}) => (
  <p
    data-slot="aui_message-source"
    className={cn(
      'text-muted-foreground text-xs leading-4 font-medium',
      className,
    )}
  >
    {text}
  </p>
);

/** SH-07: «По расписанию «{имя}»» with the clock, the name a link to the schedule; «· вручную» for «Запустить сейчас». */
const ScheduleCaption: FC<{ mark: ScheduleMark; className?: string }> = ({
  mark,
  className,
}) => {
  const t = useTranslations('chat');
  return (
    <p
      data-slot="aui_message-source"
      className={cn(
        'text-muted-foreground flex items-center gap-1 text-xs leading-4 font-medium',
        className,
      )}
    >
      <ClockIcon aria-hidden className="size-3.5 shrink-0" />
      <span>
        {t.rich(mark.manual ? 'caption.scheduleManual' : 'caption.schedule', {
          name: mark.name,
          link: (chunks) => (
            <ShellLink
              href={schedulePath(mark.scheduleId)}
              className="hover:text-foreground underline underline-offset-2"
            >
              {chunks}
            </ShellLink>
          ),
        })}
      </span>
    </p>
  );
};

const RunCardPart: DataMessagePartComponent<RunCardPartData> = ({ data }) => (
  <RunCard data={data} />
);

const DecisionPart: DataMessagePartComponent<DecisionPartData> = ({ data }) => {
  const feed = useFeed();
  // Decision parts come only from a feed; a screen without its store has nothing to decide with.
  if (feed === null) return null;
  const onDecide = (decision: DecisionRequest): Promise<void> =>
    feed.decide(data.confirmation.decisionId, decision);
  // Each kind mounts its own card (agent-guidance KD-1); the others are the decision card's variants.
  if (data.confirmation.kind === AGENTS_QUESTION_CONFIRMATION)
    return (
      <QuestionCard
        confirmation={data.confirmation}
        byChat={data.byChat}
        onDecide={onDecide}
      />
    );
  if (data.confirmation.kind === IDENTITY_INSTRUCTIONS_CONFIRMATION)
    return (
      <InstructionsCard
        confirmation={data.confirmation}
        saved={data.saved}
        onDecide={onDecide}
      />
    );
  return (
    <DecisionCard
      confirmation={data.confirmation}
      byChat={data.byChat}
      saved={data.saved}
      onDecide={onDecide}
    />
  );
};

const OfferPart: DataMessagePartComponent<OfferPartData> = ({ data }) => (
  <OfferCard data={data} />
);

const PlanPart: DataMessagePartComponent<PlanPartData> = ({ data }) => (
  <PlanCard data={data} />
);

const TestRunCardPart: DataMessagePartComponent<TestRunCardPartData> = ({
  data,
}) => <TestRunCard data={data} />;

const ScheduleCardPart: DataMessagePartComponent<ScheduleCardPartData> = ({
  data,
}) => <ScheduleCard {...data} />;

const ReportPart: DataMessagePartComponent<ReportPartData> = ({ data }) => (
  <AgentReport data={data} />
);

const EventPart: DataMessagePartComponent<EventPartData> = ({ data }) => (
  <EventLine data={data} />
);

const AnswerRefusedPart: DataMessagePartComponent<AnswerRefusedPartData> = ({
  data,
}) => <AnswerRefusedLine data={data} />;

/** The feed's `data-*` parts by name (spike S-1, e): each renders its own component. */
const FEED_PART_COMPONENTS = {
  data: {
    by_name: {
      [FEED_PART.runCard]: RunCardPart,
      [FEED_PART.decision]: DecisionPart,
      [FEED_PART.report]: ReportPart,
      [FEED_PART.event]: EventPart,
      [FEED_PART.answerRefused]: AnswerRefusedPart,
      [FEED_PART.offer]: OfferPart,
      [FEED_PART.plan]: PlanPart,
      [FEED_PART.testRunCard]: TestRunCardPart,
      [FEED_PART.scheduleCard]: ScheduleCardPart,
    },
  },
};

/**
 * A card, a report or an event line of the feed (UXRD Screen 1, «Раскладка»): in the prose column with
 * 16 px above and below. The feed spaces messages 24 px apart, so a block pulls 8 px in on each side;
 * a block right after another drops its top pull, so two blocks also stand 16 px apart.
 */
const FeedPartMessage: FC = () => {
  const markProps = useMessageMarkProps();
  return (
    <MessagePrimitive.Root
      data-slot="aui_feed-part"
      data-feed-block=""
      {...markProps}
      className={cn(
        'fade-in animate-in relative -my-2 duration-150 motion-reduce:animate-none [[data-feed-block]+&]:mt-0',
        SEARCH_MARK_CLASS,
      )}
    >
      <MessagePrimitive.Parts components={FEED_PART_COMPONENTS} />
    </MessagePrimitive.Root>
  );
};

type VoiceRunPosition = 'single' | 'start' | 'middle' | 'end';

const useVoiceRunPosition = (): VoiceRunPosition =>
  useAuiState((s) => {
    const before =
      s.thread.messages[s.message.index - 1]?.metadata.modality === 'voice';
    const after =
      s.thread.messages[s.message.index + 1]?.metadata.modality === 'voice';
    if (before) return after ? 'middle' : 'end';
    return after ? 'start' : 'single';
  });

const SpokenText: TextMessagePartComponent = ({ text }) => (
  <p className="aui-spoken-message-text m-0">{text}</p>
);

const SpokenMessage: FC = () => {
  const t = useTranslations('chat');
  const role = useAuiState((s) => s.message.role);
  const position = useVoiceRunPosition();
  const isSpeaking = useAuiState(
    (s) =>
      s.message.role === 'assistant' && s.message.status?.type === 'running',
  );
  const opensExchange = position === 'start' || position === 'single';
  const markProps = useMessageMarkProps();

  return (
    <MessagePrimitive.Root
      data-slot="aui_spoken-message-root"
      data-role={role}
      data-voice-run={position}
      {...markProps}
      className={cn(
        'aui-spoken-message bg-muted/40 mx-2 px-3 py-1.5 [contain-intrinsic-size:auto_48px] [content-visibility:auto]',
        SEARCH_MARK_CLASS,
        position === 'single' && 'rounded-xl py-2',
        position === 'start' && 'rounded-t-xl pt-2',
        position === 'middle' && '-mt-6',
        position === 'end' && '-mt-6 rounded-b-xl pb-2',
      )}
    >
      {opensExchange && (
        <div
          data-slot="aui_spoken-exchange-header"
          className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs"
        >
          <PhoneIcon className="size-3" aria-hidden />
          <span>{t('voice.header')}</span>
        </div>
      )}
      <div
        data-slot="aui_spoken-message-content"
        className="text-foreground flex items-start gap-2 text-sm leading-relaxed"
      >
        <span className="text-muted-foreground mt-1 shrink-0" aria-hidden>
          {role === 'user' ? (
            <MicIcon className="size-3.5" />
          ) : (
            <AudioLinesIcon className="size-3.5" />
          )}
        </span>
        <span className="sr-only">
          {role === 'user' ? t('voice.userSaid') : t('voice.assistantSaid')}
        </span>
        <div className="min-w-0 flex-1 wrap-break-word">
          <MessagePrimitive.Parts components={{ Text: SpokenText }} />
          {isSpeaking && (
            <span
              data-slot="aui_spoken-message-indicator"
              role="status"
              className="text-muted-foreground ms-1 animate-pulse font-sans motion-reduce:animate-none"
              aria-label={t('voice.speaking')}
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
  const t = useTranslations('chat');
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="always"
      className="aui-spoken-action-bar text-muted-foreground flex shrink-0 gap-1"
    >
      <ActionBarPrimitive.Copy
        render={<TooltipIconButton tooltip={t('copy')} className="size-6" />}
      >
        <AuiIf condition={(s) => s.message.isCopied}>
          <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out motion-reduce:animate-none" />
        </AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}>
          <CopyIcon className="animate-in zoom-in-75 fade-in duration-150 motion-reduce:animate-none" />
        </AuiIf>
      </ActionBarPrimitive.Copy>
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

const LOAD_EARLIER_SELECTOR = '[data-slot="aui_thread-load-earlier"]';

/**
 * MC-41 «Показать предыдущие сообщения» (live-feed UXRD LF-01). A failed window shows MC-1 with «Повторить» in its
 * place, focus on «Повторить»; the retry asks the library again, so the button comes back with its loading caption.
 */
const ThreadLoadEarlier: FC = () => {
  const t = useTranslations('chat');
  const aui = useAui();
  const { announcer } = useShellServices();
  const loading = useAuiState((s) => s.thread.isLoadingEarlier);
  const failed =
    useFeedSelector((state) => state.earlierFailed, false) && !loading;
  const visible = useAuiState(
    (s) => s.thread.hasEarlier || s.thread.isLoadingEarlier,
  );
  const slotRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<Element | null>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const retriedRef = useRef(false);

  // The last page removes the button; a keyboard user on it continues from the
  // next control in tab order rather than from the document body.
  useLayoutEffect(() => {
    const focused = focusedRef.current;
    const slot = slotRef.current;
    if (visible || !focused || focused.isConnected || !slot) return;
    focusedRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    // The focus moves to the first loaded entry without scrolling: the feed has just been held in place.
    nextFocusable(slot)?.focus({ preventScroll: true });
  }, [visible]);

  // UXRD §Accessibility: focus goes to «Повторить» on a failure and back to the button while the retry loads.
  useLayoutEffect(() => {
    if (failed) {
      retryRef.current?.focus();
      return;
    }
    if (!loading || !retriedRef.current) return;
    retriedRef.current = false;
    slotRef.current?.querySelector<HTMLElement>(LOAD_EARLIER_SELECTOR)?.focus();
  }, [failed, loading]);

  useEffect(() => {
    if (loading) announcer.getState().announce('announce.loadingEarlier');
  }, [loading, announcer]);

  if (failed)
    return (
      <div
        ref={slotRef}
        role="status"
        data-slot="aui_thread-load-earlier-failed"
        className="text-muted-foreground mb-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 self-center text-sm"
      >
        <span>{t('loadEarlierFailed')}</span>
        <Button
          ref={retryRef}
          variant="ghost"
          size="sm"
          className="rounded-full"
          onClick={() => {
            retriedRef.current = true;
            void aui.thread.loadEarlier();
          }}
        >
          {t('loadEarlierRetry')}
        </Button>
      </div>
    );

  return (
    <div
      ref={slotRef}
      className="contents"
      onFocus={(event) => {
        focusedRef.current = event.target;
      }}
    >
      {visible && (
        <ThreadPrimitive.LoadEarlier
          render={
            <Button
              variant="ghost"
              size="sm"
              data-slot="aui_thread-load-earlier"
              className="aui-thread-load-earlier text-muted-foreground mb-6 self-center rounded-full"
            />
          }
        >
          <span className={cn(loading && 'shimmer motion-reduce:animate-none')}>
            {loading ? t('loadingEarlier') : t('loadEarlier')}
          </span>
        </ThreadPrimitive.LoadEarlier>
      )}
    </div>
  );
};

const ThreadScrollToBottom: FC = () => {
  const t = useTranslations('chat');
  return (
    <ThreadPrimitive.ScrollToBottom
      render={
        <TooltipIconButton
          tooltip={t('scrollToBottom')}
          variant="outline"
          className="aui-thread-scroll-to-bottom motion-reduce:transition-none dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
        />
      }
    >
      <ArrowDownIcon />
    </ThreadPrimitive.ScrollToBottom>
  );
};

/** The shell's greeting (`shell.welcome`) for a thread that is given no `Welcome` slot. */
const ThreadWelcome: FC = () => {
  const t = useTranslations('shell.welcome');
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col px-2">
      <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200 motion-reduce:animate-none">
        {t('title')}
      </p>
      <p className="aui-thread-welcome-message-inner-2 text-muted-foreground fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-sm duration-200 motion-reduce:animate-none">
        {t('hint')}
      </p>
    </div>
  );
};

// TH-03: one column below 640 px, a 2×2 grid from 640 px; the cards cascade in 40 ms apart.
const ThreadSuggestions: FC = () => {
  const t = useTranslations('chat');
  return (
    <div
      role="group"
      aria-label={t('suggestions')}
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
      <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1 text-foreground text-sm font-medium" />{' '}
      <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 text-muted-foreground text-[13px] empty:hidden" />
    </SuggestionPrimitive.Trigger>
  );
};

/** Failures whose text went back to the field: a remounted composer does not paste it again. */
const returnedFailures = new WeakSet<object>();

/**
 * KD-4: the server did not take the message — the field gets its text back (the library cleared it
 * before sending) and the failure line stands under it until the next send: MC-16 for a library
 * refusal (custom-agents Flow 2), MC-27 otherwise. Text typed meanwhile stays after it.
 * `newThreadFailure` — the failure of a new conversation's first message: that conversation was removed,
 * so the composer without a feed shows it.
 */
const useSendFailure = (newThreadFailure: SendFailure | null): ReactNode => {
  const aui = useAui();
  const t = useTranslations('errors');
  const tChat = useTranslations('chat');
  const failure = useFeedSelector(
    (state) => state.sendFailure,
    newThreadFailure,
  );

  useEffect(() => {
    if (failure === null || returnedFailures.has(failure)) return;
    returnedFailures.add(failure);
    const typed = aui.composer.getState().text;
    aui.composer.setText(
      typed === '' ? failure.text : `${failure.text}\n${typed}`,
    );
  }, [aui, failure]);

  if (failure === null) return null;
  // UXRD MC-27 when the library has no text for the cause.
  return (
    describeLibraryError(t, failure.cause, failure.context)?.text ??
    tChat('sendFailed')
  );
};

/** Chips already announced (MC-19): a remounted composer, or the chip following a new conversation, stays quiet. */
const announcedChips = new WeakSet<SeedChip>();

/**
 * custom-agents KD-5, CH-01: the composer of a conversation takes its target's template text once and
 * shows its chip until an accepted send, «✕» or a new chip; a new chip is announced (MC-19) and puts
 * its hint in the field (MC-20). Focus is put in the field by whoever put the seed (`useInChat`).
 */
const SeededComposer: FC<{
  sendBlocked: boolean;
  placeholder: string;
  target: SeedTarget;
}> = ({ sendBlocked, placeholder, target }) => {
  const t = useTranslations('chat');
  const { composerSeed, announcer, status } = useShellServices();
  const newThreadFailure = useStore(
    status,
    (state) => state.newThreadSendFailure,
  );
  const chip = useStore(
    composerSeed,
    (state) => state.chips.get(target) ?? null,
  );
  const action = chip !== null && 'action' in chip ? chip : null;
  const record = chip === null || 'action' in chip ? null : chip;
  const testRun = useTestRunStart(target, action);
  const mention = useAgentMention(target);
  useEffect(() => {
    if (chip === null || announcedChips.has(chip)) return;
    announcedChips.add(chip);
    const { announce } = announcer.getState();
    if ('action' in chip) announce('announce.testRunInComposer');
    else announce('announce.chipInComposer', { name: chip.name });
  }, [announcer, chip]);

  const removeChip = (): void => {
    composerSeed.clear(target);
    // The live region must not keep announcing a chip that is gone.
    announcer.setState({ queue: [] });
    focusShellTarget('composer');
  };

  return (
    <Composer
      sendBlocked={sendBlocked}
      placeholder={
        action !== null
          ? t(
              target === NEW_THREAD_TARGET
                ? 'composer.testRun.placeholderNew'
                : 'composer.testRun.placeholderThread',
            )
          : record === null
            ? placeholder
            : t('chipPlaceholder', { kind: record.kind, name: record.name })
      }
      newThreadFailure={newThreadFailure}
      textTarget={target}
      actions={<ComposerActions target={target} />}
      mention={mention}
      chip={
        action !== null ? (
          <Chip
            icon={TEST_RUN_ICON}
            name={t('composer.testRun.name')}
            onRemove={removeChip}
            className="self-start"
          />
        ) : record === null ? null : (
          <RecordLabel
            chip={record}
            variant="chip"
            onRemove={removeChip}
            className="self-start"
          />
        )
      }
      onRemoveChip={chip === null ? undefined : removeChip}
      testRun={action === null ? null : testRun}
    />
  );
};

/** The composer takes its target's template text once, when it appears (custom-agents KD-5). */
function useSeedText(target: SeedTarget | undefined): void {
  const aui = useAui();
  const { composerSeed } = useShellServices();
  const textWaiting = useStore(
    composerSeed,
    (state) => target !== undefined && state.texts.has(target),
  );
  useEffect(() => {
    if (!textWaiting || target === undefined) return;
    const text = composerSeed.takeText(target);
    if (text !== null) aui.composer.setText(text);
  }, [aui, composerSeed, target, textWaiting]);
}

/**
 * CV-04: the queue tray of the screen's feed above the composer, and above it a conversation's strip «Агенты беседы»
 * (improvements IM-11), 8 px apart; nothing without a feed.
 */
const FeedTray: FC = () =>
  useFeed() === null ? null : (
    <div className="flex flex-col gap-2 empty:hidden">
      <FeedAgentsStrip />
      <FeedQueueTray />
    </div>
  );

/** An agent page's view gives no agents: the strip is the conversation's only. */
const FeedAgentsStrip: FC = () => {
  const view = useFeedSelector((state) => state.view, null);
  const agents = useMemo(() => stripAgents(view), [view]);
  return <AgentsStrip agents={agents} />;
};

/**
 * Self-learning TR-01, MC-10: a training's conversation and its replays take no message. The root's line carries
 * «Стоп» while the training works, which stops the root, and says the training is over once it is not. A test run's
 * replay says it is the check's.
 */
const TrainingLine: FC<{ root: boolean; testRun: boolean }> = ({
  root,
  testRun,
}) => {
  const t = useTranslations('chat.training');
  const feed = useFeed();
  const working = useFeedSelector((state) => canInterrupt(state.view), false);
  const [stopFailed, setStopFailed] = useState(false);
  const stop = () => {
    setStopFailed(false);
    // `command` has logged the refusal.
    void feed?.stop().catch(() => setStopFailed(true));
  };
  return (
    <div className="flex flex-col gap-1 px-2">
      <div className="text-muted-foreground flex min-h-9 items-center justify-between gap-2 text-sm leading-5">
        <p>
          {root && !working
            ? t('ended')
            : t(testRun ? 'testRunReadOnly' : 'readOnly')}
        </p>
        {root && working && (
          <Button variant="outline" size="sm" onClick={stop}>
            <SquareIcon aria-hidden />
            {t('stop')}
          </Button>
        )}
      </div>
      {stopFailed && (
        <p role="alert" className="text-destructive text-xs leading-4">
          {t('stopFailed')}
        </p>
      )}
    </div>
  );
};

const NO_OPTIMISTIC: readonly OptimisticEntry[] = [];

const FeedQueueTray: FC = () => {
  const view = useFeedSelector((state) => state.view, null);
  const optimistic = useFeedSelector(
    (state) => state.optimistic,
    NO_OPTIMISTIC,
  );
  const tray = useMemo(() => trayEntries(view, optimistic), [view, optimistic]);
  return <QueueTray tray={tray} />;
};

const Composer: FC<{
  sendBlocked: boolean;
  placeholder: string;
  chip: ReactNode;
  /** The start of the action row: «+» where a chip is supported. */
  actions?: ReactNode;
  /** The `@` list of agents (improvements IM-12): where «+» is; elsewhere `@` is a plain character. */
  mention?: AgentMention;
  newThreadFailure?: SendFailure | null;
  /** Backspace in the empty field removes the chip (UXRD KD-2); without a chip — none. */
  onRemoveChip?: () => void;
  /** The action chip stands: the form starts a test run instead of sending a message. */
  testRun?: TestRunStart | null;
  /** The `composerSeed` target whose template text the field takes once. */
  textTarget?: SeedTarget | undefined;
  focusTarget?: ComposerFocusTarget;
}> = ({
  sendBlocked,
  placeholder,
  chip,
  actions,
  mention,
  newThreadFailure = null,
  onRemoveChip,
  testRun = null,
  textTarget,
  focusTarget = 'composer',
}) => {
  const aui = useAui();
  const t = useTranslations('chat');
  useSeedText(textTarget);
  const sendFailure = useSendFailure(newThreadFailure);
  const scrollToBottom = useThreadViewport((state) => state.scrollToBottom);
  const failure = testRun === null ? sendFailure : testRun.failure;
  const sendFailed = failure !== null;
  const failureId = useId();
  const noteId = useId();
  const describedBy = [sendFailed && failureId, testRun !== null && noteId]
    .filter(Boolean)
    .join(' ');

  /**
   * Every submit of this form comes here: Enter (ComposerPrimitive.Input calls `form.requestSubmit()`) and the
   * send button alike. assistant-ui's own send runs after this handler only when the submit is not prevented, so
   * with the action chip the field starts a test run and never posts a message (KD-2, Invariant 2).
   */
  const submit = (event: FormEvent<HTMLFormElement>) => {
    if (sendBlocked && testRun === null) {
      event.preventDefault();
      return;
    }
    // The feed has no library run, so nothing brings a person who scrolled up back down: their own send does, and
    // from there the viewport follows the answer again.
    scrollToBottom();
    if (testRun !== null) {
      event.preventDefault();
      testRun.submit(aui.composer.getState().text);
    }
  };

  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative flex w-full flex-col"
      onSubmit={submit}
    >
      {mention?.list}
      {/* Attachments are hidden (D-04): no dropzone, pasting a file adds nothing. */}
      <div
        data-slot="aui_composer-shell"
        className="border-foreground/10 focus-within:border-foreground/25 flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] motion-reduce:transition-none"
      >
        <ComposerAttachments />
        {chip}
        <ComposerPrimitive.Input
          placeholder={placeholder}
          className="aui-composer-input caret-primary placeholder:text-muted-foreground max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
          rows={1}
          autoFocus={false}
          enterKeyHint="send"
          aria-label={t('composer.message')}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          name="message"
          addAttachmentOnPaste={false}
          data-shell-focus={focusTarget}
          disabled={testRun?.pending}
          {...mention?.fieldProps}
          onKeyDown={(event) => {
            // A key of the open `@` list is not the field's: Enter chooses instead of sending.
            if (mention?.onKeyDown(event) === true) return;
            if (
              event.key === 'Backspace' &&
              onRemoveChip !== undefined &&
              aui.composer.getState().text === ''
            )
              onRemoveChip();
          }}
        />
        <ComposerAction
          sendBlocked={sendBlocked}
          actions={actions}
          testRun={testRun}
        />
      </div>
      {sendFailed && (
        <p
          id={failureId}
          role="alert"
          data-slot="aui_composer-send-failure"
          className="text-destructive mt-1 px-2.5 text-xs leading-4 font-medium"
        >
          {failure}
        </p>
      )}
      {testRun !== null && (
        <TestRunNote
          id={noteId}
          target={testRun.target}
          pending={testRun.pending}
        />
      )}
    </ComposerPrimitive.Root>
  );
};

/**
 * KD-2 UXRD: «Прервать» next to «Отправить» while the agent works (`canInterrupt`); a pending
 * decision, an idle agent and a screen without a feed have none.
 */
const FeedInterrupt: FC = () => {
  const feed = useFeed();
  const interruptible = useFeedSelector(
    (state) => canInterrupt(state.view),
    false,
  );
  if (feed === null || !interruptible) return null;
  return <InterruptButton onInterrupt={() => feed.interrupt()} />;
};

/**
 * «Отправить» stays available while the agent works (FR-16); stopping the agent is «Прервать». With the action
 * chip a submit button «Создать и проверить» stands in its place.
 */
const ComposerAction: FC<{
  sendBlocked: boolean;
  actions: ReactNode;
  testRun: TestRunStart | null;
}> = ({ sendBlocked, actions, testRun }) => {
  const t = useTranslations('chat');

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="aui-composer-action-start flex items-center gap-1.5">
        {actions}
      </div>
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate
              render={
                <TooltipIconButton
                  tooltip={t('composer.dictate')}
                  side="bottom"
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full"
                  aria-label={t('composer.startDictation')}
                />
              }
            >
              <MicIcon className="aui-composer-dictate-icon size-4" />
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation
              render={
                <TooltipIconButton
                  tooltip={t('composer.stopDictation')}
                  side="bottom"
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                  aria-label={t('composer.stopDictation')}
                />
              }
            >
              <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current motion-reduce:animate-none" />
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <FeedInterrupt />
        <AuiIf condition={(s) => !shouldShowComposerResume(s)}>
          {testRun !== null ? (
            <TestRunSubmit target={testRun.target} pending={testRun.pending} />
          ) : (
            <ComposerPrimitive.Send
              disabled={sendBlocked}
              render={
                <TooltipIconButton
                  tooltip={t('composer.send')}
                  side="bottom"
                  type="button"
                  variant="default"
                  size="icon"
                  className="aui-composer-send size-7 rounded-full"
                  aria-label={t('composer.send')}
                />
              }
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </ComposerPrimitive.Send>
          )}
        </AuiIf>
        <AuiIf condition={shouldShowComposerResume}>
          <ComposerPrimitive.Resume
            render={
              <TooltipIconButton
                tooltip={t('composer.resume')}
                side="bottom"
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-resume size-7 rounded-full"
                aria-label={t('composer.resume')}
              />
            }
          >
            <PlayIcon className="aui-composer-resume-icon size-4" />
          </ComposerPrimitive.Resume>
        </AuiIf>
      </div>
    </div>
  );
};

/**
 * TH-08 under a failed reply: a fixed text by the root's failure reason (MC-11) — never the server or
 * model error text, and no regeneration (the server owns the run).
 */
const MessageError: FC = () => (
  <MessagePrimitive.Error>
    <ReplyErrorBlock />
  </MessagePrimitive.Error>
);

/** The text of a reply error: by the `ReplyErrorData` toFeed puts on the message, or the generic one. */
function replyErrorText(t: ErrorsTranslator, error: unknown): string {
  if (typeof error !== 'object' || error === null)
    return replyFailureText(t, null, null);
  const reason: unknown = Reflect.get(error, 'reason');
  const model: unknown = Reflect.get(error, 'model');
  return replyFailureText(
    t,
    typeof reason === 'string' ? reason : null,
    typeof model === 'string' ? model : null,
  );
}

const ReplyErrorBlock: FC = () => {
  const t = useTranslations('errors');
  const error = useAuiState((s) =>
    s.message.status?.type === 'incomplete'
      ? s.message.status.error
      : undefined,
  );
  return (
    <div
      data-slot="message-error"
      className="border-destructive-border bg-destructive-subtle mt-2 flex items-start gap-2 rounded-md border p-3 text-sm"
    >
      <TriangleAlertIcon
        aria-hidden
        className="text-destructive mt-0.5 size-4 shrink-0"
      />
      <p role="alert" className="text-foreground line-clamp-2 min-w-0">
        {replyErrorText(t, error)}
      </p>
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
  const t = useTranslations('chat');
  const groupBy = TaskGroupComponent ? taskAwareGroupBy : messageGroupBy;
  const isBlank = useAuiState(isBlankReply);
  const caption = useSourceCaption();
  const markProps = useMessageMarkProps();

  const ACTION_BAR_PT = 'pt-1.5';
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      {...markProps}
      className={cn(
        'group/message fade-in slide-in-from-bottom-1 animate-in relative duration-150 motion-reduce:animate-none [contain-intrinsic-size:auto_200px] [content-visibility:auto]',
        // Marked: the band ends 16 px under the action bar, 8 px short of the next message (the feed's 24 px gap), as
        // it starts 8 px above the text; padding and margin still cancel out, so the layout stays.
        !isBlank &&
          '-mb-7.5 pb-7.5 data-search-target:-mb-4 data-search-target:pb-4',
        SEARCH_MARK_CLASS,
        // The band reaches 8 px above the text, as the card marks have; the negative margin keeps the layout.
        'data-search-target:-mt-2 data-search-target:pt-2',
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
            {caption !== null && (
              <SourceCaption text={caption} className="mb-1" />
            )}
            <MessagePrimitive.GroupedParts groupBy={groupBy}>
              {({ part, children }) => {
                switch (part.type) {
                  case 'group-chainOfThought':
                    return (
                      <div data-slot="aui_chain-of-thought">{children}</div>
                    );
                  case 'group-task':
                    return TaskGroupComponent ? (
                      <TaskGroupComponent group={part} />
                    ) : null;
                  case 'group-tool':
                    if (ToolGroup) {
                      return <ToolGroup group={part}>{children}</ToolGroup>;
                    }
                    return (
                      <DefaultToolGroup group={part}>
                        {children}
                      </DefaultToolGroup>
                    );
                  case 'group-reasoning': {
                    if (ReasoningGroup) {
                      return (
                        <ReasoningGroup group={part}>{children}</ReasoningGroup>
                      );
                    }
                    const running = part.status.type === 'running';
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
                  case 'text':
                    return <MarkdownText />;
                  case 'reasoning':
                    return <Reasoning {...part} />;
                  case 'tool-call':
                    return part.toolUI ?? <ToolFallbackComponent {...part} />;
                  case 'data':
                    return part.dataRendererUI;
                  case 'file':
                    return (
                      <div
                        data-slot="aui_assistant-message-file"
                        className="py-1"
                      >
                        <MessageFile {...part} />
                      </div>
                    );
                  case 'image':
                    return (
                      <div
                        data-slot="aui_assistant-message-image"
                        className="py-1"
                      >
                        <MessageImage {...part} />
                      </div>
                    );
                  case 'indicator':
                    return (
                      <span
                        data-slot="aui_assistant-message-indicator"
                        className="animate-pulse font-sans motion-reduce:animate-none"
                        aria-label={t('replying')}
                      >
                        {'●'}
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
            className={cn('ms-2 flex items-center', ACTION_BAR_HEIGHT)}
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
  s.message.parts.length === 0 && s.message.status?.type !== 'running';

const hasVisibleText = (s: AssistantState) =>
  s.message.parts.some(
    (part) => part.type === 'text' && part.text.trim() !== '',
  );

// The feed's draft is `complete` for the library (so «Отправить» stays open) and is still being written.
const isGeneratingReply = (s: AssistantState) =>
  s.message.status?.type === 'running' || feedKindOf(s) === 'draft';

/**
 * TH-10: the action bar stays rendered (and in Tab order) on every message. Only the last message
 * shows it at rest; earlier ones reveal it on hover or focus within the message, and a coarse
 * pointer always shows it. Hidden by opacity only — never display:none or visibility:hidden.
 */
const useActionBarVisibility = () => {
  const isLast = useAuiState((s) => s.message.isLast);
  return isLast
    ? undefined
    : 'opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none';
};

const MessageCopy: FC<{ className?: string }> = ({ className }) => {
  const t = useTranslations('chat');
  return (
    <>
      <AuiIf condition={hasVisibleText}>
        <ActionBarPrimitive.Copy
          render={
            <TooltipIconButton tooltip={t('copy')} className={className} />
          }
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
};

/** «Скопировано» goes to the shell's only live region (UXRD, «Объявления»). */
const CopiedStatus: FC = () => {
  const { announcer } = useShellServices();
  const isCopied = useAuiState((s) => s.message.isCopied);
  useEffect(() => {
    if (isCopied) announcer.getState().announce('announce.copied');
  }, [isCopied, announcer]);
  return null;
};

const AssistantActionBar: FC = () => {
  const t = useTranslations('chat');
  const { AssistantActions } = useContext(ThreadComponentsContext);
  const visibility = useActionBarVisibility();
  return (
    <AuiIf condition={(s) => !isGeneratingReply(s)}>
      <ActionBarPrimitive.Root
        className={cn(
          'aui-assistant-action-bar-root text-muted-foreground -ms-1 flex gap-1',
          visibility,
        )}
      >
        <MessageCopy />
        {AssistantActions !== undefined && <AssistantActions />}
        <AuiIf condition={(s) => s.thread.capabilities.feedback}>
          <ActionBarPrimitive.FeedbackPositive
            render={
              <TooltipIconButton
                tooltip={t('feedback.positive')}
                className="data-[submitted=true]:bg-accent data-[submitted=true]:text-accent-foreground"
              />
            }
          >
            <ThumbsUpIcon />
          </ActionBarPrimitive.FeedbackPositive>
          <ActionBarPrimitive.FeedbackNegative
            render={
              <TooltipIconButton
                tooltip={t('feedback.negative')}
                className="data-[submitted=true]:bg-accent data-[submitted=true]:text-accent-foreground"
              />
            }
          >
            <ThumbsDownIcon />
          </ActionBarPrimitive.FeedbackNegative>
        </AuiIf>
      </ActionBarPrimitive.Root>
    </AuiIf>
  );
};

const MessageFile: FileMessagePartComponent = (part) => {
  const image = part.mimeType.toLowerCase().startsWith('image/')
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

function isChipRecord(value: unknown): value is ChipRecord {
  return ChipRecordSchema.safeParse(value).success;
}

function isScheduleMark(value: unknown): value is ScheduleMark {
  return ScheduleMarkSchema.safeParse(value).success;
}

const UserMessage: FC = () => {
  const { TaskBrief, UserMessageBody = PlainUserMessageBody } = useContext(
    ThreadComponentsContext,
  );
  const isTask = useAuiState((s) => feedKindOf(s) === 'task');
  // custom-agents KD-5: the record chip the message was sent with (`FeedMessageMeta.record`).
  const sentRecord = useAuiState(
    (s): unknown => s.message.metadata.custom['record'],
  );
  const record = isChipRecord(sentRecord) ? sentRecord : null;
  // schedules SH-07: the schedule that sent the message (`FeedMessageMeta.schedule`).
  const sentBy = useAuiState(
    (s): unknown => s.message.metadata.custom['schedule'],
  );
  const schedule = isScheduleMark(sentBy) ? sentBy : null;
  // create-and-test CT-03: the test run's description is sent with the action chip, without «✕».
  const testRun = useAuiState(
    (s) => s.message.metadata.custom['testRun'] === true,
  );
  // AV-03: a deep agent's task reads as its brief.
  const Brief = isTask ? TaskBrief : undefined;
  const t = useTranslations('chat');
  const sourceCaptionText = useSourceCaption();
  const caption = Brief ? t('caption.brief') : sourceCaptionText;
  const markProps = useMessageMarkProps();
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className={cn(
        'group/message fade-in slide-in-from-bottom-1 animate-in motion-reduce:animate-none grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2',
        SEARCH_MARK_USER_ROOT_CLASS,
      )}
      data-role="user"
      {...markProps}
    >
      {schedule !== null && Brief === undefined ? (
        <ScheduleCaption
          mark={schedule}
          className="col-start-2 -mb-1 justify-self-end"
        />
      ) : (
        caption !== null && (
          <SourceCaption
            text={caption}
            className="col-start-2 -mb-1 justify-self-end"
          />
        )
      )}
      {record !== null && (
        <RecordLabel
          chip={record}
          variant="under"
          href={recordPath(record.id)}
          className="col-start-2 -mb-1 justify-self-end"
        />
      )}
      {testRun && (
        <Chip
          icon={TEST_RUN_ICON}
          name={t('composer.testRun.name')}
          className="col-start-2 justify-self-end"
        />
      )}
      <UserMessageAttachments />

      <UserMessageBody>
        <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
          <div
            className={cn(
              'aui-user-message-content peer bg-muted text-foreground rounded-(--composer-radius) px-4 py-2 wrap-break-word empty:hidden',
              SEARCH_MARK_USER_BUBBLE_CLASS,
            )}
          >
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
      </UserMessageBody>
    </MessagePrimitive.Root>
  );
};

const PlainUserMessageBody: FC<{ children: ReactNode }> = ({ children }) =>
  children;

const UserActionBar: FC = () => {
  const { UserActions } = useContext(ThreadComponentsContext);
  const visibility = useActionBarVisibility();
  return (
    <ActionBarPrimitive.Root
      className={cn(
        'aui-user-action-bar-root text-muted-foreground flex items-center gap-1',
        visibility,
      )}
    >
      {UserActions !== undefined && <UserActions />}
      <MessageCopy className="aui-user-action-copy" />
    </ActionBarPrimitive.Root>
  );
};
