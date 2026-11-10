import type { ResearchLaunchView, ResearchSourceMode } from "@agent-os/contracts";
import type { UIMessage } from "ai";
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { RESEARCH_POLL_INTERVAL_MS } from "./research-poll";
import type { ThreadsApiClient } from "./threads-api-client";
import { describeThreadsError, isThreadsApiError } from "./threads-api-error";

/** The events the screen's polite `status` region announces (UXRD Accessibility, MC-17…MC-20). */
export type ResearchAnnouncementKind = "launched" | "completed" | "stopped" | "failed";

export type ResearchAnnouncement = {
  /** Unique per event, so a repeated text is still a new announcement. */
  id: number;
  kind: ResearchAnnouncementKind;
  launchKey: string;
  /** MC-17 and MC-18 have a no-source variant (UXRD KD-9). */
  sourceMode: ResearchSourceMode;
};

/** Launches of the open thread; kept apart from `ShellStatusStore` (design-chat-entry.md, C3 web). */
export type ThreadResearchState = {
  threadId: string | null;
  /** The thread's launches in creation order, as the last successful read returned them. */
  launches: readonly ResearchLaunchView[];
  /** The events found by the latest read that found any. */
  announcements: readonly ResearchAnnouncement[];
};

export type ThreadResearchDeps = {
  api: Pick<ThreadsApiClient, "getThreadResearch" | "getThreadMessages" | "stopResearch">;
};

/**
 * How a stop ended (design-web.md, Contract `ThreadResearch.stop`): `applied` — the answer's view stands in `launches`;
 * `refused` — the request failed or timed out and one state read was started; `stale` — the store shows another thread
 * or is closed, nothing applied.
 */
export type ThreadResearchStopOutcome =
  | { outcome: "applied"; launch: ResearchLaunchView }
  | { outcome: "refused" }
  | { outcome: "stale" };

/** What the open tab's feed holds when the answers are checked (KD-6). */
export type AnswerFeed = {
  messageIds: ReadonlySet<string>;
  /** A reply streams in this tab: an answer joins the feed only after it (NFR-01, AC-20.3). */
  streaming: boolean;
};

export type ThreadResearch = {
  store: StoreApi<ThreadResearchState>;
  /** Shows the thread: forgets the previous one, reads the launches and polls while KD-6 asks for it. */
  open: (threadId: string) => void;
  /**
   * One read after a turn with a `deepResearch` call or a decision turn, also a failed or aborted one: the
   * decision may have been applied before the failure (KD-6).
   */
  refresh: () => void;
  /** Stops polling and forgets the thread; a reply still in flight is ignored. */
  close: () => void;
  /**
   * KD-6: when a completed launch's answer is missing from the feed and nothing streams, reads the thread's messages
   * once and hands the missing answers, in their stored order, to `append`. A failed read is retried after one period.
   */
  appendMissingAnswers: (feed: AnswerFeed, append: (answers: UIMessage[]) => void) => void;
  /** Stops a launch of the open thread and applies the answer as a read result (KD-3); never throws. */
  stop: (launchKey: string) => Promise<ThreadResearchStopOutcome>;
};

const EMPTY: Pick<ThreadResearchState, "threadId" | "launches" | "announcements"> = {
  threadId: null,
  launches: [],
  announcements: [],
};

/** KD-6: a running launch, or a completed one whose answer a regeneration removed and the loop has not appended yet. */
const keepsPollAlive = (launch: ResearchLaunchView): boolean =>
  launch.state === "running" || (launch.state === "completed" && launch.answerPending);

/**
 * The answers the feed lacks: of completed launches whose answer is stored — not of one a regeneration removed and the
 * loop has not appended again (`answerPending`), which the poll waits for.
 */
function missingAnswerIds(launches: readonly ResearchLaunchView[], feedMessageIds: ReadonlySet<string>): string[] {
  return launches.flatMap((launch) =>
    launch.state === "completed" &&
    !launch.answerPending &&
    launch.answerMessageId !== null &&
    !feedMessageIds.has(launch.answerMessageId)
      ? [launch.answerMessageId]
      : [],
  );
}

/** What a launch's state means to the announcer; `null` — nothing to announce for it. */
function eventOf(launch: ResearchLaunchView): ResearchAnnouncementKind | null {
  switch (launch.state) {
    case "running":
      return "launched";
    case "completed":
      return launch.answerPending ? null : "completed";
    case "stopped":
    case "failed":
      return launch.state;
    default:
      return null;
  }
}

export function createThreadResearch({ api }: ThreadResearchDeps): ThreadResearch {
  const store = createStore<ThreadResearchState>()(() => EMPTY);

  /** Bumped on every open and close: a reply of an older generation belongs to a thread no longer shown. */
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let readAgain = false;
  /**
   * Bumped whenever a stop answer is applied: a read that began before it may carry the state the stop replaced, so its
   * result is dropped and the thread is read again (invariant 4).
   */
  let stopsApplied = 0;
  /** False until the first successful read of the open thread: the states it finds are not events. */
  let baselineTaken = false;
  /** The last event seen per launch, so each event is announced once. */
  let lastEvent = new Map<string, ResearchAnnouncementKind | null>();
  let nextAnnouncementId = 1;
  /** One GET /messages at a time: the feed is checked again once its answers have been handed over. */
  let answersInFlight = false;

  const stopTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  /**
   * `stoppedKey` — the launch a stop answer brought: its state is the user's own action, an event even before the
   * first read. Only a read takes the baseline, so the states that read finds for other launches stay silent.
   */
  const announce = (launches: readonly ResearchLaunchView[], stoppedKey?: string): ResearchAnnouncement[] => {
    const events: ResearchAnnouncement[] = [];
    const seen = new Map<string, ResearchAnnouncementKind | null>();
    for (const launch of launches) {
      const kind = eventOf(launch);
      seen.set(launch.launchKey, kind);
      const counts = baselineTaken || launch.launchKey === stoppedKey;
      if (!counts || kind === null || lastEvent.get(launch.launchKey) === kind) continue;
      events.push({ id: nextAnnouncementId++, kind, launchKey: launch.launchKey, sourceMode: launch.sourceMode });
    }
    lastEvent = seen;
    if (stoppedKey === undefined) baselineTaken = true;
    return events;
  };

  /** Puts launches in the store and announces their events by the one rule both reads and stop answers follow. */
  const apply = (launches: readonly ResearchLaunchView[], stoppedKey?: string): void => {
    const events = announce(launches, stoppedKey);
    store.setState(events.length > 0 ? { launches, announcements: events } : { launches });
  };

  const read = async (threadId: string, readGeneration: number): Promise<void> => {
    let pollOn = store.getState().launches.some(keepsPollAlive);
    const stopsBefore = stopsApplied;
    const outdated = (): boolean => stopsApplied !== stopsBefore;
    try {
      const { launches } = await api.getThreadResearch(threadId);
      if (readGeneration !== generation) return;
      if (outdated()) {
        readAgain = true;
      } else {
        apply(launches);
        pollOn = launches.some(keepsPollAlive);
      }
    } catch (error) {
      if (readGeneration !== generation) return;
      if (outdated()) {
        readAgain = true;
      } else if (isThreadsApiError(error) && error.kind === "not_found") {
        // The thread is gone: nothing more to poll and no launches to show.
        store.setState({ launches: [] });
        pollOn = false;
      } else {
        console.warn("[deep-research] research poll request failed", { threadId, ...describeThreadsError(error) });
      }
    } finally {
      if (readGeneration === generation) inFlight = false;
    }
    if (readGeneration !== generation) return;
    if (readAgain) {
      readAgain = false;
      start(threadId);
      return;
    }
    if (pollOn) {
      timer = setTimeout(() => {
        timer = undefined;
        start(threadId);
      }, RESEARCH_POLL_INTERVAL_MS);
    }
  };

  /** Starts a read now; a read already in flight is followed by one more, since the turn may have ended after it began. */
  const start = (threadId: string): void => {
    if (inFlight) {
      readAgain = true;
      return;
    }
    stopTimer();
    inFlight = true;
    void read(threadId, generation);
  };

  const readAnswers = async (
    threadId: string,
    readGeneration: number,
    wanted: ReadonlySet<string>,
    append: (answers: UIMessage[]) => void,
  ): Promise<void> => {
    try {
      const messages = await api.getThreadMessages(threadId);
      if (readGeneration !== generation) return;
      const answers = messages.filter((message) => wanted.has(message.id));
      if (answers.length < wanted.size) {
        console.warn("[deep-research] answer listed by the research state is missing from the thread", {
          threadId,
          missing: [...wanted].filter((id) => !answers.some((answer) => answer.id === id)),
        });
      }
      if (answers.length > 0) append(answers);
    } catch (error) {
      if (readGeneration !== generation) return;
      console.warn("[deep-research] answer read failed", { threadId, ...describeThreadsError(error) });
      // A new read of the state brings the feed check back, one period later.
      if (timer === undefined && !inFlight) {
        timer = setTimeout(() => {
          timer = undefined;
          start(threadId);
        }, RESEARCH_POLL_INTERVAL_MS);
      }
    } finally {
      if (readGeneration === generation) answersInFlight = false;
    }
  };

  const appendMissingAnswers = (feed: AnswerFeed, append: (answers: UIMessage[]) => void): void => {
    const { threadId, launches } = store.getState();
    if (threadId === null || feed.streaming || answersInFlight) return;
    const wanted = missingAnswerIds(launches, feed.messageIds);
    if (wanted.length === 0) return;
    answersInFlight = true;
    void readAnswers(threadId, generation, new Set(wanted), append);
  };

  const stop = async (launchKey: string): Promise<ThreadResearchStopOutcome> => {
    const { threadId } = store.getState();
    if (threadId === null) return { outcome: "stale" };
    const stopGeneration = generation;
    let launch: ResearchLaunchView;
    try {
      launch = await api.stopResearch(threadId, launchKey);
    } catch (error) {
      if (stopGeneration !== generation) return { outcome: "stale" };
      console.warn("[deep-research] research stop request failed", { threadId, ...describeThreadsError(error) });
      // The stop may have been applied before the failure: one read shows the launch as the server has it (KD-4).
      start(threadId);
      return { outcome: "refused" };
    }
    if (stopGeneration !== generation) return { outcome: "stale" };
    const { launches } = store.getState();
    const known = launches.some((item) => item.launchKey === launchKey);
    stopsApplied += 1;
    apply(
      known ? launches.map((item) => (item.launchKey === launchKey ? launch : item)) : [...launches, launch],
      launchKey,
    );
    return { outcome: "applied", launch };
  };

  const close = (): void => {
    generation += 1;
    stopTimer();
    inFlight = false;
    answersInFlight = false;
    readAgain = false;
    baselineTaken = false;
    lastEvent = new Map();
    store.setState(EMPTY);
  };

  return {
    store,
    open: (threadId) => {
      if (store.getState().threadId === threadId) return;
      close();
      store.setState({ threadId });
      start(threadId);
    },
    refresh: () => {
      const { threadId } = store.getState();
      if (threadId !== null) start(threadId);
    },
    close,
    appendMissingAnswers,
    stop,
  };
}

/** Follows the open thread: opens it on mount and on change, closes it on unmount, and returns its state. */
export function useThreadResearch(research: ThreadResearch, threadId: string | null): ThreadResearchState {
  useEffect(() => {
    if (threadId === null) return;
    research.open(threadId);
    return research.close;
  }, [research, threadId]);
  return useStore(research.store);
}
