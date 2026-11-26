'use client';

import type { MouseEvent, ReactNode } from 'react';
import type { ConversationMatch, MarkedText } from '@agent-os/contracts';
import { useFormatter, useTranslations } from 'next-intl';
import { formatListTime } from '@/i18n/formats';
import { agentPath, threadPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { ShellLink } from './shell-link';
import { THREAD_LINK_ATTRIBUTE } from './thread-history-item';

/** Marks a match link: ↑/↓ of the match list and ↓ from the search field move focus between these. */
export const SEARCH_RESULT_ATTRIBUTE = 'data-search-result';

/**
 * The text with each found range in `mark` (search-result.md, Accessibility): weight and colour, no fill.
 * Ranges come from the API as data, so the text is never parsed as HTML.
 */
function MarkedTextView({ text, marks }: MarkedText): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const { start, end } of marks) {
    const from = Math.max(start, at);
    const to = Math.min(end, text.length);
    if (from >= to) continue;
    if (from > at) parts.push(text.slice(at, from));
    parts.push(
      <mark key={from} className="bg-transparent font-medium text-foreground">
        {text.slice(from, to)}
      </mark>,
    );
    at = to;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** A title found this far in would lie past the row's one-line truncation (about 20 characters fit). */
const TITLE_VISIBLE_START = 16;
/** How much of the title stays before the found word once the start is cut. */
const TITLE_LEAD = 8;

/**
 * The title from a word boundary shortly before its first found range, after «…», when that range starts past
 * the visible start; otherwise the title as it is. Only a space is a boundary: a hyphenated word stays whole. The
 * ranges move with the text.
 */
export function titleAroundMark({ text, marks }: MarkedText): MarkedText {
  const first = marks[0];
  if (first === undefined || first.start <= TITLE_VISIBLE_START)
    return { text, marks };
  const lead = first.start - TITLE_LEAD;
  const space = text.lastIndexOf(' ', lead);
  // A word that would push the found one out of sight again is left out whole: the title starts at the next word.
  const next = text.indexOf(' ', lead);
  const cut =
    space >= first.start - TITLE_VISIBLE_START
      ? space + 1
      : next !== -1 && next < first.start
        ? next + 1
        : first.start;
  const shift = cut - 1;
  return {
    text: `…${text.slice(cut)}`,
    marks: marks.map(({ start, end }) => ({
      start: start - shift,
      end: end - shift,
    })),
  };
}

/** «Где найдено» (MC-15); null for a title match, which has no such line. */
function useWhere(match: ConversationMatch): string | null {
  const t = useTranslations('shell.search');
  if (match.place === 'title') return null;
  const tool = match.tool ?? '';
  if (match.agent !== null) {
    return match.place === 'tool_result'
      ? t('atAgentToolResult', { name: match.agent.name, tool })
      : t('atAgent', { name: match.agent.name });
  }
  return match.place === 'tool_result'
    ? t('inToolResult', { tool })
    : t('inMessage');
}

export type SearchResultProps = {
  match: ConversationMatch;
  /** The last opened match: the 3 px bar and `aria-current` («Открыто»). */
  opened: boolean;
  now: Date;
  /** A click or Enter on the link, before the navigation. */
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
};

/**
 * One match of the conversation search (search-result.md): the conversation title and date, where it was found
 * and the snippet with its found words marked. The link leads to the conversation, or to the sub-agent's page.
 */
export function SearchResult({
  match,
  opened,
  now,
  onOpen,
}: SearchResultProps) {
  const t = useTranslations('shell');
  const format = useFormatter();
  const where = useWhere(match);
  const title = match.title ?? t('thread.untitled');
  const date = formatListTime(format, match.at, now);
  const href =
    match.agent === null
      ? threadPath(match.threadId)
      : agentPath(match.agent.agentId);
  const name =
    where === null || match.snippet === null
      ? t('search.titleMatchName', { title, date })
      : t('search.matchName', {
          title,
          where,
          date,
          snippet: match.snippet.text,
        });
  const linkProps = {
    [SEARCH_RESULT_ATTRIBUTE]: '',
    [THREAD_LINK_ATTRIBUTE]: '',
  };

  return (
    <li>
      <ShellLink
        {...linkProps}
        href={href}
        aria-label={name}
        aria-current={opened ? 'true' : undefined}
        onClick={onOpen}
        className={cn(
          'relative flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-foreground outline-hidden pointer-coarse:min-h-11',
          'hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
          // «Открыто»: the same marker as the current conversation (SB-06).
          'aria-[current=true]:before:absolute aria-[current=true]:before:inset-y-2 aria-[current=true]:before:left-0 aria-[current=true]:before:w-0.75 aria-[current=true]:before:rounded-full aria-[current=true]:before:bg-sidebar-primary',
        )}
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">
            {match.place === 'title' ? (
              <MarkedTextView
                {...titleAroundMark({ text: title, marks: match.titleMarks })}
              />
            ) : (
              title
            )}
          </span>
          <span className="shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
            {date}
          </span>
        </span>
        {where !== null && (
          <span className="truncate text-xs font-medium text-muted-foreground">
            {where}
          </span>
        )}
        {match.snippet !== null && (
          <span className="line-clamp-2 text-data break-words text-muted-foreground">
            <MarkedTextView {...match.snippet} />
          </span>
        )}
      </ShellLink>
    </li>
  );
}
