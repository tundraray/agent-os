"use client";

import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import type { AgentPageView, RunOrigin } from "@agent-os/contracts";
import { AgentStatus } from "@/components/agents/agent-status";
import { ChangedAfterRun, runRecord, useLiveRecord } from "@/components/agents/run-card";
import { RecordLabel } from "@/components/library/record-label";
import { formatModel } from "@/lib/agents/format";
import { builtinName } from "@/lib/i18n/builtin-name";
import { formatListTime } from "@/lib/i18n/formats";
import { isDeepAgentRun } from "@/lib/feed/to-feed";
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
 * deep agent names its record instead (A-1; deep-agents MC-21). Below 768 px the line opens with the status,
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
  const locale = useLocale();
  return (
    <>
      <RecordLabel origin={{ ...origin, name: builtinName(origin, locale) }} variant="under" showVersion href={recordPath(origin.recordId)} />
      <ChangedAfterRun origin={origin} live={live} />
    </>
  );
}

function AgentMetaLine({ agent }: { agent: AgentPageView["agent"] }) {
  const format = useFormatter();
  const locale = useLocale();
  const t = useTranslations("agents.meta");
  const tShell = useTranslations("shell");
  const model = formatModel(agent.model);
  const parent =
    agent.parentDescription !== undefined && agent.parentId !== null
      ? { agentId: agent.parentId, description: agent.parentDescription }
      : null;
  const started = (
    <span>
      {t.rich("started", {
        at: formatListTime(format, agent.createdAt),
        time: (chunks) => (
          <time dateTime={agent.createdAt} className="tabular-nums">
            {chunks}
          </time>
        ),
      })}
    </span>
  );

  return (
    <p
      data-slot="agent-meta"
      className="text-muted-foreground flex min-h-5 flex-wrap items-center gap-x-1 text-xs leading-4"
    >
      <AgentStatus variant="label" status={agent.status} className="md:hidden" />
      <Separator className="md:hidden" />
      {isDeepAgentRun(agent) ? (
        <>
          <span>
            {t("deepAgent", { name: builtinName({ builtinKey: agent.origin?.builtinKey ?? null, name: agent.name }, locale) })}
          </span>
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
          {parent !== null ? (
            <span>
              {t.rich("fromAgent", {
                name: parent.description,
                link: (chunks) => (
                  <Link href={agentPath(parent.agentId)} className={LINK_CLASS}>
                    {chunks}
                  </Link>
                ),
              })}
            </span>
          ) : (
            <span>
              {t.rich("fromChat", {
                title: agent.threadTitle ?? tShell("thread.untitled"),
                link: (chunks) => (
                  <Link href={threadPath(agent.threadId)} className={LINK_CLASS}>
                    {chunks}
                  </Link>
                ),
              })}
            </span>
          )}
        </>
      )}
    </p>
  );
}
