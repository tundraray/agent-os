import type { AgentListNode, AgentStatus } from "@agent-os/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";

import { createCoalescedRunner } from "@/lib/live/coalesced-runner";
import type { LiveStore } from "@/lib/live/live-store";
import type { logger as appLogger } from "@/lib/logger";
import type { ThreadsApiClient } from "@/lib/threads/threads-api-client";
import { describeThreadsError } from "@/lib/threads/threads-api-error";

export type AgentListStatus = "idle" | "loading" | "ready" | "error";

export type AgentListState = {
  /** `idle` before the first load; `error` only when the first page failed. */
  status: AgentListStatus;
  /** Top agents of every loaded page, newest first, exactly in the order the API returned them. */
  agents: readonly AgentListNode[];
  /** Cursor of the next page; null when everything is loaded. */
  nextCursor: string | null;
  /** How many pages are loaded: a re-read reads as many from the first one. */
  pages: number;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  /** Expanded rows by `agentId`; lives in memory until the page reloads (agent-tree.md). */
  expanded: ReadonlySet<string>;
};

export type AgentListStore = StoreApi<AgentListState> & {
  /** Reads the first page; a failure is the screen's error state. Never rejects. */
  load: () => Promise<void>;
  /** Reads the page after `nextCursor`; a failure keeps the rows. Never rejects. */
  loadMore: () => Promise<void>;
  /**
   * Re-reads from the first page as many pages as are loaded, at most once a second (design-web.md,
   * KD-2); a failure keeps the rows. Never rejects.
   */
  refresh: () => Promise<void>;
  toggle: (agentId: string) => void;
  /**
   * The screen is shown: follows `tree` and `ready` of the live stream, loads the first time and
   * re-reads afterwards. The returned function detaches.
   */
  attach: () => () => void;
};

type AgentListLogger = Pick<typeof appLogger, "warn">;

export type CreateAgentListStoreInput = {
  api: Pick<ThreadsApiClient, "listAgents">;
  live: Pick<LiveStore, "onTree" | "onReady">;
  logger: AgentListLogger;
};

/** KD-2: the loaded tree re-reads by any `tree` note, no more than once a second. */
const REFRESH_INTERVAL_MS = 1000;

/** Roots in these statuses are expanded the first time they appear (agent-tree.md, States). */
const EXPANDED_AT_FIRST_SIGHT: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "working",
  "awaiting_confirmation",
  "interrupted",
]);

/** Appends `next` to `rows`, dropping agents already present: a keyset page may repeat a boundary row. */
function appendUnique(rows: readonly AgentListNode[], next: readonly AgentListNode[]): AgentListNode[] {
  const known = new Set(rows.map((row) => row.agentId));
  return [...rows, ...next.filter((row) => !known.has(row.agentId))];
}

export function createAgentListStore({ api, live, logger }: CreateAgentListStoreInput): AgentListStore {
  const store = createStore<AgentListState>()(() => ({
    status: "idle",
    agents: [],
    nextCursor: null,
    pages: 0,
    loadingMore: false,
    loadMoreFailed: false,
    expanded: new Set<string>(),
  }));
  const { getState: get, setState: set } = store;

  /** Roots whose first-sight expansion was already decided: later the employee alone expands. */
  const seen = new Set<string>();
  /** Bumped by every commit of `load` and `loadMore`: a re-read started before it is stale. */
  let version = 0;

  function expandedWith(agents: readonly AgentListNode[]): ReadonlySet<string> {
    const current = get().expanded;
    const added = agents.filter((agent) => !seen.has(agent.agentId));
    if (added.length === 0) return current;
    const expanded = new Set(current);
    for (const agent of added) {
      seen.add(agent.agentId);
      if (agent.children.length > 0 && EXPANDED_AT_FIRST_SIGHT.has(agent.status)) expanded.add(agent.agentId);
    }
    return expanded;
  }

  async function load(): Promise<void> {
    if (get().status === "loading") return;
    set({ status: "loading", loadMoreFailed: false });
    try {
      const page = await api.listAgents();
      version += 1;
      set({
        status: "ready",
        agents: page.agents,
        nextCursor: page.nextCursor,
        pages: 1,
        expanded: expandedWith(page.agents),
      });
    } catch (error) {
      logger.warn("agent list load failed", describeThreadsError(error));
      set({ status: "error" });
    }
  }

  async function loadMore(): Promise<void> {
    const { status, nextCursor, loadingMore } = get();
    if (status !== "ready" || nextCursor === null || loadingMore) return;
    set({ loadingMore: true, loadMoreFailed: false });
    try {
      const page = await api.listAgents(nextCursor);
      version += 1;
      set((state) => ({
        agents: appendUnique(state.agents, page.agents),
        nextCursor: page.nextCursor,
        pages: state.pages + 1,
        loadingMore: false,
        expanded: expandedWith(page.agents),
      }));
    } catch (error) {
      logger.warn("agent list load more failed", describeThreadsError(error));
      set({ loadingMore: false, loadMoreFailed: true });
    }
  }

  /** One re-read; resolves in every case, so the runner never hands a rejection to its callers. */
  async function reread(): Promise<void> {
    const before = get();
    if (before.status !== "ready") return;
    const started = version;
    const oldestShown = before.agents.at(-1)?.agentId;

    let agents: AgentListNode[] = [];
    let nextCursor: string | null = null;
    let pages = 0;
    try {
      let cursor: string | undefined;
      for (;;) {
        const page = await api.listAgents(cursor);
        agents = appendUnique(agents, page.agents);
        nextCursor = page.nextCursor;
        pages += 1;
        if (nextCursor === null) break;
        // New agents push the tail down: one page past the loaded count keeps the oldest shown row
        // on screen instead of dropping it with the shifted tail.
        const tailKept = oldestShown === undefined || agents.some((agent) => agent.agentId === oldestShown);
        if (pages > before.pages || (pages === before.pages && tailKept)) break;
        cursor = nextCursor;
      }
    } catch (error) {
      logger.warn("agent list refresh failed", describeThreadsError(error));
      return;
    }

    if (started !== version) {
      // A page was loaded meanwhile: this read covers fewer pages, so another one follows.
      void reads.request();
      return;
    }
    set({ agents, nextCursor, pages, expanded: expandedWith(agents) });
  }

  const reads = createCoalescedRunner(reread, { minIntervalMs: REFRESH_INTERVAL_MS });
  // `reread` never rejects; a queued run that is cancelled resolves.
  const refresh = (): Promise<void> => reads.request();

  return Object.assign(store, {
    load,
    loadMore,
    refresh,
    toggle: (agentId: string) => {
      const expanded = new Set(get().expanded);
      if (expanded.has(agentId)) expanded.delete(agentId);
      else expanded.add(agentId);
      set({ expanded });
    },
    attach: () => {
      const unsubscribers = [
        live.onTree(() => {
          void refresh();
        }),
        live.onReady(() => {
          void refresh();
        }),
      ];
      const { status } = get();
      if (status === "idle" || status === "error") void load();
      else if (status === "ready") void refresh();
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
        reads.cancel();
      };
    },
  });
}
