'use client';

import { useId } from 'react';
import { ArrowUpRightIcon, BotIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import type { ChipRecord, TrackerTaskConversation } from '@agent-os/contracts';
import { ConversationStateLabel } from '@/components/agents/agent-status';
import { RECORD_KIND_ICON } from '@/components/library/record-label';
import { ShellLink } from '@/components/shell/shell-link';
import { formatListTime } from '@/i18n/formats';
import { threadPath } from '@/lib/shell-route';

/**
 * TT-08, tracker-conversations.md: the task's conversations, the latest delegation first, deleted ones as rows
 * without a link. `agents` — the agents of «+», for the icon of a delegation's agent.
 */
export function TaskConversations({
  conversations,
  agents,
}: {
  conversations: readonly TrackerTaskConversation[];
  agents: readonly ChipRecord[];
}) {
  const t = useTranslations('tracker.conversations');
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2
        id={headingId}
        tabIndex={-1}
        className="text-sm leading-5 font-medium outline-none tabular-nums"
      >
        {conversations.length === 0
          ? t('titleEmpty')
          : t('title', { count: conversations.length })}
      </h2>
      {conversations.length === 0 ? (
        <p className="text-xs leading-4 text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {conversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              agents={agents}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ConversationRow({
  conversation,
  agents,
}: {
  conversation: TrackerTaskConversation;
  agents: readonly ChipRecord[];
}) {
  const t = useTranslations('tracker.conversations');
  const tThread = useTranslations('shell.thread');
  const tAgent = useTranslations('common.agentField');
  const format = useFormatter();
  const title =
    conversation.title.trim() === '' ? tThread('untitled') : conversation.title;
  const agentName = conversation.agent?.name ?? tAgent('chatAgent');
  const kind = agents.find(
    (agent) => agent.id === conversation.agent?.id,
  )?.kind;
  const AgentIcon = kind === undefined ? BotIcon : RECORD_KIND_ICON[kind];
  const delegated = t('delegatedAt', {
    time: formatListTime(format, conversation.delegatedAt),
  });
  const agentLine = (
    <span className="flex min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
      <AgentIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">
        {agentName} · {delegated}
      </span>
    </span>
  );

  if (conversation.deleted)
    return (
      <li className="flex flex-col gap-0.5 border-b border-border px-1 py-2 last:border-b-0">
        <span className="line-clamp-2 text-sm leading-5 text-muted-foreground">
          {title} · {t('deleted')}
        </span>
        {agentLine}
      </li>
    );

  return (
    <li className="border-b border-border last:border-b-0">
      <ShellLink
        href={threadPath(conversation.id)}
        className="flex flex-col gap-0.5 rounded-sm px-1 py-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="sr-only">
          {title}
          {conversation.state !== null &&
            tThread(`stateMark.${conversation.state}`)}
          , {agentName}, {delegated}
        </span>
        {conversation.state !== null && (
          <ConversationStateLabel
            state={conversation.state}
            label={tThread(`state.${conversation.state}`)}
          />
        )}
        <span
          aria-hidden
          className="flex items-start gap-1 text-sm leading-5 text-foreground"
        >
          <span className="line-clamp-2">{title}</span>
          <ArrowUpRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        </span>
        <span aria-hidden>{agentLine}</span>
      </ShellLink>
    </li>
  );
}
