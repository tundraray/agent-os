import {
  WORKFLOWS_BRIEF_CONFIRMATION,
  type Confirmation,
  type ConversationView,
  type AgentPageView,
  type DecisionRequest,
  type HistoryEntry,
  type InterruptResponse,
  type RestartResponse,
  type SendMessageResponse,
} from "@agent-os/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";

import { pluralRu } from "@/lib/i18n/plural-ru";
import { createCoalescedRunner } from "@/lib/live/coalesced-runner";
import type { AnnouncerStore } from "@/lib/live/announcer-store";
import type { logger as appLogger } from "@/lib/logger";
import type { HistoryStatus, ShellStatusStore } from "@/lib/threads/shell-status-store";
import type { ThreadsApiClient } from "@/lib/threads/threads-api-client";
import { describeThreadsError, isThreadsApiError } from "@/lib/threads/threads-api-error";

import {
  applyDraftPart,
  draftAfterRead,
  drawsPending,
  feedViewOf,
  isBusy,
  type DraftPart,
  type FeedView,
  type OptimisticEntry,
} from "./to-feed";

/** What the store shows: a conversation or an agent page. */
export type FeedSource = { kind: "thread"; threadId: string } | { kind: "agent"; agentId: string };

export type FeedState = {
  /** Every entry read so far, with the rest of the latest page; null until the first read succeeds. */
  view: FeedView | null;
  /** The greatest `seq` read: the next re-read continues after it. */
  lastSeq: number;
  /** The observed agent's answer assembled from `delta` parts. */
  draft: string | null;
  optimistic: readonly OptimisticEntry[];
  /** The first read succeeded, or the conversation was created in this tab and has nothing to load. */
  loaded: boolean;
  /** The screen's error state: the first read failed, or a read or command found nothing. */
  loadError: "not_found" | "failed" | null;
  /** The last message the server did not accept: the composer returns its text with MC-27. */
  sendFailure: { text: string } | null;
};

export type FeedStore = StoreApi<FeedState> & {
  /** Reads the view from `afterSeq` 0 to the end; a failure is the screen's load error. */
  load: () => Promise<void>;
  /** Reads on from `lastSeq`; a failure keeps the view (design-web.md, Error handling). */
  refresh: () => Promise<void>;
  applyDelta: (part: DraftPart) => void;
  /** Rejects when the server did not accept the message. */
  send: (text: string) => Promise<void>;
  interrupt: (text?: string) => Promise<void>;
  decide: (decisionId: string, approve: boolean, args?: Record<string, unknown>) => Promise<void>;
  stop: () => Promise<void>;
  /** Resolves with the new agent the caller opens. */
  restart: () => Promise<RestartResponse>;
  /** Drops a queued read; the screen closed. */
  dispose: () => void;
};

type FeedLogger = Pick<typeof appLogger, "warn">;

export type CreateFeedStoreInput = {
  source: FeedSource;
  api: ThreadsApiClient;
  /** The shell's history statuses: a conversation writes `loading`, `ready`, `not_found`, `load_failed`, `deleted`. */
  status?: ShellStatusStore;
  announcer: AnnouncerStore;
  logger: FeedLogger;
  /** A message was accepted: the conversation rises in the list. */
  onActivity?: () => void;
};

const DECISION_NOUN = ["запрос", "запроса", "запросов"] as const;

/** MC-25 for decisions that opened since the previous read. */
function decisionAnnouncement(view: FeedView, opened: readonly Confirmation[]): string | null {
  if (opened.length === 0) return null;
  if (opened.length > 1) {
    return `Нужно ваше решение: ${opened.length} ${pluralRu(opened.length, DECISION_NOUN)}`;
  }
  const [decision] = opened;
  if (decision.kind === WORKFLOWS_BRIEF_CONFIRMATION) return "Бриф готов — нужно ваше решение";
  const byChat = view.kind === "thread" && decision.agentId === view.chat.rootAgentId;
  const who = byChat ? "Чат" : `Агент «${decision.description}»`;
  return `Нужно ваше решение: ${who} хочет выполнить ${decision.tool}`;
}

export function createFeedStore({
  source,
  api,
  status,
  announcer,
  logger,
  onActivity,
}: CreateFeedStoreInput): FeedStore {
  const ids = source.kind === "thread" ? { threadId: source.threadId } : { agentId: source.agentId };
  let localSeq = 0;
  // A conversation created in this tab (`initialize()` marked it ready) has nothing to load: its feed is
  // ready at once, so the first read neither shows the skeleton nor blocks sending.
  const createdHere =
    source.kind === "thread" && status?.getState().history[source.threadId] === "ready";

  const store = createStore<FeedState>()(() => ({
    view: null,
    lastSeq: 0,
    draft: null,
    optimistic: [],
    loaded: createdHere,
    loadError: null,
    sendFailure: null,
  }));
  const { getState: get, setState: set } = store;

  const setHistory = (value: HistoryStatus): void => {
    if (source.kind === "thread") status?.getState().setHistory(source.threadId, value);
  };

  const readPage = (afterSeq: number): Promise<ConversationView | AgentPageView> =>
    source.kind === "thread"
      ? api.getConversation(source.threadId, afterSeq)
      : api.getAgentPage(source.agentId, afterSeq);

  function announce(previous: FeedView, next: FeedView, added: readonly HistoryEntry[]): void {
    const known = new Set(previous.decisions.map((d) => d.decisionId));
    const opened = next.decisions.filter((d) => d.status === "open" && !known.has(d.decisionId));
    const decisionText = decisionAnnouncement(next, opened);
    if (decisionText !== null) announcer.getState().announce(decisionText);
    for (const entry of added) {
      if (entry.kind === "child_report") {
        announcer.getState().announce(`Пришёл отчёт: ${entry.content.description}`);
      }
    }
  }

  /** Optimistic entries a successful read retires (KD-4); `eligible` existed when the read started. */
  function remaining(
    optimistic: readonly OptimisticEntry[],
    eligible: ReadonlySet<string>,
    view: FeedView,
  ): readonly OptimisticEntry[] {
    const hasTask = view.entries.some((entry) => entry.kind === "task");
    return optimistic.filter((entry) => {
      if (entry.first) return !hasTask;
      if (!eligible.has(entry.localId)) return true;
      if (entry.place === "tray") return false;
      return view.pending.some((pending) => drawsPending(entry, pending));
    });
  }

  /** Pages from `fromSeq` until `nextAfterSeq` is null: the last page and the entries after `fromSeq`. */
  async function readToEnd(
    fromSeq: number,
  ): Promise<{ page: ConversationView | AgentPageView; added: HistoryEntry[]; lastSeq: number }> {
    const added: HistoryEntry[] = [];
    let lastSeq = fromSeq;
    let page = await readPage(fromSeq);
    for (;;) {
      for (const entry of page.entries) {
        // Invariant 2: an entry already read is never added again.
        if (entry.seq > lastSeq) {
          added.push(entry);
          lastSeq = entry.seq;
        }
      }
      if (page.nextAfterSeq === null) return { page, added, lastSeq };
      page = await readPage(page.nextAfterSeq);
    }
  }

  /** One read: from 0 until the first success, then from `lastSeq`; never rejects. */
  async function read(): Promise<void> {
    const before = get();
    const refreshing = before.loaded;
    const eligible = new Set(before.optimistic.map((entry) => entry.localId));
    if (!refreshing) setHistory("loading");

    let result: Awaited<ReturnType<typeof readToEnd>>;
    try {
      result = await readToEnd(refreshing ? before.lastSeq : 0);
    } catch (error) {
      const description = describeThreadsError(error);
      if (description.kind === "not_found") {
        logger.warn("feed view not found", { ...description, ...ids });
        setHistory("not_found");
        set({ loadError: "not_found" });
      } else if (refreshing) {
        logger.warn("feed refresh failed", { ...description, ...ids });
      } else {
        logger.warn("feed load failed", { ...description, ...ids });
        setHistory("load_failed");
        set({ loadError: "failed" });
      }
      return;
    }

    const { page, added, lastSeq } = result;
    const current = get();
    const pageView = feedViewOf(page);
    const view: FeedView = {
      ...pageView,
      entries: refreshing && current.view !== null ? [...current.view.entries, ...added] : added,
    };
    set({
      view,
      lastSeq,
      draft: draftAfterRead({ draftAtStart: before.draft, draft: current.draft, added: added.length, view }),
      optimistic: remaining(current.optimistic, eligible, view),
      loaded: true,
      loadError: null,
    });
    setHistory("ready");
    // MC-25 only from a re-read: the first load announces nothing.
    if (refreshing && before.view !== null) announce(before.view, view, added);
  }

  const reads = createCoalescedRunner(read, { minIntervalMs: 0 });

  function addOptimistic(entry: Omit<OptimisticEntry, "localId" | "createdAt">): void {
    localSeq += 1;
    const localId = `${localSeq}`;
    set((state) => ({
      optimistic: [...state.optimistic, { ...entry, localId, createdAt: new Date().toISOString() }],
    }));
  }

  /** Logs a failed command once, applies what a 404 means for the screen, and rethrows. */
  async function command<T>(name: string, run: () => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const description = describeThreadsError(error);
      logger.warn(`feed command ${name} failed`, { ...description, ...ids, ...extra });
      if (isThreadsApiError(error) && error.kind === "not_found") {
        if (error.code === "THREAD_NOT_FOUND") setHistory("deleted");
        if (error.code === "AGENT_NOT_FOUND") set({ loadError: "not_found" });
        // The decision is gone with its conversation: the re-read shows «не найдено» (Flow 2).
        if (error.code === "DECISION_NOT_FOUND") await reads.request();
      }
      throw error;
    }
  }

  type Accepted = Pick<OptimisticEntry, "messageId" | "first" | "interrupt">;

  /**
   * Sends text; once the server accepted it, puts the optimistic entry where KD-4 says and re-reads.
   * A refused or lost request leaves no entry and keeps the text for the composer.
   */
  async function deliver(
    text: string,
    call: () => Promise<Accepted>,
    place: OptimisticEntry["place"],
  ): Promise<void> {
    set({ sendFailure: null });
    let accepted: Accepted;
    try {
      accepted = await call();
    } catch (error) {
      set({ sendFailure: { text } });
      throw error;
    }
    addOptimistic({ text, place, ...accepted });
    onActivity?.();
    await reads.request();
  }

  const sendCall = (text: string): Promise<SendMessageResponse> =>
    source.kind === "thread"
      ? api.sendThreadMessage(source.threadId, text)
      : api.sendAgentMessage(source.agentId, text);

  const interruptCall = (text?: string): Promise<InterruptResponse> =>
    source.kind === "thread"
      ? api.interruptThread(source.threadId, text)
      : api.interruptAgent(source.agentId, text);

  function agentOnly(name: string): string {
    if (source.kind !== "agent") throw new Error(`${name} is an agent page command`);
    return source.agentId;
  }

  return Object.assign(store, {
    load: () => reads.request(),
    refresh: () => reads.request(),
    applyDelta: (part: DraftPart) => {
      const draft = applyDraftPart(get().draft, part);
      if (draft !== get().draft) set({ draft });
    },
    send: (text: string) =>
      deliver(
        text,
        async () => {
          const { messageId } = await command("send", () => sendCall(text));
          // A null `messageId` is the conversation's first message: it becomes the task.
          return { messageId, first: messageId === null, interrupt: false };
        },
        isBusy(get().view) ? "tray" : "feed",
      ),
    interrupt: async (text?: string) => {
      if (text === undefined) {
        await command("interrupt", () => interruptCall());
        await reads.request();
        return;
      }
      // «Прервать и отправить»: the message goes to the end of the feed (KD-4); `not_active` sent it as
      // an ordinary message with a `messageId`.
      await deliver(
        text,
        async () => {
          const response = await command("interrupt", () => interruptCall(text));
          return response.outcome === "not_active"
            ? { messageId: response.messageId ?? null, first: false, interrupt: false }
            : { messageId: null, first: false, interrupt: true };
        },
        "feed",
      );
    },
    decide: async (decisionId: string, approve: boolean, args?: Record<string, unknown>) => {
      const body: DecisionRequest = args === undefined ? { approve } : { approve, args };
      await command("decide", () => api.decide(decisionId, body), { decisionId });
      await reads.request();
    },
    stop: async () => {
      const agentId = agentOnly("stop");
      await command("stop", () => api.stopAgent(agentId));
      await reads.request();
    },
    restart: async () => {
      const agentId = agentOnly("restart");
      const response = await command("restart", () => api.restartAgent(agentId));
      await reads.request();
      return response;
    },
    dispose: () => reads.cancel(),
  });
}
