"use client";

import { useEffect, useRef } from "react";
import { RotateCwIcon } from "lucide-react";
import { useStore } from "zustand";
import { AgentTree, AgentTreeSkeleton } from "@/components/agents/agent-tree";
import { Button } from "@/components/ui/button";
import type { AgentListStore } from "@/lib/agents/agent-list-store";
import { focusShellTarget } from "@/lib/focus";

/**
 * Screen 2 «Агенты» (UXRD): the agent tree with Loading, Default, Empty (MC-5), Error (MC-6) and
 * Partial. The store comes from the shell, so expansion and loaded pages outlive a visit to the screen.
 */
export function AgentsScreen({ store }: { store: AgentListStore }) {
  const { status, agents, nextCursor, loadingMore, loadMoreFailed, expanded } = useStore(store);

  useEffect(() => store.attach(), [store]);

  // The last row left with its conversation while it held focus: the page title takes it (UXRD «Порядок фокуса»).
  const hadRows = useRef(false);
  useEffect(() => {
    const hasRows = status === "ready" && agents.length > 0;
    if (hadRows.current && !hasRows && status === "ready" && document.activeElement === document.body) {
      focusShellTarget("page-title");
    }
    hadRows.current = hasRows;
  }, [status, agents]);

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="flex min-h-full flex-col p-4 md:p-6">
        {(status === "idle" || status === "loading") && <AgentTreeSkeleton />}

        {status === "error" && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-sm leading-5">
            <p role="alert">Не удалось загрузить агентов</p>
            <Button variant="outline" size="sm" onClick={() => void store.load()} className="pointer-coarse:h-11">
              <RotateCwIcon aria-hidden />
              Повторить
            </Button>
          </div>
        )}

        {status === "ready" && agents.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center text-sm leading-5">
            <p className="text-foreground font-medium">Агентов пока нет</p>
            <p className="text-muted-foreground">Попросите в беседе сделать задачу в фоне — агент появится здесь.</p>
          </div>
        )}

        {status === "ready" && agents.length > 0 && (
          <AgentTree
            agents={agents}
            expanded={expanded}
            onToggle={store.toggle}
            hasMore={nextCursor !== null}
            loadingMore={loadingMore}
            loadMoreFailed={loadMoreFailed}
            onLoadMore={() => void store.loadMore()}
          />
        )}
      </div>
    </div>
  );
}
