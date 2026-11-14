"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { WorkflowRunView } from "@agent-os/contracts";
import { AgentMeta } from "@/components/agents/agent-meta";
import { InheritedHistory } from "@/components/agents/inherited-history";
import { Thread, type ThreadComponents } from "@/components/assistant-ui/elements/thread.aui";
import { useShellServices } from "@/components/shell/shell-actions";
import { ThreadNotice } from "@/components/shell/thread-notice";
import { agentComposerPlaceholder, BRIEF_PARTS } from "@/lib/agents/format";
import { useFeed, useFeedSelector } from "@/lib/feed/feed-context";
import type { FeedView } from "@/lib/feed/to-feed";
import { useFeedRuntime } from "@/lib/feed/use-feed-runtime";
import { logger } from "@/lib/logger";
import { describeThreadsError } from "@/lib/threads/threads-api-error";

type AgentView = Extract<FeedView, { kind: "agent" }>["agent"];
type Brief = WorkflowRunView["brief"];

const selectAgent = (view: FeedView | null): AgentView | null => (view?.kind === "agent" ? view.agent : null);

/** The page has no welcome: an agent always starts with its task. */
const NoWelcome = () => null;

/** AV-02 and AV-05 above the first message of the feed. */
function AgentFeedHeader() {
  const agent = useFeedSelector((state) => selectAgent(state.view), null);
  if (agent === null) return null;
  return (
    <>
      <AgentMeta agent={agent} />
      {agent.forkedFrom !== null && <InheritedHistory agentId={agent.agentId} />}
    </>
  );
}

const BriefContext = createContext<Brief | null>(null);

/** AV-03: the coordinator's task as the three parts of its brief; an empty part is left out. */
function TaskBrief() {
  const brief = useContext(BriefContext);
  if (brief === null) return null;
  return (
    <dl className="flex flex-col gap-2">
      {BRIEF_PARTS.filter(({ key }) => brief[key].trim() !== "").map(({ key, label }) => (
        <div key={key} className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground text-xs leading-4 font-medium">{label}</dt>
          <dd className="whitespace-pre-wrap">{brief[key]}</dd>
        </div>
      ))}
    </dl>
  );
}

const COMPONENTS: ThreadComponents = { Welcome: NoWelcome, FeedHeader: AgentFeedHeader };
const BRIEF_COMPONENTS: ThreadComponents = { ...COMPONENTS, TaskBrief };

/**
 * The coordinator's brief (`GET /agents/:id/run`), read once when the page shows a coordinator; null for
 * any other agent, and when the read fails — 404 `RUN_NOT_FOUND` included — the task reads as text.
 */
function useCoordinatorBrief(agentId: string | null, coordinator: boolean): Brief | null {
  const { apiClient } = useShellServices();
  const [brief, setBrief] = useState<Brief | null>(null);
  // A remount under StrictMode keeps the ref: the run is still read once.
  const requested = useRef<string | null>(null);

  useEffect(() => {
    if (agentId === null || !coordinator || requested.current === agentId) return;
    requested.current = agentId;
    apiClient.getRun(agentId).then(
      (run) => setBrief(run.brief),
      (error: unknown) => {
        logger.warn("workflow run read failed", { ...describeThreadsError(error), agentId });
      },
    );
  }, [apiClient, agentId, coordinator]);

  return coordinator ? brief : null;
}

/**
 * UXRD Screen 3 under the agent's `AgentFeedProvider`: the same `Thread` as a conversation on its own
 * `AssistantRuntimeProvider` (KD-1), with the meta line, the inherited history, the task or brief and
 * the composer with the MC-12 placeholder. A missing agent is MC-15, any other failed read MC-16.
 */
export function AgentScreen() {
  const feed = useFeed();
  if (feed === null) throw new Error("AgentScreen must be used inside AgentFeedProvider");

  const runtime = useFeedRuntime(feed);
  const agent = useFeedSelector((state) => selectAgent(state.view), null);
  const loaded = useFeedSelector((state) => state.loaded, false);
  const loadError = useFeedSelector((state) => state.loadError, null);
  const brief = useCoordinatorBrief(agent?.agentId ?? null, agent?.template !== undefined);
  // «Повторить» shows the loading state until the read settles; the store keeps its error meanwhile.
  const [retrying, setRetrying] = useState(false);

  if (!retrying && loadError === "not_found") return <ThreadNotice variant="agent-not-found" />;
  if (!retrying && loadError === "failed") {
    const retry = () => {
      setRetrying(true);
      void feed.load().finally(() => setRetrying(false));
    };
    return <ThreadNotice variant="agent-load-error" onRetry={retry} />;
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <BriefContext.Provider value={brief}>
        <Thread
          autoFocus={false}
          components={brief === null ? COMPONENTS : BRIEF_COMPONENTS}
          historyPending={retrying || !loaded}
          composerPlaceholder={agentComposerPlaceholder(agent?.status ?? "working")}
        />
      </BriefContext.Provider>
    </AssistantRuntimeProvider>
  );
}
