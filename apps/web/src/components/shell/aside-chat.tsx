'use client';

import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  type AssistantState,
} from '@assistant-ui/react';
import { LoaderCircle, MessageSquareQuote } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Thread,
  type ThreadComponents,
} from '@/components/assistant-ui/elements/thread.aui';
import { Button } from '@/components/ui/button';
import {
  FeedProvider,
  useFeed,
  useFeedSelector,
} from '@/lib/feed/feed-context';
import type { FeedState, FeedStore } from '@/lib/feed/feed-store';
import { canFork, feedSeqOf, selectThreadId } from '@/lib/feed/to-feed';
import { useFeedRuntime } from '@/lib/feed/use-feed-runtime';
import { focusShellTarget, shellTargetElement } from '@/lib/focus';
import type { AsideChat } from '@/lib/shell/workspace-store';
import { threadPath } from '@/lib/shell-route';
import { useShellServices } from './shell-actions';
import { ShellLink } from './shell-link';
import { ThreadNotice } from './thread-notice';
import {
  messageTextOf,
  ToMainChatButton,
  ToMainChatPopover,
} from './to-main-chat';
import { useForkThread } from './use-open-branch';

/**
 * The side chat (improvements design-web.md KD-1, Flow 1; UXRD IM-05, IM-06): a branch of the conversation cut after
 * an answer, shown on the panel's tab «В стороне» while the conversation stays on screen. Its feed is a second
 * runtime over the branch's own store, as on an agent page; the live stream watches only the main conversation,
 * so the branch's answer arrives whole with its `tree` note.
 */

/** The longest quote put in the branch's field (IM-05). */
const QUOTE_MAX_LENGTH = 200;

/**
 * The start of the answer as one Markdown quote line, at most 200 characters with «…» cut at a word boundary, and an
 * empty line under it for the question (IM-05).
 */
function quoteOf(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= QUOTE_MAX_LENGTH) return `> ${line}\n\n`;
  const head = line.slice(0, QUOTE_MAX_LENGTH - 1);
  const boundary = head.lastIndexOf(' ');
  const cut = (boundary > 0 ? head.slice(0, boundary) : head).trimEnd();
  return `> ${cut}…\n\n`;
}

const threadIdOf = (state: FeedState): string | null =>
  selectThreadId(state.view);

/** The answer's history number when it is an answer without tool calls, the only boundary a side chat takes (KD-3). */
const toolFreeSeqOf = (s: AssistantState): number | null => {
  const custom = s.message.metadata.custom;
  return custom['kind'] === 'answer' && custom['toolFree'] === true
    ? feedSeqOf(s.message.id)
    : null;
};

const askKey = (threadId: string, seq: number): string => `${threadId}:${seq}`;

/**
 * Where focus goes when the panel closes on «В стороне» (UXRD Accessibility): the «Спросить в стороне» of the answer
 * the branch was asked from while it is on screen, otherwise the main composer.
 */
export function asideReturnElement(aside: AsideChat): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(
      `[data-aside-ask="${CSS.escape(askKey(aside.threadId, aside.throughSeq))}"]`,
    ) ?? shellTargetElement('composer')
  );
}

/** «Спросить в стороне» (IM-05) after «Копировать» of an answer without tool calls, while the conversation can be forked. */
export const AskAsideButton: FC = () => {
  const t = useTranslations('chat.aside');
  const { workspace, composerSeed, announcer } = useShellServices();
  const seq = useAuiState(toolFreeSeqOf);
  const text = useAuiState(messageTextOf);
  const threadId = useFeedSelector(threadIdOf, null);
  const forkable = useFeedSelector((state) => canFork(state.view), false);
  const fork = useForkThread();
  const feed = useFeed();
  const [pending, setPending] = useState(false);

  if (seq === null || threadId === null || !forkable) return null;

  const ask = async (): Promise<void> => {
    setPending(true);
    const branch = await fork(threadId, { throughSeq: seq });
    setPending(false);
    // A refusal is logged and noticed by the fork; the tab does not open (FR-09).
    if (branch === null) return;
    // The conversation stays on screen: its re-read brings the header's count of branches.
    void feed?.load();
    composerSeed.put(branch.id, { text: quoteOf(text) });
    workspace.openAside({ branchId: branch.id, threadId, throughSeq: seq });
    focusShellTarget('aside-composer');
    announcer.getState().announce('announce.asideOpened');
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      data-aside-ask={askKey(threadId, seq)}
      onClick={() => void ask()}
    >
      {pending ? (
        <LoaderCircle className="animate-spin" aria-hidden />
      ) : (
        <MessageSquareQuote aria-hidden />
      )}
      {t('ask')}
    </Button>
  );
};

const LINK_CLASS =
  'text-foreground focus-visible:ring-ring self-start truncate rounded-sm text-sm leading-5 font-medium underline underline-offset-2 outline-none focus-visible:ring-2';

/** «Копировать» and, on an answer, «В основной чат» (IM-06, IM-07); no «Спросить в стороне» and no «Изменить». */
const ASIDE_COMPONENTS: ThreadComponents = {
  AssistantActions: ToMainChatButton,
};

/**
 * The tab «В стороне» (IM-06): the branch's title as a link to its page, its feed and composer, and the popover over a
 * selection in its messages (IM-07). The field takes the quote once and is its own focus target. A history that does
 * not load shows the main feed's notice. Keyed by the branch at its use, so a new side chat starts with a fresh runtime.
 */
export function AsideChatTab({ aside }: { aside: AsideChat }) {
  const { feeds } = useShellServices();
  const feed = useMemo(
    () => feeds.forThread(aside.branchId),
    [feeds, aside.branchId],
  );
  const runtime = useFeedRuntime(feed);
  const rootRef = useRef<HTMLDivElement>(null);

  return (
    <FeedProvider feed={feed}>
      <div
        ref={rootRef}
        data-slot="aside-chat"
        className="flex h-full min-h-0 flex-col gap-2"
      >
        <AsideTitle branchId={aside.branchId} />
        <div className="min-h-0 flex-1">
          <AssistantRuntimeProvider runtime={runtime}>
            <AsideThread branchId={aside.branchId} feed={feed} />
          </AssistantRuntimeProvider>
        </div>
        <ToMainChatPopover root={rootRef} />
      </div>
    </FeedProvider>
  );
}

/** The branch's title as a link to its page; nothing until its history is read. */
function AsideTitle({ branchId }: { branchId: string }) {
  const title = useFeedSelector(
    (state) => (state.view?.kind === 'thread' ? state.view.thread.title : null),
    null,
  );
  if (title === null) return null;
  return (
    <ShellLink href={threadPath(branchId)} className={LINK_CLASS}>
      {title}
    </ShellLink>
  );
}

function AsideThread({
  branchId,
  feed,
}: {
  branchId: string;
  feed: FeedStore;
}) {
  const aui = useAui();
  const { composerSeed } = useShellServices();
  const loaded = useFeedSelector((state) => state.loaded, false);
  const loadError = useFeedSelector((state) => state.loadError, null);

  // The tab moves between the panel and the drawer at 1024 px and mounts anew with a fresh runtime: the unsent
  // text goes back to the seed, and the new field takes it.
  useEffect(
    () => () => {
      const text = aui.composer.getState().text;
      if (text !== '') composerSeed.put(branchId, { text });
    },
    [aui, composerSeed, branchId],
  );

  const retry = async (): Promise<void> => {
    await feed.load();
    if (feed.getState().loaded) focusShellTarget('aside-composer');
  };

  if (!loaded && loadError === 'not_found')
    return <ThreadNotice variant="aside-not-found" />;
  if (!loaded && loadError === 'failed')
    return (
      <ThreadNotice variant="aside-load-error" onRetry={() => void retry()} />
    );
  return (
    <Thread
      components={ASIDE_COMPONENTS}
      historyPending={!loaded}
      textTarget={branchId}
      focusTarget="aside-composer"
    />
  );
}
