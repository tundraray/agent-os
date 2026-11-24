'use client';

import { useTranslations } from 'next-intl';
import type { Script } from '@agent-os/contracts';
import { CAPTION } from '@/components/admin/admin-form';
import { StateBadge } from '@/components/state-badge';
import { cn } from 'cn';

/** The script's name, class, description and «Вызывает · Вход» line (agent-script.md, parts 1–5). */
export function ScriptHead({
  script,
  mark,
}: {
  script: Script;
  mark?: string;
}) {
  const t = useTranslations('library.scripts');
  const caller =
    script.owner === null
      ? t('callerSelf')
      : t('callerSubagent', { name: script.owner });
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="text-foreground min-w-0 truncate font-mono text-sm leading-5"
          title={script.name}
        >
          {script.name}
        </span>
        <StateBadge variant="source">{t(`class.${script.class}`)}</StateBadge>
        {mark !== undefined && <StateBadge variant="source">{mark}</StateBadge>}
      </div>
      <p className="text-foreground text-sm leading-5 break-words">
        {script.description}
      </p>
      <p className={cn(CAPTION, 'text-muted-foreground break-words')}>
        {script.input === ''
          ? caller
          : `${caller} · ${t('input', { input: script.input })}`}
      </p>
    </>
  );
}

/**
 * «Изменение» (agent-script.md): a script in a training result, marked new, changed or removed, its code in
 * two columns «Было» and «Стало» as they are.
 */
export function AgentScriptChange({
  before,
  after,
}: {
  before: Script | null;
  after: Script | null;
}) {
  const t = useTranslations('library.scripts');
  const shown = after ?? before;
  if (shown === null) return null;
  const mark =
    before === null
      ? t('change.new')
      : after === null
        ? t('change.removed')
        : t('change.changed');
  const column = (label: string, script: Script | null) =>
    script !== null && (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className={cn(CAPTION, 'text-muted-foreground')}>{label}</p>
        <pre className="bg-muted text-foreground overflow-x-auto rounded-md p-2.5 font-mono text-[13px] leading-5 whitespace-pre-wrap">
          {script.code}
        </pre>
      </div>
    );
  return (
    <article aria-label={shown.name} className="flex flex-col gap-1 py-3">
      <ScriptHead script={shown} mark={mark} />
      <div className="flex flex-col gap-2 md:flex-row">
        {column(t('change.before'), before)}
        {column(t('change.after'), after)}
      </div>
    </article>
  );
}
