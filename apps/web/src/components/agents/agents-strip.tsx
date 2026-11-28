'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AgentStatus } from '@/components/agents/agent-status';
import {
  focusFeedCard,
  prefersReducedMotion,
} from '@/components/agents/queue-tray';
import { Button } from '@/components/ui/button';
import { builtinName } from '@/i18n/builtin-name';
import type { StripAgent } from '@/lib/feed/to-feed';

/** message-queue.md, «Агенты беседы»: a finished agent's button dissolves in 150 ms. */
const LEAVE_MS = 150;

type Shown = { agent: StripAgent; leaving: boolean };

/** The strip's buttons: the current agents, then those that just finished, kept for their dissolve. */
function useWithLeaving(agents: readonly StripAgent[]): Shown[] {
  const [tracked, setTracked] = useState<{
    agents: readonly StripAgent[];
    leaving: readonly StripAgent[];
  }>({ agents, leaving: [] });

  let current = tracked;
  if (tracked.agents !== agents) {
    const ids = new Set(agents.map((agent) => agent.agentId));
    const gone = (agent: StripAgent) => !ids.has(agent.agentId);
    current = {
      agents,
      leaving: prefersReducedMotion()
        ? []
        : [...tracked.leaving.filter(gone), ...tracked.agents.filter(gone)],
    };
    setTracked(current);
  }

  useEffect(() => {
    if (tracked.leaving.length === 0) return;
    const timer = setTimeout(
      () => setTracked((state) => ({ ...state, leaving: [] })),
      LEAVE_MS,
    );
    return () => clearTimeout(timer);
  }, [tracked.leaving]);

  return [
    ...agents.map((agent) => ({ agent, leaving: false })),
    ...current.leaving.map((agent) => ({ agent, leaving: true })),
  ];
}

export type AgentsStripProps = {
  /** `stripAgents` of the conversation's feed. */
  agents: readonly StripAgent[];
};

/**
 * The strip «Агенты беседы» above the queue tray (message-queue.md, improvements UXRD IM-11, MC-12): the agents of the
 * conversation that work or wait. A button scrolls the feed to the agent's card and moves focus onto it — a waiting
 * agent's decision card, a working agent's run card. Without such agents it renders nothing.
 */
export function AgentsStrip({ agents }: AgentsStripProps) {
  const t = useTranslations('chat.agentsStrip');
  const tAgents = useTranslations('agents');
  const locale = useLocale();
  const shown = useWithLeaving(agents);
  if (shown.length === 0) return null;

  return (
    <section
      aria-label={t('region')}
      data-slot="agents-strip"
      className="bg-muted flex w-full min-w-0 items-center gap-2 rounded-lg border px-3 py-1 last:mb-2"
    >
      <p className="text-muted-foreground shrink-0 text-xs leading-4 font-medium tabular-nums">
        {t('heading', { count: shown.length })}
      </p>
      {/* Buttons that do not fit scroll sideways inside the strip (UXRD Responsive «Полоса IM-11»). */}
      <ul className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {shown.map(({ agent, leaving }) => {
          const name = builtinName(agent, locale);
          return (
            <li
              key={agent.agentId}
              data-leaving={leaving ? '' : undefined}
              inert={leaving}
              className="shrink-0 transition-opacity duration-(--duration-fast) data-leaving:opacity-0 motion-reduce:transition-none"
            >
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('agent', {
                  name,
                  status: tAgents(`status.${agent.status}`),
                })}
                onClick={() =>
                  focusFeedCard(
                    agent.decisionId === null
                      ? { agentId: agent.agentId }
                      : { decisionId: agent.decisionId },
                  )
                }
                className="gap-2 pointer-coarse:h-11"
              >
                <span className="text-foreground text-sm leading-5">
                  {name}
                </span>
                <AgentStatus variant="label" status={agent.status} />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
