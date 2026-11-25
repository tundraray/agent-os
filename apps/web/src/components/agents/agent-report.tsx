'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { TextMessagePartProvider, useAuiState } from '@assistant-ui/react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { AgentStatus } from '@/components/agents/agent-status';
import {
  ReportDocument,
  useThreadDocument,
} from '@/components/agents/notepad-document';
import { MarkdownText } from '@/components/markdown-text';
import { useShellServices } from '@/components/shell/shell-actions';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { failureReasonText } from '@/lib/agents/format';
import { formatDuration, formatListTime } from '@/i18n/formats';
import { useFeedSelector } from '@/lib/feed/feed-context';
import type { FeedState } from '@/lib/feed/feed-store';
import type { ReportPartData } from '@/lib/feed/to-feed';
import { agentPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import type { AgentsTranslator, ErrorsTranslator } from '@/i18n/catalog';

/** MC-18: «Причина: …» of a failed or stopped child; a completed one has none. */
function reasonLine(
  t: ErrorsTranslator,
  tAgents: AgentsTranslator,
  data: ReportPartData,
): { text: string; hint: string | null } | null {
  if (data.status === 'completed') return null;
  if (data.status === 'stopped') {
    // The parent hears of a stop only when the child was the stopped one; a child stopped with its
    // parent reports to a stopped parent.
    const withParent = data.reason === 'stopped_with_parent' ? 'yes' : 'no';
    return {
      text: t('reportReason', {
        reason: tAgents('report.stopped', { withParent }),
      }),
      hint: null,
    };
  }
  const { text, hint } = failureReasonText(t, data.reason);
  return { text: t('reportReason', { reason: text }), hint };
}

/** The conversation the report stands in: the open one, or the agent page's own. */
const selectThread = (state: FeedState): string | null =>
  state.view?.kind === 'thread'
    ? state.view.threadId
    : state.view?.kind === 'agent'
      ? state.view.agent.threadId
      : null;

/** The panel with «Документы» is on a conversation only (UXRD KD-1). */
const selectInChat = (state: FeedState): boolean =>
  state.view?.kind === 'thread';

/**
 * TH-10 «Копировать» under the report: the last message shows it at rest, earlier ones on hover or focus
 * and always under a coarse pointer; «Скопировано» goes to the shell's only live region.
 */
function ReportCopy({ text }: { text: string }) {
  const { announcer } = useShellServices();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const isLast = useAuiState((s) => s.message.isLast);
  const t = useTranslations('chat');

  useEffect(() => {
    if (isCopied) announcer.getState().announce('announce.copied');
  }, [isCopied, announcer]);

  return (
    <div
      className={cn(
        'text-muted-foreground ms-2 mt-1 flex h-7 items-center',
        !isLast &&
          'opacity-0 transition-opacity duration-(--duration-fast) group-hover/report:opacity-100 group-focus-within/report:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none',
      )}
    >
      <TooltipIconButton
        tooltip={t('copy')}
        onClick={() => copyToClipboard(text)}
      >
        {isCopied ? (
          <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out motion-reduce:animate-none" />
        ) : (
          <CopyIcon className="animate-in zoom-in-75 fade-in duration-150 motion-reduce:animate-none" />
        )}
      </TooltipIconButton>
    </div>
  );
}

/**
 * The report of a child agent or deep agent that reached its parent (agent-report.md, UXRD CV-02, MC-18):
 * «Отчёт · {описание}» with the status, the notice line, the reason of a failure or stop and the report
 * in Markdown, or «Отчёта нет.».
 */
export function AgentReport({ data }: { data: ReportPartData }) {
  const format = useFormatter();
  const t = useTranslations('formats');
  const tErrors = useTranslations('errors');
  const tAgents = useTranslations('agents');
  const reason = reasonLine(tErrors, tAgents, data);
  const { workspace } = useShellServices();
  const threadId = useFeedSelector(selectThread, null);
  const inChat = useFeedSelector(selectInChat, false);
  const reportDocument = data.document;
  // An inherited report's document stays with the source conversation: it is not read (state «В ветке»).
  const document = useThreadDocument(
    threadId,
    data.inherited ? null : (reportDocument?.id ?? null),
  );
  // A report with a document copies the document's text (agent-report.md, part 7).
  const copyText =
    reportDocument === null || data.inherited
      ? data.text
      : (document.data?.text ?? null);
  const notice = `${t('toolCallCount', { count: data.toolCalls })} · ${formatDuration(t, data.durationMs)} · ${formatListTime(format, data.createdAt)}`;

  return (
    <div className="group/report mx-auto w-full max-w-(--prose-max-width)">
      <article
        aria-label={tAgents('report.label', { description: data.description })}
        data-slot="agent-report"
        data-status={data.status}
        className="bg-card text-card-foreground rounded-lg border p-4"
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h2 className="flex min-w-0 text-base leading-6 font-semibold">
            {tAgents.rich('report.title', {
              description: data.description,
              prefix: (chunks) => (
                <span className="shrink-0 whitespace-pre">{chunks}</span>
              ),
              link: (chunks) =>
                data.inherited ? (
                  <span title={data.description} className="min-w-0 truncate">
                    {chunks}
                  </span>
                ) : (
                  <Link
                    href={agentPath(data.agentId)}
                    title={data.description}
                    className="focus-visible:ring-ring min-w-0 truncate rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2"
                  >
                    {chunks}
                  </Link>
                ),
            })}
          </h2>
          <AgentStatus
            variant="label"
            status={data.status}
            className="shrink-0"
          />
        </div>
        <p className="text-muted-foreground mt-1 text-xs leading-4 font-medium tabular-nums">
          {notice}
        </p>
        {reason !== null && (
          <p
            title={reason.hint ?? undefined}
            className="mt-1 text-sm leading-5"
          >
            {reason.text}
          </p>
        )}
        <div className="mt-3">
          {data.text === null ? (
            <p className="text-muted-foreground text-sm leading-5">
              {tAgents('report.empty')}
            </p>
          ) : (
            <TextMessagePartProvider text={data.text}>
              <MarkdownText />
            </TextMessagePartProvider>
          )}
        </div>
        {reportDocument !== null && data.inherited && (
          <section
            aria-label={reportDocument.title}
            className="mt-3 flex flex-col gap-1 rounded-md border p-3"
          >
            <h3 className="text-base leading-6 font-semibold">
              {reportDocument.title}
            </h3>
            <p className="text-muted-foreground text-sm leading-5">
              {tAgents('report.inBranch')}
            </p>
          </section>
        )}
        {reportDocument !== null && !data.inherited && (
          <ReportDocument
            title={reportDocument.title}
            document={document}
            onOpenInPanel={
              inChat
                ? () =>
                    workspace.show({
                      tab: 'documents',
                      document: reportDocument.id,
                      focusHeading: true,
                    })
                : null
            }
          />
        )}
      </article>
      {copyText !== null && <ReportCopy text={copyText} />}
    </div>
  );
}
