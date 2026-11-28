'use client';

import { useEffect, useId, useState } from 'react';
import { TextMessagePartProvider } from '@assistant-ui/react';
import { ArrowLeft, CopyIcon, LoaderCircle } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useStore } from 'zustand';
import type { Document, ThreadDocumentsView } from '@agent-os/contracts';
import { useReloadOnChange } from '@/components/agents/session-task-list';
import { MarkdownText } from '@/components/markdown-text';
import { useShellServices } from '@/components/shell/shell-actions';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useResource, type Resource } from '@/hooks/use-resource';
import { formatListTime } from '@/i18n/formats';

/** The lines of a collapsed document in the feed (agent-report.md, part 7). */
const COLLAPSED_LINES = 24;

/** The characters of a collapsed document in the feed: one Markdown line may be a whole paragraph. */
const COLLAPSED_CHARS = 3_000;

const NO_DOCUMENTS: ThreadDocumentsView = { documents: [] };

/** The conversation's documents of every run; a null `threadId` reads as none, without a request. */
export function useThreadDocuments(
  threadId: string | null,
): Resource<ThreadDocumentsView> {
  const { apiClient } = useShellServices();
  const documents = useResource(
    () =>
      threadId === null
        ? Promise.resolve(NO_DOCUMENTS)
        : apiClient.getThreadDocuments(threadId),
    threadId ?? '',
    'agents',
  );
  useReloadOnChange(threadId, documents.reload);
  return documents;
}

/**
 * One document of the conversation; null when there is no conversation or no document to read, without a request.
 * Read again on live changes only while it can change: until it is read, and while its run is writing it.
 */
export function useThreadDocument(
  threadId: string | null,
  documentId: number | null,
): Resource<Document | null> {
  const { apiClient } = useShellServices();
  const document = useResource<Document | null>(
    () =>
      threadId === null || documentId === null
        ? Promise.resolve(null)
        : apiClient.getThreadDocument(threadId, documentId),
    `${threadId ?? ''}|${documentId ?? ''}`,
    'agents',
  );
  const changing = documentId !== null && document.data?.writing !== false;
  useReloadOnChange(changing ? threadId : null, document.reload);
  return document;
}

/** MC-13 «Не удалось загрузить документ» with «Повторить», the same in the feed and in the panel. */
function DocumentError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('agents.documents');
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <p className="text-foreground text-sm leading-5">{t('loadError')}</p>
      <Button
        variant="outline"
        size="sm"
        className="pointer-coarse:h-11"
        onClick={onRetry}
      >
        {t('retry')}
      </Button>
    </div>
  );
}

function TextSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-2">
      {['w-11/12', 'w-5/6', 'w-2/3'].map((width) => (
        <Skeleton
          key={width}
          className={`h-4 ${width} motion-reduce:animate-none`}
        />
      ))}
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <TextMessagePartProvider text={text}>
      <MarkdownText imagesAsFallback />
    </TextMessagePartProvider>
  );
}

/** The first 24 lines and at most 3 000 characters, whichever is shorter, cut at a line break where there is one. */
function collapsedText(text: string): string {
  const lines = text.split('\n').slice(0, COLLAPSED_LINES).join('\n');
  if (lines.length <= COLLAPSED_CHARS) return lines;
  const cut = lines.slice(0, COLLAPSED_CHARS);
  const lastBreak = cut.lastIndexOf('\n');
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
}

/** «Пишется» beside a document the run is still writing; not announced (agent-report.md, Accessibility). */
function Writing() {
  const t = useTranslations('agents.documents');
  return (
    <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs leading-4">
      <LoaderCircle
        aria-hidden
        className="size-3.5 animate-spin motion-reduce:animate-none"
      />
      {t('writing')}
    </span>
  );
}

/**
 * Part 7 «Документ» of a deep agent's report (agent-report.md; UXRD DC-01): title, description and the text cut to
 * 24 lines with «Показать полностью» / «Свернуть»; «Открыть в панели» where the conversation has the panel.
 */
export function ReportDocument({
  title,
  document,
  onOpenInPanel,
}: {
  /** The title the report names, shown before the document is read. */
  title: string;
  document: Resource<Document | null>;
  onOpenInPanel: (() => void) | null;
}) {
  const t = useTranslations('agents.documents');
  const [expanded, setExpanded] = useState(false);
  const textId = useId();
  const data = document.data ?? null;
  const text = data?.text ?? '';
  const collapsed = collapsedText(text);
  const collapsible = collapsed.length < text.length;
  const shown = collapsible && !expanded ? collapsed : text;

  return (
    <section
      aria-label={title}
      className="mt-3 flex flex-col gap-1 rounded-md border p-3"
    >
      <h3 className="text-base leading-6 font-semibold">{title}</h3>
      {data !== null && (
        <p className="text-muted-foreground text-xs leading-4 font-medium">
          {data.description}
        </p>
      )}
      <div id={textId} className="mt-2">
        {document.status === 'loading' ? (
          <TextSkeleton />
        ) : data === null ? (
          <DocumentError onRetry={document.reload} />
        ) : (
          <Markdown text={shown} />
        )}
      </div>
      {data !== null && (collapsible || onOpenInPanel !== null) && (
        <div className="mt-1 flex flex-wrap gap-1">
          {collapsible && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              aria-controls={textId}
              className="pointer-coarse:h-11"
              onClick={() => setExpanded((current) => !current)}
            >
              {t(expanded ? 'collapse' : 'showAll')}
            </Button>
          )}
          {onOpenInPanel !== null && (
            <Button
              variant="ghost"
              size="sm"
              className="pointer-coarse:h-11"
              onClick={onOpenInPanel}
            >
              {t('openInPanel')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The tab «Документы» (UXRD DC-02): the conversation's documents, newest first, or the one the employee opened. A
 * document the list does not hold — one of another conversation — reads as the list.
 */
export function DocumentsTab({
  threadId,
  documents,
}: {
  threadId: string | null;
  documents: Resource<ThreadDocumentsView>;
}) {
  const { workspace } = useShellServices();
  const openId = useStore(workspace, (state) => state.document);
  const listed =
    documents.data?.documents.some((document) => document.id === openId) ??
    false;
  const open = useThreadDocument(threadId, listed ? openId : null);

  if (documents.status === 'loading') return <TextSkeleton />;
  if (documents.data === undefined)
    return <DocumentError onRetry={documents.reload} />;
  if (!listed) {
    return (
      <DocumentList
        documents={documents.data}
        onOpen={(id) => workspace.show({ document: id, focusHeading: false })}
      />
    );
  }
  return (
    <PanelDocument
      document={open}
      onBack={() => workspace.setTab('documents')}
    />
  );
}

function DocumentList({
  documents,
  onOpen,
}: {
  documents: ThreadDocumentsView;
  onOpen: (id: number) => void;
}) {
  const t = useTranslations('agents.documents');
  const format = useFormatter();
  return (
    <ul
      aria-label={t('listLabel')}
      className="divide-border flex flex-col divide-y"
    >
      {documents.documents.map((document) => (
        <li key={document.id}>
          <button
            type="button"
            onClick={() => onOpen(document.id)}
            className="hover:bg-accent focus-visible:ring-ring flex w-full flex-col gap-0.5 px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset pointer-coarse:min-h-11"
          >
            <span className="flex w-full min-w-0 items-center justify-between gap-2">
              <span className="text-foreground min-w-0 truncate text-sm leading-5">
                {document.title}
              </span>
              {document.writing && <Writing />}
            </span>
            <span className="text-muted-foreground w-full truncate text-xs leading-4">
              {document.description}
            </span>
            <span className="text-muted-foreground text-xs leading-4 tabular-nums">
              {`${document.writer} · ${formatListTime(format, document.updatedAt)}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Variant «Документ в панели» (agent-report.md): back arrow, title, description, the whole text and «Копировать». */
function PanelDocument({
  document,
  onBack,
}: {
  document: Resource<Document | null>;
  onBack: () => void;
}) {
  const t = useTranslations('agents.documents');
  const data = document.data ?? null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <TooltipIconButton tooltip={t('back')} onClick={onBack}>
          <ArrowLeft />
        </TooltipIconButton>
        {data !== null && (
          <>
            <h3 className="min-w-0 flex-1 truncate text-base leading-6 font-semibold">
              {data.title}
            </h3>
            {data.writing && <Writing />}
          </>
        )}
      </div>
      {document.status === 'loading' ? (
        <TextSkeleton />
      ) : data === null ? (
        <DocumentError onRetry={document.reload} />
      ) : (
        <>
          <p className="text-muted-foreground text-xs leading-4 font-medium">
            {data.description}
          </p>
          <Markdown text={data.text} />
          <PanelCopy text={data.text} />
        </>
      )}
    </div>
  );
}

function PanelCopy({ text }: { text: string }) {
  const { announcer } = useShellServices();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const t = useTranslations('chat');
  useEffect(() => {
    if (isCopied) announcer.getState().announce('announce.copied');
  }, [isCopied, announcer]);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="self-start pointer-coarse:h-11"
      onClick={() => copyToClipboard(text)}
    >
      <CopyIcon aria-hidden />
      {t('copy')}
    </Button>
  );
}
