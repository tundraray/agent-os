"use client";

import Link from "next/link";
import { useFormatter } from "next-intl";
import type { AgentPageView, RunOrigin } from "@agent-os/contracts";
import { AgentStatus } from "@/components/agents/agent-status";
import { ChangedAfterRun, runRecord, useLiveRecord } from "@/components/agents/run-card";
import { RecordLabel } from "@/components/library/record-label";
import { UNTITLED_THREAD_TITLE } from "@/components/shell/thread-history-item";
import { formatModel } from "@/lib/agents/format";
import { formatListTime } from "@/lib/i18n/formats";
import { isWorkflowCoordinator } from "@/lib/feed/to-feed";
import { agentPath, recordPath, threadPath } from "@/lib/shell-route";

const LINK_CLASS =
  "text-foreground underline-offset-2 hover:underline focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center";

const Separator = ({ className }: { className?: string }) => (
  <span aria-hidden className={className}>
    ·
  </span>
);

/**
 * AV-02, MC-8: the first line of the agent page's feed — model, start time and where the agent came
 * from: the conversation, or the parent agent when the parent is not the conversation's root (A-2); a
 * workflow coordinator names its workflow instead (A-1). Below 768 px the line opens with the status,
 * which the header shows from 768 px (UXRD Screen 3). No tokens, no cost (AC-13.2). An agent from the
 * library gets the second line of RN-03 below.
 */
export function AgentMeta({ agent }: { agent: AgentPageView["agent"] }) {
  const record = runRecord(agent);
  const line = <AgentMetaLine agent={agent} />;
  if (record === null) return line;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {line}
      <AgentRecordLine origin={record} />
    </div>
  );
}

/**
 * RN-03: the record label with the start version, the name linking to the record page; MC-17 «изменён после
 * запуска» under it without a button of its own — the page restarts only by «Запустить с нуля».
 */
function AgentRecordLine({ origin }: { origin: RunOrigin }) {
  const live = useLiveRecord(origin.recordId);
  return (
    <>
      <RecordLabel origin={origin} variant="under" showVersion href={recordPath(origin.recordId)} />
      <ChangedAfterRun origin={origin} live={live} />
    </>
  );
}

function AgentMetaLine({ agent }: { agent: AgentPageView["agent"] }) {
  const format = useFormatter();
  const model = formatModel(agent.model);
  const started = (
    <span>
      запущен{" "}
      <time dateTime={agent.createdAt} className="tabular-nums">
        {formatListTime(format, agent.createdAt)}
      </time>
    </span>
  );

  return (
    <p
      data-slot="agent-meta"
      className="text-muted-foreground flex min-h-5 flex-wrap items-center gap-x-1 text-xs leading-4"
    >
      <AgentStatus variant="label" status={agent.status} className="md:hidden" />
      <Separator className="md:hidden" />
      {isWorkflowCoordinator(agent) ? (
        <>
          <span>Workflow «{agent.name}»</span>
          <Separator />
          <span>координатор</span>
          <Separator />
          <span>{model}</span>
          <Separator />
          {started}
        </>
      ) : (
        <>
          <span>{model}</span>
          <Separator />
          {started}
          <Separator />
          {agent.parentDescription !== undefined && agent.parentId !== null ? (
            <span>
              запущен агентом «
              <Link href={agentPath(agent.parentId)} className={LINK_CLASS}>
                {agent.parentDescription}
              </Link>
              »
            </span>
          ) : (
            <span>
              из беседы «
              <Link href={threadPath(agent.threadId)} className={LINK_CLASS}>
                {agent.threadTitle ?? UNTITLED_THREAD_TITLE}
              </Link>
              »
            </span>
          )}
        </>
      )}
    </p>
  );
}
