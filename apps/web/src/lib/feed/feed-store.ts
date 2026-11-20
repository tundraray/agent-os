import {
  WORKFLOWS_BRIEF_CONFIRMATION,
  type ChipRecord,
  type Confirmation,
  type ConversationView,
  type AgentPageView,
  type DecisionRequest,
  type DraftActionRequest,
  type DraftView,
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
import type { HistoryStatus, SendFailure, ShellStatusStore } from "@/lib/threads/shell-status-store";
import type { ThreadsApiClient } from "@/lib/threads/threads-api-client";
import { describeApiError, isApiRequestError } from "@/lib/api/api-request";
import { describeLibraryError } from "@/lib/library/library-errors";

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
  /**
   * The last message the server did not accept: the composer returns its text with `notice` under the
   * field — MC-16 for a library refusal (an unavailable chip, a refused first message), null for MC-27.
   * The chip itself never leaves `composerSeed` until the send is accepted (KD-5).
   */
  sendFailure: SendFailure | null;
};

export type FeedStore = StoreApi<FeedState> & {
  /**
   * The first read takes the view from `afterSeq` 0 to the end, and its failure is the screen's load
   * error; a later one reads on from `lastSeq`, and its failure keeps the view (design-web.md, Error handling).
   */
  load: () => Promise<void>;
  applyDelta: (part: DraftPart) => void;
  /**
   * Rejects when the server did not accept the message. `record` — the composer's chip: the message
   * carries its id (KD-5, Invariant 4); an agent page has no chip.
   */
  send: (text: string, record?: ChipRecord) => Promise<void>;
  /** Stops the agent's work; a message is never part of it. Rejects when the server did not take it. */
  interrupt: () => Promise<void>;
  decide: (decisionId: string, approve: boolean, args?: Record<string, unknown>) => Promise<void>;
  /**
   * A record draft's action (KD-6), then a re-read. Resolves with the draft as the server answered — a refused
   * save is a 200 with `refusal` — or `null` when another tab had resolved it (409 `DRAFT_RESOLVED`): the
   * re-read shows that outcome, with no error (DC-9). Rejects on any other failure.
   */
  draftAction: (draftId: string, action: DraftActionRequest) => Promise<DraftView | null>;
  stop: () => Promise<void>;
  /** Resolves with the new agent the caller opens. */
  restart: () => Promise<RestartResponse>;
  /** Drops a queued read; the screen closed. */
  dispose: () => void;
};

type FeedLogger = Pick<typeof appLogger, "info" | "warn">;

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

/** MC-25 for decisions that opened since the previous read; a workflow task — custom-agents MC-21. */
function decisionAnnouncement(view: FeedView, opened: readonly Confirmation[]): string | null {
  if (opened.length === 0) return null;
  if (opened.length > 1) {
    return `Нужно ваше решение: ${opened.length} ${pluralRu(opened.length, DECISION_NOUN)}`;
  }
  const [decision] = opened;
  if (decision.kind === WORKFLOWS_BRIEF_CONFIRMATION) return "Задание готово — нужно ваше решение";
  const byChat = view.kind === "thread" && decision.agentId === view.chat.rootAgentId;
  const who = byChat ? "Чат" : `Агент «${decision.description}»`;
  return `Нужно ваше решение: ${who} хочет выполнить ${decision.tool}`;
}

/** Waiting drafts a re-read found for the first time (MC-19 «Черновик «{имя}» готов»). */
function newDrafts(previous: FeedView, next: FeedView): DraftView[] {
  if (next.kind !== "thread") return [];
  const known = new Set(previous.kind === "thread" ? previous.drafts.map((d) => d.draftId) : []);
  return next.drafts.filter((d) => d.state === "pending" && !known.has(d.draftId));
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
    for (const draft of newDrafts(previous, next)) {
      announcer.getState().announce(`Черновик «${draft.name}» готов — проверьте и сохраните`);
    }
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
      const description = describeApiError(error);
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
      const description = describeApiError(error);
      logger.warn(`feed command ${name} failed`, { ...description, ...ids, ...extra });
      if (isApiRequestError(error) && error.kind === "not_found") {
        if (error.code === "THREAD_NOT_FOUND") setHistory("deleted");
        if (error.code === "AGENT_NOT_FOUND") set({ loadError: "not_found" });
        // The decision is gone with its conversation: the re-read shows «не найдено» (Flow 2).
        if (error.code === "DECISION_NOT_FOUND") await reads.request();
      }
      throw error;
    }
  }

  type Accepted = Pick<OptimisticEntry, "messageId" | "first">;

  /** The conversation has no task yet: this message would start its root (409 `START_REFUSED`, Flow 2). */
  function firstMessage(): boolean {
    if (source.kind !== "thread") return false;
    const { view, optimistic } = get();
    const hasTask = view?.entries.some((entry) => entry.kind === "task") ?? false;
    return !hasTask && !optimistic.some((entry) => entry.first);
  }

  /**
   * Sends text; once the server accepted it, puts the optimistic entry where KD-4 says and re-reads.
   * A refused or lost request leaves no entry and keeps the text for the composer.
   */
  async function deliver(
    text: string,
    call: () => Promise<Accepted>,
    place: OptimisticEntry["place"],
    record: ChipRecord | null = null,
  ): Promise<void> {
    const where = firstMessage() ? "first_message" : "message";
    set({ sendFailure: null });
    let accepted: Accepted;
    try {
      accepted = await call();
    } catch (error) {
      const notice = describeLibraryError(error, record === null ? { where } : { where, kind: record.kind });
      set({ sendFailure: { text, notice: notice?.text ?? null } });
      throw error;
    }
    addOptimistic({ text, place, record, ...accepted });
    onActivity?.();
    await reads.request();
  }

  const sendCall = (text: string, record: ChipRecord | null): Promise<SendMessageResponse> =>
    source.kind === "thread"
      ? api.sendThreadMessage(source.threadId, text, record?.id)
      : api.sendAgentMessage(source.agentId, text);

  const interruptCall = (): Promise<InterruptResponse> =>
    source.kind === "thread" ? api.interruptThread(source.threadId) : api.interruptAgent(source.agentId);

  function agentOnly(name: string): string {
    if (source.kind !== "agent") throw new Error(`${name} is an agent page command`);
    return source.agentId;
  }

  function threadOnly(name: string): string {
    if (source.kind !== "thread") throw new Error(`${name} is a conversation command`);
    return source.threadId;
  }

  return Object.assign(store, {
    load: () => reads.request(),
    applyDelta: (part: DraftPart) => {
      const draft = applyDraftPart(get().draft, part);
      if (draft !== get().draft) set({ draft });
    },
    send: (text: string, record?: ChipRecord) => {
      // Only a conversation's message carries a chip (KD-5).
      const chip = source.kind === "thread" ? (record ?? null) : null;
      return deliver(
        text,
        async () => {
          // A refusal of a message with a chip is logged by `command` with `recordId` and its code.
          const extra: Record<string, string> = chip === null ? {} : { recordId: chip.id };
          const { messageId } = await command("send", () => sendCall(text, chip), extra);
          if (chip !== null) logger.info("feed command send done", { ...ids, recordId: chip.id, outcome: "accepted" });
          // A null `messageId` is the conversation's first message: it becomes the task.
          return { messageId, first: messageId === null };
        },
        isBusy(get().view) ? "tray" : "feed",
        chip,
      );
    },
    interrupt: async () => {
      await command("interrupt", interruptCall);
      await reads.request();
    },
    decide: async (decisionId: string, approve: boolean, args?: Record<string, unknown>) => {
      const body: DecisionRequest = args === undefined ? { approve } : { approve, args };
      await command("decide", () => api.decide(decisionId, body), { decisionId });
      await reads.request();
    },
    draftAction: async (draftId: string, action: DraftActionRequest) => {
      const threadId = threadOnly("draft");
      // A failure is logged by `command` with `threadId`, `draftId`, the action and its code.
      const fields = { draftId, action: action.action };
      let draft: DraftView;
      try {
        draft = await command("draft", () => api.draftAction(threadId, draftId, action), fields);
      } catch (error) {
        if (!isApiRequestError(error) || error.code !== "DRAFT_RESOLVED") throw error;
        await reads.request();
        return null;
      }
      logger.info("feed command draft done", { threadId, ...fields, outcome: draft.state, refusal: draft.refusal });
      await reads.request();
      return draft;
    },
    stop: async () => {
      const agentId = agentOnly("stop");
      await command("stop", () => api.stopAgent(agentId));
      await reads.request();
    },
    restart: async () => {
      const agentId = agentOnly("restart");
      // A refusal (409 `START_REFUSED` included) is logged by `command` with `agentId` and its code.
      const response = await command("restart", () => api.restartAgent(agentId));
      logger.info("feed command restart done", { agentId, outcome: "started", newAgentId: response.agentId });
      await reads.request();
      return response;
    },
    dispose: () => reads.cancel(),
  });
}
