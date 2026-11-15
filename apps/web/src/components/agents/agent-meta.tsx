"use client";

import Link from "next/link";
import type { AgentPageView } from "@agent-os/contracts";
import { AgentStatus } from "@/components/agents/agent-status";
import { UNTITLED_THREAD_TITLE } from "@/components/shell/thread-history-item";
import { formatModel, formatTime } from "@/lib/agents/format";
import { agentPath, threadPath } from "@/lib/shell-route";

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
 * workflow coordinator names its template instead (A-1). Below 768 px the line opens with the status,
 * which the header shows from 768 px (UXRD Screen 3). No tokens, no cost (AC-13.2).
 */
export function AgentMeta({ agent }: { agent: AgentPageView["agent"] }) {
  const model = formatModel(agent.model);
  const started = (
    <span>
      запущен{" "}
      <time dateTime={agent.createdAt} className="tabular-nums">
        {formatTime(agent.createdAt)}
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
      {agent.template !== undefined ? (
        <>
          <span>Workflow «{agent.template.title}»</span>
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
