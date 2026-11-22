"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useTranslations } from "next-intl";
import type { AgentPageView, DeepAgentRunView, RunTaskListView } from "@agent-os/contracts";
import { AgentMeta } from "@/components/agents/agent-meta";
import { InheritedHistory } from "@/components/agents/inherited-history";
import { RunTaskList, useRunTasks } from "@/components/agents/run-task-list";
import { Thread, type ThreadComponents } from "@/components/assistant-ui/elements/thread.aui";
import { useShellServices } from "@/components/shell/shell-actions";
import { ShellLink } from "@/components/shell/shell-link";
import { ThreadNotice } from "@/components/shell/thread-notice";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Resource } from "@/hooks/use-resource";
import { BRIEF_PARTS } from "@/lib/agents/format";
import { useFeed, useFeedSelector } from "@/lib/feed/feed-context";
import { isDeepAgentRun, selectAgent } from "@/lib/feed/to-feed";
import { useFeedRuntime } from "@/lib/feed/use-feed-runtime";
import { logger } from "@/lib/logger";
import { describeApiError } from "@/lib/api/api-request";
import { agentPath, parseShellRoute } from "@/lib/shell-route";

type Brief = DeepAgentRunView["brief"];

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

/** AV-03: the deep agent's task as the three parts of its brief; an empty part is left out. */
function TaskBrief() {
  const brief = useContext(BriefContext);
  const t = useTranslations("agents.brief");
  if (brief === null) return null;
  return (
    <dl className="flex flex-col gap-2">
      {BRIEF_PARTS.filter((key) => brief[key].trim() !== "").map((key) => (
        <div key={key} className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground text-xs leading-4 font-medium">{t(key)}</dt>
          <dd className="whitespace-pre-wrap">{brief[key]}</dd>
        </div>
      ))}
    </dl>
  );
}

const TasksContext = createContext<Resource<RunTaskListView> | null>(null);

/** DA-05: the deep agent's list in place of the feed on the tab «Задачи»; the composer stays under it. */
function TasksFeed() {
  const tasks = useContext(TasksContext);
  return tasks === null ? null : <RunTaskList tasks={tasks} layout="page" />;
}

const COMPONENTS: ThreadComponents = { Welcome: NoWelcome, FeedHeader: AgentFeedHeader };
const BRIEF_COMPONENTS: ThreadComponents = { ...COMPONENTS, TaskBrief };
const TASKS_COMPONENTS: ThreadComponents = { ...COMPONENTS, Feed: TasksFeed };
const BRIEF_TASKS_COMPONENTS: ThreadComponents = { ...BRIEF_COMPONENTS, Feed: TasksFeed };

type DeepAgentTabsProps = { agent: AgentPageView["agent"]; tasksTab: boolean; children: ReactNode };

/**
 * DA-04: only a deep agent's page has the tab row «Ход работы» and «Задачи · {N}» under the header; it does not
 * scroll with the content. The chosen tab is the page's address, so «Назад» returns to the previous one; the
 * list is read on open and on every `tree` note of the agent's conversation, so the count is live on both tabs.
 */
function DeepAgentTabs({ agent, tasksTab, children }: DeepAgentTabsProps) {
  const t = useTranslations("agents.tasks");
  const tasks = useRunTasks(agent.agentId, agent.threadId);
  const tab = tasksTab ? "tasks" : "activity";
  return (
    <TasksContext.Provider value={tasks}>
      <Tabs value={tab} className="h-full gap-0">
        <div className="shrink-0 px-4 pt-2">
          <TabsList className="max-md:w-full">
            <TabsTrigger
              value="activity"
              nativeButton={false}
              className="pointer-coarse:h-11"
              render={<ShellLink href={agentPath(agent.agentId)} />}
            >
              {t("tabs.activity")}
            </TabsTrigger>
            <TabsTrigger
              value="tasks"
              nativeButton={false}
              className="pointer-coarse:h-11"
              render={<ShellLink href={agentPath(agent.agentId, "tasks")} />}
            >
              {t("tabs.tasks", { count: tasks.data?.tasks.length ?? 0 })}
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value={tab} className="min-h-0 flex-1">
          {children}
        </TabsContent>
      </Tabs>
    </TasksContext.Provider>
  );
}

/**
 * The deep agent's brief (`GET /agents/:id/run`), read once when the page shows a deep agent; null for
 * any other agent, and when the read fails — 404 `RUN_NOT_FOUND` included — the task reads as text.
 */
function useDeepAgentBrief(agentId: string | null, deepAgent: boolean): Brief | null {
  const { apiClient } = useShellServices();
  const [brief, setBrief] = useState<Brief | null>(null);
  // A remount under StrictMode keeps the ref: the run is still read once.
  const requested = useRef<string | null>(null);

  useEffect(() => {
    if (agentId === null || !deepAgent || requested.current === agentId) return;
    requested.current = agentId;
    apiClient.getRun(agentId).then(
      (run) => setBrief(run.brief),
      (error: unknown) => {
        logger.warn("deep agent run read failed", { ...describeApiError(error), agentId });
      },
    );
  }, [apiClient, agentId, deepAgent]);

  return deepAgent ? brief : null;
}

/**
 * UXRD Screen 3 under the agent's `AgentFeedProvider`: the same `Thread` as a conversation on its own
 * `AssistantRuntimeProvider` (KD-1), with the meta line, the inherited history, the task or brief and
 * the composer with the MC-12 placeholder; a deep agent's page adds its tabs (deep-agents DA-04). A missing
 * agent is MC-15, any other failed read MC-16.
 */
export function AgentScreen() {
  const feed = useFeed();
  if (feed === null) throw new Error("AgentScreen must be used inside AgentFeedProvider");

  const runtime = useFeedRuntime(feed);
  const t = useTranslations("agents");
  const { libraryIndex } = useShellServices();
  // The record labels and «изменён после запуска» read the library list on every visit (KD-2).
  useEffect(() => {
    void libraryIndex.refresh();
  }, [libraryIndex, feed]);
  const agent = useFeedSelector((state) => selectAgent(state.view), null);
  const loaded = useFeedSelector((state) => state.loaded, false);
  const loadError = useFeedSelector((state) => state.loadError, null);
  const deepAgent = agent !== null && isDeepAgentRun(agent);
  const brief = useDeepAgentBrief(agent?.agentId ?? null, deepAgent);
  const route = parseShellRoute(usePathname());
  const tasksTab = deepAgent && route.kind === "agent" && route.tab === "tasks";
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

  const components = tasksTab
    ? brief === null
      ? TASKS_COMPONENTS
      : BRIEF_TASKS_COMPONENTS
    : brief === null
      ? COMPONENTS
      : BRIEF_COMPONENTS;
  const thread = (
    <AssistantRuntimeProvider runtime={runtime}>
      <BriefContext.Provider value={brief}>
        <Thread
          components={components}
          historyPending={retrying || !loaded}
          composerPlaceholder={t("composerPlaceholder", { status: agent?.status ?? "working" })}
        />
      </BriefContext.Provider>
    </AssistantRuntimeProvider>
  );
  if (agent === null || !deepAgent) return thread;
  return (
    <DeepAgentTabs agent={agent} tasksTab={tasksTab}>
      {thread}
    </DeepAgentTabs>
  );
}
