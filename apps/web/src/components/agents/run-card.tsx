"use client";

import { useState } from "react";
import Link from "next/link";
import type { AgentNode } from "@agent-os/contracts";
import { ArrowUpRightIcon } from "lucide-react";
import { AgentStatus } from "@/components/agents/agent-status";
import { AGENT_STATUS_LABEL, formatTime } from "@/lib/agents/format";
import type { RunCardPartData } from "@/lib/feed/to-feed";
import { agentPath } from "@/lib/shell-route";
import { cn } from "@/lib/utils";

const LINK_CLASS =
  "text-primary focus-visible:ring-ring inline-flex shrink-0 items-center gap-1 rounded-sm text-sm leading-5 outline-none hover:underline focus-visible:ring-2 pointer-coarse:h-11";

export type RunCardProps = {
  /** The started agent or workflow coordinator with its subtree. */
  data: RunCardPartData;
};

function byCreation(a: AgentNode, b: AgentNode): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** One agent the coordinator started: a 28 px link row; a row added after mount opens over 150 ms. */
function StepRow({ step, appeared }: { step: AgentNode; appeared: boolean }) {
  return (
    <li
      className={cn(
        "h-7 pointer-coarse:h-11",
        appeared &&
          "overflow-hidden transition-[height] duration-(--duration-fast) starting:h-0 motion-reduce:transition-none",
      )}
    >
      <Link
        href={agentPath(step.agentId)}
        aria-label={`${step.description}, ${AGENT_STATUS_LABEL[step.status]}`}
        title={step.description}
        className="hover:bg-accent focus-visible:ring-ring flex h-full min-w-0 items-center gap-2 rounded-md px-1 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <AgentStatus variant="icon" status={step.status} className="shrink-0" />
        <span className="min-w-0 truncate">{step.description}</span>
      </Link>
    </li>
  );
}

/**
 * The live run card of agent-run-card.md (UXRD CV-01, MC-17): the «Workflow» variant exactly when the
 * node has a `template` — title `template.title`, steps its `children` in creation order — otherwise
 * the one-line «Агент». Status changes recolour icons and labels only; the card never changes height.
 */
export function RunCard({ data }: RunCardProps) {
  const briefQuestion = data.briefQuestion;
  const statusLabel = AGENT_STATUS_LABEL[data.status];
  const time = (
    <time dateTime={data.createdAt} className="text-muted-foreground shrink-0 text-xs leading-4 font-medium tabular-nums">
      {formatTime(data.createdAt)}
    </time>
  );
  // Rows present at first render (a reload, a re-read) do not animate; only steps added later open.
  const [initialStepIds] = useState(() => new Set(data.children.map((child) => child.agentId)));

  if (data.template === undefined) {
    return (
      <div
        role="group"
        aria-label={`${data.description}: ${statusLabel}`}
        data-slot="run-card"
        data-variant="agent"
        className="bg-card text-card-foreground mx-auto flex w-full max-w-(--prose-max-width) min-w-0 items-center gap-3 rounded-lg border px-3 py-2"
      >
        <AgentStatus variant="label" status={data.status} className="shrink-0" />
        <span title={data.description} className="min-w-0 flex-1 truncate text-sm leading-5 font-medium">
          {data.description}
        </span>
        {time}
        <Link
          href={agentPath(data.agentId)}
          aria-label={`Открыть агента «${data.description}»`}
          className={LINK_CLASS}
        >
          Открыть
          <ArrowUpRightIcon aria-hidden className="size-3.5" />
        </Link>
      </div>
    );
  }

  const title = data.template.title;
  const steps = [...data.children].sort(byCreation);
  return (
    <div
      role="group"
      aria-label={`${title}: ${statusLabel}`}
      data-slot="run-card"
      data-variant="workflow"
      className="bg-card text-card-foreground mx-auto flex w-full max-w-(--prose-max-width) min-w-0 flex-col gap-1 rounded-lg border p-3"
    >
      <div className="flex h-6 min-w-0 items-center gap-3">
        <AgentStatus variant="label" status={data.status} className="shrink-0" />
        <span title={title} className="min-w-0 flex-1 truncate text-sm leading-5 font-medium">
          {title}
        </span>
        {time}
      </div>
      {briefQuestion !== undefined && (
        <p title={briefQuestion} className="text-muted-foreground truncate text-sm leading-5">
          {briefQuestion}
        </p>
      )}
      {steps.length > 0 && (
        <ul className="flex flex-col">
          {steps.map((step) => (
            <StepRow key={step.agentId} step={step} appeared={!initialStepIds.has(step.agentId)} />
          ))}
        </ul>
      )}
      <Link href={agentPath(data.agentId)} className={cn(LINK_CLASS, "self-start")}>
        Открыть запуск
        <ArrowUpRightIcon aria-hidden className="size-3.5" />
      </Link>
    </div>
  );
}
