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
  api: Pick<ThreadsApiClient, "getThreadResearch" | "getThreadMessages">;
};

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

  const announce = (launches: readonly ResearchLaunchView[]): ResearchAnnouncement[] => {
    const events: ResearchAnnouncement[] = [];
    const seen = new Map<string, ResearchAnnouncementKind | null>();
    for (const launch of launches) {
      const kind = eventOf(launch);
      seen.set(launch.launchKey, kind);
      if (!baselineTaken || kind === null || lastEvent.get(launch.launchKey) === kind) continue;
      events.push({ id: nextAnnouncementId++, kind, launchKey: launch.launchKey, sourceMode: launch.sourceMode });
    }
    lastEvent = seen;
    baselineTaken = true;
    return events;
  };

  const read = async (threadId: string, readGeneration: number): Promise<void> => {
    let pollOn = store.getState().launches.some(keepsPollAlive);
    try {
      const { launches } = await api.getThreadResearch(threadId);
      if (readGeneration !== generation) return;
      const events = announce(launches);
      store.setState(events.length > 0 ? { launches, announcements: events } : { launches });
      pollOn = launches.some(keepsPollAlive);
    } catch (error) {
      if (readGeneration !== generation) return;
      if (isThreadsApiError(error) && error.kind === "not_found") {
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
