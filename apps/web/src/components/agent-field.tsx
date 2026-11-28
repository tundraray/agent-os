'use client';

import { BotIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ChipRecord } from '@agent-os/contracts';
import { AdminSelectField } from '@/components/admin/admin-form';
import { RECORD_KIND_ICON } from '@/components/library/record-label';

/** The value of «Агент чата» in the select: record ids are UUIDs, so it never meets one. */
const CHAT_AGENT = 'chat';

export type AgentFieldProps = {
  id: string;
  /** The agents of «+» and `@` (`useChatAgents()`), with whatever the caller adds. */
  agents: readonly ChipRecord[];
  /** The chosen agent's id; `null` — the chat agent. */
  value: string | null;
  error: string | undefined;
  onChange: (agentId: string | null) => void;
};

/**
 * «Агент» of the schedule dialog and of «Поручить агенту» (task-tracker KD-4; schedules SH-02): «Агент чата» first,
 * then the given agents with the icons of their kinds.
 */
export function AgentField({
  id,
  agents,
  value,
  error,
  onChange,
}: AgentFieldProps) {
  const t = useTranslations('common.agentField');
  return (
    <AdminSelectField
      id={id}
      density="comfortable"
      label={t('label')}
      value={value ?? CHAT_AGENT}
      options={[
        { id: CHAT_AGENT, name: t('chatAgent'), icon: BotIcon },
        ...agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          icon: RECORD_KIND_ICON[agent.kind],
        })),
      ].map(({ id: option, name, icon: Icon }) => ({
        value: option,
        label: name,
        content: (
          <>
            <Icon aria-hidden className="text-muted-foreground" />
            {name}
          </>
        ),
      }))}
      error={error}
      onChange={(next) => onChange(next === CHAT_AGENT ? null : next)}
    />
  );
}
