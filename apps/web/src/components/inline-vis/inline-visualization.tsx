'use client';

import { INTERNAL, useAuiState } from '@assistant-ui/react';
import type {
  CodeHeaderProps,
  MarkdownTextPrimitiveProps,
  SyntaxHighlighterProps,
} from '@assistant-ui/react-markdown';
import { CircleXIcon, CodeXmlIcon, LoaderCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type FC } from 'react';

import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { StatusGlyph } from '@/components/agents/agent-status';
import { CodeHeader } from '@/components/markdown-text';
import { useShellServices } from '@/components/shell/shell-actions';
import { Button } from '@/components/ui/button';
import { logger } from '@/lib/logger';
import { linkPolicy, type LinkPolicy } from '@/lib/markdown-policy';
import { cn } from '@/lib/utils';

import { isClosedFence } from './fence';
import {
  buildFrameDocument,
  FRAME_SANDBOX,
  readFrameMessage,
  readThemeTokens,
  type FrameMessage,
  type TokensMessage,
} from './frame-document';

const INLINE_VIS_LANGUAGE = 'inline-vis';

/** The frame's height limits in px (inline-visualization.md, «Высота»); 70 % of the window is the CSS limit. */
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 640;

/**
 * The frame's lifetime for one code: the document failed to build, or it was written and the page reports in.
 * `settled` turns on the 150 ms growth only after the first height, so the page appears in one frame.
 */
type Frame =
  | { code: string; buildError: string }
  | {
      code: string;
      srcdoc: string;
      height: number | null;
      settled: boolean;
      error: string | null;
    };

/** The block title from the fence line after the language (KD-1); hast keeps it in `data.meta`. */
function fenceTitle(node: SyntaxHighlighterProps['node']): string | null {
  const data: unknown = node?.data;
  if (typeof data !== 'object' || data === null || !('meta' in data))
    return null;
  return typeof data.meta === 'string' && data.meta.trim() !== ''
    ? data.meta.trim()
    : null;
}

/** An address the page offers that a link of the same kind in the reply would open (KD-9). */
type OfferedAddress = Extract<LinkPolicy, { kind: 'new-tab' | 'mail' }>;

/** Opens the address exactly as the reply's link of that kind: a new tab without `opener`, or the mail client. */
function openAddress(address: OfferedAddress): void {
  const link = document.createElement('a');
  link.href = address.href;
  if (address.kind === 'new-tab') {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  link.click();
  logger.info('inline-vis: address opened', {
    kind: address.kind,
    host: new URL(address.href, window.location.href).host,
  });
}

function applyMessage(
  frame: Frame,
  message: Exclude<FrameMessage, { type: 'link' }>,
): Frame {
  if (!('srcdoc' in frame)) return frame;
  // An error before the first height replaces the frame; nothing it sends afterwards counts.
  if (frame.height === null && frame.error !== null) return frame;
  if (message.type === 'height') {
    const height = Math.min(
      Math.max(Math.ceil(message.height), MIN_HEIGHT),
      MAX_HEIGHT,
    );
    return { ...frame, height, settled: frame.height !== null };
  }
  return { ...frame, error: message.message };
}

/** The status line of «Пишется» and «Готовится», announced once as `status`. */
function StatusLine() {
  const t = useTranslations('chat.inlineVis');
  return (
    <div
      role="status"
      className="text-muted-foreground flex h-9 items-center gap-2 text-sm"
    >
      <StatusGlyph Icon={LoaderCircleIcon} spinning />
      <span className="shimmer motion-reduce:animate-none">{t('drawing')}</span>
    </div>
  );
}

type CodeBlockProps = Pick<
  SyntaxHighlighterProps,
  'node' | 'components' | 'code'
>;

/** The ordinary code block of the reply: header with «Копировать», then the code. */
function PlainCodeBlock({
  node,
  components: { Pre, Code },
  code,
}: CodeBlockProps) {
  return (
    <>
      <CodeHeader node={node} language={INLINE_VIS_LANGUAGE} code={code} />
      <Pre>
        <Code node={node}>{code}</Code>
      </Pre>
    </>
  );
}

/**
 * The visualization block of a closed, non-empty fragment (design-inline-vis.md, State Transitions): the status line
 * while the document builds and the hidden frame loads, then the frame, the caption row and the code on request.
 */
function VisualizationBlock({
  title,
  writing,
  ...codeBlock
}: CodeBlockProps & { title: string | null; writing: boolean }) {
  const t = useTranslations('chat.inlineVis');
  const { announcer } = useShellServices();
  const { code } = codeBlock;
  const codeId = useId();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [codeShown, setCodeShown] = useState(false);
  const [address, setAddress] = useState<OfferedAddress | null>(null);

  // Built once per code; a late result for a code that changed, or after unmount, is dropped.
  useEffect(() => {
    if (writing) return;
    let current = true;
    buildFrameDocument(code, readThemeTokens()).then(
      (srcdoc) => {
        if (current)
          setFrame({ code, srcdoc, height: null, settled: false, error: null });
      },
      (error: unknown) => {
        if (current) setFrame({ code, buildError: String(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [code, writing]);

  const shown = !writing && frame?.code === code ? frame : null;
  const srcdoc = shown !== null && 'srcdoc' in shown ? shown.srcdoc : null;

  // Only the window of this frame is heard, and every field is data (KD-6).
  useEffect(() => {
    if (srcdoc === null) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = readFrameMessage(event.data);
      if (message === null) return;
      if (message.type === 'link') {
        const policy = linkPolicy(message.href);
        // Unsafe addresses and anchors open nothing; one offered while the dialog is open is dropped.
        if (policy.kind === 'new-tab' || policy.kind === 'mail')
          setAddress((current) => current ?? policy);
        return;
      }
      setFrame((previous) =>
        previous !== null && 'srcdoc' in previous && previous.srcdoc === srcdoc
          ? applyMessage(previous, message)
          : previous,
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [srcdoc]);

  // New theme, mode or contrast values go to the page without restarting it (KD-5, Flow 2).
  useEffect(() => {
    if (srcdoc === null) return;
    const send = () => sendTokens(iframeRef.current);
    const observer = new MutationObserver(send);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    const contrast = window.matchMedia('(prefers-contrast: more)');
    contrast.addEventListener('change', send);
    return () => {
      observer.disconnect();
      contrast.removeEventListener('change', send);
    };
  }, [srcdoc]);

  const failure =
    shown === null
      ? null
      : 'buildError' in shown
        ? { before: true, text: shown.buildError }
        : shown.error === null
          ? null
          : { before: shown.height === null, text: shown.error };
  const failedBefore = failure?.before === true;
  const failedText = failure?.text ?? null;

  useEffect(() => {
    if (failedText === null) return;
    logger.error('inline-vis: page error', {
      stage: failedBefore ? 'before-render' : 'after-render',
      error: failedText,
    });
    if (failedBefore) announcer.getState().announce('chat.inlineVis.failed');
    else
      announcer
        .getState()
        .announce('chat.inlineVis.failedAfter', { text: failedText });
  }, [failedBefore, failedText, announcer]);

  const height = shown !== null && 'srcdoc' in shown ? shown.height : null;
  const preparing = !failedBefore && height === null;
  const name = title === null ? t('untitled') : t('named', { title });

  return (
    <div className="aui-inline-vis my-3">
      {preparing && <StatusLine />}
      {failedBefore && (
        <div className="flex h-20 items-start gap-2 rounded-lg border p-3">
          <CircleXIcon
            aria-hidden
            className="text-destructive size-4 shrink-0"
          />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm leading-5">{t('failed')}</p>
            <p className="text-muted-foreground line-clamp-3 font-mono text-xs leading-4 break-all">
              {failure?.text}
            </p>
          </div>
        </div>
      )}
      {srcdoc !== null && !failedBefore && (
        <iframe
          ref={iframeRef}
          title={name}
          sandbox={FRAME_SANDBOX}
          srcDoc={srcdoc}
          onLoad={(event) => sendTokens(event.currentTarget)}
          style={{ height: height ?? 0 }}
          className={cn(
            'focus:ring-ring focus:ring-offset-background block max-h-[70vh] w-full border-0 bg-transparent outline-none focus:ring-3 focus:ring-offset-2',
            height === null && 'invisible',
            shown !== null &&
              'settled' in shown &&
              shown.settled &&
              'transition-[height] duration-(--duration-fast) motion-reduce:transition-none',
          )}
        />
      )}
      {!preparing && (
        <>
          {failure !== null && !failure.before && (
            <p className="mt-1 flex items-center gap-1.5 text-xs leading-4">
              <CircleXIcon
                aria-hidden
                className="text-destructive size-3.5 shrink-0"
              />
              <span className="min-w-0">
                {t('failedAfter', { text: failure.text })}
              </span>
            </p>
          )}
          <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
            <span
              title={title ?? undefined}
              className="text-muted-foreground min-w-0 truncate text-xs leading-4"
            >
              {title ?? t('untitled')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={codeShown}
              aria-controls={codeId}
              className="aria-pressed:bg-muted shrink-0 pointer-coarse:h-11"
              onClick={() => setCodeShown((current) => !current)}
            >
              <CodeXmlIcon aria-hidden />
              {t(codeShown ? 'hideCode' : 'showCode')}
            </Button>
          </div>
          <div
            id={codeId}
            inert={!codeShown}
            className={cn(
              'grid transition-[grid-template-rows] duration-(--duration-fast) motion-reduce:transition-none',
              codeShown ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <PlainCodeBlock {...codeBlock} />
            </div>
          </div>
        </>
      )}
      <ConfirmDialog
        open={address !== null}
        onOpenChange={(open) => {
          if (!open) setAddress(null);
        }}
        title={t('confirmTitle')}
        body={t('confirmText')}
        address={address?.href}
        confirmLabel={t('open')}
        confirmVariant="default"
        returnFocus={iframeRef}
        logEvent="inline-vis: open address"
        // Synchronous up to here: the new tab opens in the click and the browser does not block it.
        onConfirm={async () => {
          if (address !== null) openAddress(address);
        }}
      />
    </div>
  );
}

function sendTokens(iframe: HTMLIFrameElement | null) {
  const message: TokensMessage = { type: 'tokens', ...readThemeTokens() };
  iframe?.contentWindow?.postMessage(message, '*');
}

/**
 * The `inline-vis` fragment (design-inline-vis.md, KD-1, KD-2). Closed and non-empty — the visualization block; still
 * written while the text is revealed — the status line; cut off or empty — the ordinary code block.
 */
const InlineVisualization: FC<SyntaxHighlighterProps> = ({
  node,
  components,
  code,
}) => {
  const partText = useAuiState((s) =>
    s.part.type === 'text' ? s.part.text : '',
  );
  const running = INTERNAL.useSmoothStatus(
    (status) => status.type === 'running',
  );
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  const closed =
    start !== undefined &&
    end !== undefined &&
    isClosedFence(partText.slice(start, end));
  const writing = !closed && running;

  if (!writing && (!closed || code.trim() === '')) {
    return <PlainCodeBlock node={node} components={components} code={code} />;
  }
  return (
    <VisualizationBlock
      node={node}
      components={components}
      code={code}
      title={fenceTitle(node)}
      writing={writing}
    />
  );
};

/** The fragment draws its own header, or the ordinary code block's. */
const NoCodeHeader: FC<CodeHeaderProps> = () => null;

/** The languages the reply's text draws itself: the feed, the agent report and the notepad document (KD-1). */
export const visualizationLanguages = {
  [INLINE_VIS_LANGUAGE]: {
    CodeHeader: NoCodeHeader,
    SyntaxHighlighter: InlineVisualization,
  },
} satisfies NonNullable<MarkdownTextPrimitiveProps['componentsByLanguage']>;
