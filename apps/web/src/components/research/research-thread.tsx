'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAui, useAuiState, useAssistantToolUI, type ToolCallMessagePartComponent } from '@assistant-ui/react';
import {
  DeepResearchToolResultSchema,
  RESEARCH_METADATA_KEYS,
  type DeepResearchToolResult,
  type ResearchDecision,
  type ResearchLaunchView,
} from '@agent-os/contracts';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { createThreadResearch, useThreadResearch, type ThreadResearch } from '@/lib/threads/thread-research-store';
import { threadsApiClient } from '@/lib/threads/threads-api-client';
import { researchAnnouncement, type ResearchAnnouncementEvent } from './research-announcements';
import { ResearchCard, type ResearchCardAction, type ResearchCardDecisionError } from './research-card';
import { ResearchModeToggle } from './research-mode-toggle';

/** The agent tool whose calls draw a launch card (design-chat-entry.md, KD-1). */
const DEEP_RESEARCH_TOOL = 'deepResearch';

/** The text of the hidden decision message: the label of the pressed button (KD-2). */
const DECISION_TEXT = {
  confirm: 'Запустить',
  decline: 'Не нужно',
  stop: 'Остановить',
} as const satisfies Record<ResearchCardAction, string>;

/** The card's error line when a decision turn failed, was interrupted, or left no result (MC-15, MC-29, MC-16). */
const DECISION_FAILURE = {
  confirm: 'launch_failed',
  decline: 'decline_failed',
  stop: 'stop_failed',
} as const satisfies Record<ResearchCardAction, ResearchCardDecisionError>;

type CardDecision = { pending: ResearchCardAction | null; error: ResearchCardDecisionError | null };

/** A `deepResearch` result found in the feed, with the index of its message. */
type ToolLaunch = { index: number; result: DeepResearchToolResult };

type ThreadResearchContextValue = {
  launchOf: (launchKey: string) => ResearchLaunchView | undefined;
  decisionOf: (launchKey: string) => CardDecision | undefined;
  decide: (launchKey: string, action: ResearchCardAction) => void;
};

const ThreadResearchContext = createContext<ThreadResearchContextValue | null>(null);

/** What a launch state means to the announcer; the same events the research store announces (UXRD Accessibility). */
function eventOf(launch: ResearchLaunchView): ResearchAnnouncementEvent | null {
  switch (launch.state) {
    case 'running':
      return 'launched';
    case 'completed':
      return launch.answerPending ? null : 'completed';
    case 'stopped':
    case 'failed':
      return launch.state;
    default:
      return null;
  }
}

type FeedPart = { readonly type: string; readonly toolName?: string; readonly result?: unknown };
type FeedMessage = { readonly role: string; readonly content: readonly FeedPart[] };

/** Every `deepResearch` result of the feed in message order; a result outside the contract is not a launch. */
function toolLaunchesOf(messages: readonly FeedMessage[]): ToolLaunch[] {
  const launches: ToolLaunch[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.toolName !== DEEP_RESEARCH_TOOL || part.result === undefined) continue;
      const parsed = DeepResearchToolResultSchema.safeParse(part.result);
      if (parsed.success) launches.push({ index, result: parsed.data });
    }
  });
  return launches;
}

/** The error line a finished decision turn leaves on its card; `null` — the decision reached the server's state. */
function decisionErrorOf(action: ResearchCardAction, outcome: DeepResearchToolResult | undefined): ResearchCardDecisionError | null {
  if (outcome === undefined || outcome.launch === null) return DECISION_FAILURE[action];
  return outcome.decisionError ?? null;
}

/**
 * Which turns of the open thread this tab ran. A fast turn can start and end between two renders, so `isRunning` alone
 * may never be seen `true`: a user message that was not in the thread before also marks a turn. The messages a thread
 * shows when it is opened are its history, not a turn.
 */
type TurnTracker = { threadId: string | null; seen: Set<string>; baseline: boolean; pending: boolean };

type FeedState = { threadId: string | null; messages: readonly { readonly id: string; readonly role: string }[]; isRunning: boolean };

/** Updates the tracker with the current feed; `true` once per turn, when it has ended. */
function turnEnded(tracker: TurnTracker, { threadId, messages, isRunning }: FeedState): boolean {
  if (threadId !== tracker.threadId) {
    // A new chat that already sent its first message keeps it; any other change opens another thread.
    const continuing = tracker.threadId === null && tracker.seen.size > 0;
    tracker.threadId = threadId;
    if (!continuing) {
      tracker.seen = new Set();
      tracker.baseline = threadId !== null;
      tracker.pending = false;
    }
  }
  const userIds = messages.filter((message) => message.role === 'user').map((message) => message.id);
  if (tracker.baseline) {
    if (messages.length === 0) return false;
    tracker.seen = new Set(userIds);
    tracker.baseline = false;
    return false;
  }
  const lastUser = userIds.at(-1);
  if (isRunning || (lastUser !== undefined && !tracker.seen.has(lastUser))) tracker.pending = true;
  for (const id of userIds) tracker.seen.add(id);
  if (!tracker.pending || isRunning) return false;
  tracker.pending = false;
  return true;
}

const withEntry = <V,>(map: ReadonlyMap<string, V>, key: string, value: V): Map<string, V> => new Map(map).set(key, value);

/** What this tab learned from its own turns; kept outside React state, as the turn's end is observed in an effect. */
type TabResearch = {
  /** Launches reported by the last finished turn, valid until the store reads again (`readBase` is the list they follow). */
  turnViews: ReadonlyMap<string, ResearchLaunchView>;
  readBase: readonly ResearchLaunchView[] | null;
  decisions: ReadonlyMap<string, CardDecision>;
  announcement: { id: number; text: string } | null;
};

const createTabResearch = () =>
  createStore<TabResearch>()(() => ({ turnViews: new Map(), readBase: null, decisions: new Map(), announcement: null }));

/**
 * The launches of the open thread for its cards, the decision turns of this tab and the polite `status` region of the
 * screen (design-chat-entry.md, C3 web; UXRD Accessibility). A card shows, newest first: the result of a turn this tab
 * just finished, the last `GET /research`, and the last `deepResearch` result in the feed.
 */
export function ThreadResearchProvider({ threadId, children }: { threadId: string | null; children: ReactNode }) {
  const aui = useAui();
  const [research] = useState<ThreadResearch>(() => createThreadResearch({ api: threadsApiClient }));
  const { launches, announcements } = useThreadResearch(research, threadId);
  const messages = useAuiState((s) => s.thread.messages);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const toolLaunches = useMemo(() => toolLaunchesOf(messages), [messages]);

  const [tab] = useState(createTabResearch);
  const { turnViews, readBase, decisions, announcement } = useStore(tab);
  const announcementId = useRef(0);
  /** Events this tab announced from a turn's result before the store read them, so the read does not repeat them. */
  const echoes = useRef(new Map<string, ResearchAnnouncementEvent>());
  const activeDecision = useRef<{ launchKey: string; action: ResearchCardAction } | null>(null);
  const turns = useRef<TurnTracker>({ threadId, seen: new Set(), baseline: threadId !== null, pending: false });

  const say = (event: ResearchAnnouncementEvent, sourceMode: ResearchLaunchView['sourceMode']): void => {
    announcementId.current += 1;
    tab.setState({ announcement: { id: announcementId.current, text: researchAnnouncement(event, sourceMode) } });
  };

  useEffect(() => {
    for (const item of announcements) {
      const echo = echoes.current.get(item.launchKey);
      echoes.current.delete(item.launchKey);
      if (echo !== item.kind) say(item.kind, item.sourceMode);
    }
    // `say` only writes the tab store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcements]);

  // KD-6: one read after every turn with a `deepResearch` call and after every decision turn, failed or aborted too.
  useEffect(() => {
    if (!turnEnded(turns.current, { threadId, messages, isRunning })) return;
    const decision = activeDecision.current;
    activeDecision.current = null;

    const lastUser = messages.findLastIndex((message) => message.role === 'user');
    const turn = toolLaunches.filter((item) => item.index > lastUser);
    if (decision === null && turn.length === 0) return;

    const views = turn.flatMap((item) => (item.result.launch === null ? [] : [item.result.launch]));
    for (const view of views) {
      const event = eventOf(view);
      const known = launches.find((launch) => launch.launchKey === view.launchKey);
      if (event === null || (known !== undefined && eventOf(known) === event)) continue;
      if (echoes.current.get(view.launchKey) === event) continue;
      echoes.current.set(view.launchKey, event);
      say(event, view.sourceMode);
    }
    if (views.length > 0) {
      const current = tab.getState();
      const next = new Map(current.readBase === launches ? current.turnViews : []);
      for (const view of views) next.set(view.launchKey, view);
      tab.setState({ turnViews: next, readBase: launches });
    }
    if (decision !== null) {
      const error = decisionErrorOf(decision.action, turn.at(-1)?.result);
      tab.setState({ decisions: withEntry(tab.getState().decisions, decision.launchKey, { pending: null, error }) });
    }
    research.refresh();
    // `launches` is read for the announcement only: a read alone never ends a turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, messages, isRunning]);

  const value = useMemo<ThreadResearchContextValue>(() => {
    const lastToolView = new Map<string, ResearchLaunchView>();
    for (const item of toolLaunches) {
      if (item.result.launch !== null) lastToolView.set(item.result.launch.launchKey, item.result.launch);
    }
    // A read after the turn supersedes what the turn reported.
    const fromTurn = readBase === launches ? turnViews : new Map<string, ResearchLaunchView>();
    return {
      launchOf: (launchKey) =>
        fromTurn.get(launchKey) ??
        launches.find((launch) => launch.launchKey === launchKey) ??
        lastToolView.get(launchKey),
      decisionOf: (launchKey) => decisions.get(launchKey),
      decide: (launchKey, action) => {
        // UXRD KD-8: the tab runs one reply stream; a press during it is not queued.
        if (isRunning) return;
        const decision: ResearchDecision = { action, launchKey };
        activeDecision.current = { launchKey, action };
        tab.setState({ decisions: withEntry(tab.getState().decisions, launchKey, { pending: action, error: null }) });
        const metadata = { custom: {}, [RESEARCH_METADATA_KEYS.researchDecision]: decision };
        aui.thread().append({ role: 'user', content: [{ type: 'text', text: DECISION_TEXT[action] }], metadata });
      },
    };
  }, [aui, decisions, isRunning, launches, readBase, tab, toolLaunches, turnViews]);

  return (
    <ThreadResearchContext.Provider value={value}>
      {children}
      <p role="status" className="sr-only">
        {announcement !== null && <span key={announcement.id}>{announcement.text}</span>}
      </p>
    </ThreadResearchContext.Provider>
  );
}

function useThreadResearchContext(): ThreadResearchContextValue {
  const value = useContext(ThreadResearchContext);
  if (value === null) throw new Error('The research card renders inside ThreadResearchProvider');
  return value;
}

/** «К ответу» and «К запросу»: scroll to the anchored message or card and focus its heading, or the element itself. */
function showResearchAnchor(anchorId: string): void {
  const target = document.getElementById(anchorId);
  if (target === null) return;
  const heading = target.querySelector<HTMLElement>('h2[tabindex="-1"]');
  const focusTarget = heading ?? target;
  if (focusTarget === target && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  // Scrolling follows the viewport's CSS `scroll-behavior`, which is instant under reduced motion (UXRD Accessibility).
  target.scrollIntoView({ block: 'start' });
  focusTarget.focus({ preventScroll: true });
}

/**
 * DR-03 in the feed: the card of the call that created a launch. A decision turn's call returns a launch it did not
 * create, so it draws nothing — its result reaches the original card through the provider.
 */
const DeepResearchCardPart: ToolCallMessagePartComponent = ({ toolCallId, result }) => {
  const { launchOf, decisionOf, decide } = useThreadResearchContext();
  const replyStreaming = useAuiState((s) => s.thread.isRunning);
  const own = DeepResearchToolResultSchema.safeParse(result);
  if (!own.success || own.data.launch === null || own.data.launch.launchKey !== toolCallId) return null;
  const launch = launchOf(toolCallId) ?? own.data.launch;
  const decision = decisionOf(toolCallId);

  return (
    <div id={toolCallId} className="my-2">
      <ResearchCard
        launch={launch}
        pendingDecision={decision?.pending ?? null}
        decisionError={decision?.error ?? null}
        replyStreaming={replyStreaming}
        onDecision={(action) => decide(toolCallId, action)}
        onShowAnswer={showResearchAnchor}
      />
    </div>
  );
};

const DEEP_RESEARCH_TOOL_UI = {
  toolName: DEEP_RESEARCH_TOOL,
  render: DeepResearchCardPart,
  // The card stands in the feed on its own, not inside the collapsed group of tool calls.
  display: 'standalone',
} as const;

/** Registers the card as the UI of the `deepResearch` tool while the feed is mounted. */
export function useDeepResearchToolUI(): void {
  useAssistantToolUI(DEEP_RESEARCH_TOOL_UI);
}

const isModeOn = (custom: Readonly<Record<string, unknown>> | undefined): boolean =>
  custom?.[RESEARCH_METADATA_KEYS.deepResearch] === true;

/** Whether the composer's next message goes in the deep research mode (DR-01, MC-2, MC-3). */
export function useResearchModeOn(): boolean {
  return useAuiState((s) => isModeOn(s.composer.runConfig.custom));
}

/**
 * DR-01 in the composer's action row: the mode lives in the composer's `runConfig` (KD-1) and lasts one message — a send
 * clears it (UXRD KD-1).
 */
export function ComposerResearchModeToggle() {
  const aui = useAui();
  const pressed = useResearchModeOn();
  const setMode = (on: boolean): void => {
    const { runConfig } = aui.composer().getState();
    const custom = Object.fromEntries(
      Object.entries(runConfig.custom ?? {}).filter(([key]) => key !== RESEARCH_METADATA_KEYS.deepResearch),
    );
    aui.composer().setRunConfig({
      ...runConfig,
      custom: on ? { ...custom, [RESEARCH_METADATA_KEYS.deepResearch]: true } : custom,
    });
  };
  const lastLaunchMessage = useAuiState(
    (s) => s.thread.messages.findLast((message) => message.role === 'user' && isModeOn(message.metadata.custom))?.id,
  );
  const seenLaunchMessage = useRef(lastLaunchMessage);
  // The mode lasts one message: the message it went with turns it off.
  useEffect(() => {
    if (lastLaunchMessage === seenLaunchMessage.current) return;
    seenLaunchMessage.current = lastLaunchMessage;
    if (lastLaunchMessage !== undefined && isModeOn(aui.composer().getState().runConfig.custom)) setMode(false);
  });
  return <ResearchModeToggle pressed={pressed} onPressedChange={setMode} />;
}
