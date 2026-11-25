'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { Script, TrainingView } from '@agent-os/contracts';
import { TaskStatusGlyph } from '@/components/agents/agent-status';
import { AgentScriptChange } from './agent-script-change';

export const HEADING = 'text-foreground text-base leading-6 font-semibold';

/** Money on the run tab; a cost under a cent reads «< 0,01 $» instead of «0,00 $». */
export function useUsdAmount(): (value: number) => string {
  const format = useFormatter();
  const t = useTranslations('formats');
  return (value) =>
    value > 0 && value < 0.01
      ? t('usdUnderCent', { amount: format.number(0.01, 'usd') })
      : format.number(value, 'usd');
}

/**
 * data-table.md «Две строки» at every width: the panel is 360–480 px, so the run tab has one layout (TR-02). Each
 * row is its name, then its other cells through « · »; every cell names what its number belongs to.
 */
export function TwoLines({
  caption,
  rows,
}: {
  caption: string;
  rows: ReadonlyArray<{ key: string; name: string; cells: string[] }>;
}) {
  return (
    <ul aria-label={caption} className="divide-border flex flex-col divide-y">
      {rows.map((row) => (
        <li key={row.key} className="flex flex-col gap-0.5 py-2">
          <span className="text-foreground text-sm leading-5">{row.name}</span>
          <span className="text-muted-foreground text-xs leading-4 tabular-nums">
            {row.cells.join(' · ')}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The trainer's course on a result screen; a task still in progress once the work ended reads «Работа кончилась»,
 * a test run's fix task closed without a round — «Не потребовалась» with the icon of a task not started. */
export function PoolProgress({
  pool,
  ended,
  label,
}: {
  pool: TrainingView['pool'];
  ended: boolean;
  label: string;
}) {
  const tTaskStatus = useTranslations('agents.taskStatus');
  return (
    <ul aria-label={label} className="divide-border flex flex-col divide-y">
      {pool.map((task) => {
        const unfinished = ended && task.status === 'in_progress';
        const skipped = task.skipped === true;
        return (
          <li key={task.number} className="flex items-start gap-2 py-1.5">
            <TaskStatusGlyph
              status={skipped ? 'pending' : task.status}
              ended={ended}
            />
            <span className="text-muted-foreground font-mono text-xs leading-5 tabular-nums">
              {task.number}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-foreground text-sm leading-5 break-words">
                {task.subject}
              </span>
              <span className="text-muted-foreground text-xs leading-5">
                {tTaskStatus(
                  skipped ? 'skipped' : unfinished ? 'unfinished' : task.status,
                )}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** «Что меняет версия»: the prompts «Было» over «Стало» as they are, then the changed scripts, then «Почему». */
export function VersionChanges({
  proposal,
  heading,
}: {
  proposal: Pick<TrainingView['proposal'], 'base' | 'proposed' | 'changes'>;
  heading: string;
}) {
  const t = useTranslations('library');
  const { base, proposed, changes } = proposal;
  if (base === null || proposed === null) return null;

  const subagents = [
    ...new Set([...base.subagents, ...proposed.subagents].map((s) => s.name)),
  ]
    .map((name) => ({
      name,
      before: base.subagents.find((s) => s.name === name)?.prompt ?? '',
      after: proposed.subagents.find((s) => s.name === name)?.prompt ?? '',
    }))
    .filter((subagent) => subagent.before !== subagent.after);
  const scripts = [
    ...new Set([...base.scripts, ...proposed.scripts].map((s) => s.name)),
  ]
    .map((name) => ({
      name,
      before: base.scripts.find((s) => s.name === name) ?? null,
      after: proposed.scripts.find((s) => s.name === name) ?? null,
    }))
    .filter(({ before, after }) => !sameScript(before, after));

  return (
    <section className="flex flex-col gap-3">
      <h2 className={HEADING}>{heading}</h2>
      <PromptColumns
        title={t('training.agentPrompt')}
        before={base.prompt}
        after={proposed.prompt}
      />
      {subagents.map((subagent) => (
        <PromptColumns
          key={subagent.name}
          title={t('training.subagentPrompt', { name: subagent.name })}
          before={subagent.before}
          after={subagent.after}
        />
      ))}
      {scripts.length > 0 && (
        <div className="divide-border flex flex-col divide-y">
          {scripts.map((script) => (
            <AgentScriptChange
              key={script.name}
              before={script.before}
              after={script.after}
            />
          ))}
        </div>
      )}
      {changes !== null && (
        <div className="flex flex-col gap-1">
          <h3 className="text-foreground text-sm leading-5 font-medium">
            {t('training.why')}
          </h3>
          <p className="text-foreground text-sm leading-5 whitespace-pre-wrap">
            {changes}
          </p>
        </div>
      )}
    </section>
  );
}

const sameScript = (before: Script | null, after: Script | null): boolean =>
  JSON.stringify(before) === JSON.stringify(after);

function PromptColumns({
  title,
  before,
  after,
}: {
  title: string;
  before: string;
  after: string;
}) {
  const t = useTranslations('library.scripts.change');
  const column = (label: string, text: string) => (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <p className="text-muted-foreground text-xs leading-4">{label}</p>
      <p className="text-foreground text-sm leading-5 break-words whitespace-pre-wrap">
        {text}
      </p>
    </div>
  );
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-foreground text-sm leading-5 font-medium">{title}</h3>
      <div className="flex flex-col gap-3">
        {column(t('before'), before)}
        {column(t('after'), after)}
      </div>
    </div>
  );
}
