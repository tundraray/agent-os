'use client';

import { useTranslations } from 'next-intl';
import type { TrainingView, Verdict } from '@agent-os/contracts';
import { ShellLink } from '@/components/shell/shell-link';
import { StateBadge, type StateBadgeState } from '@/components/state-badge';
import { agentPath } from '@/lib/shell-route';
import { HEADING, TwoLines, useUsdAmount } from './training-parts';

const VERDICT_STATE: Record<Verdict, StateBadgeState> = {
  proposed_better: 'ok',
  base_better: 'worse',
  equal: 'neutral',
  not_compared: 'off',
};

type Replay = TrainingView['comparisons'][number]['base'];
type Numbers = TrainingView['totals']['base'];
/** A replay's read-only agent page; only the starter gets its id (AC-18.1). */
function ReplayLink({ replay, label }: { replay: Replay; label: string }) {
  if (replay === null || replay.conversationId === null) return null;
  return (
    <ShellLink href={agentPath(replay.conversationId)} className="underline">
      {label}
    </ShellLink>
  );
}

/**
 * Part 3 «Сравнение на прошлых задачах» (TR-02): the two versions' numbers in «Две строки», then the compared past
 * tasks as a numbered list — the verdict and the replays, the reason, then the numbers «было → стало».
 */
export function Comparison({ view }: { view: TrainingView }) {
  const t = useTranslations('library.training');
  const usd = useUsdAmount();
  const version = view.proposal.version;
  if (version === null || view.comparisons.length === 0) return null;

  const pair = (
    base: Replay,
    proposed: Replay,
    show: (replay: NonNullable<Replay>) => string,
  ) =>
    `${base === null ? '—' : show(base)} → ${proposed === null ? '—' : show(proposed)}`;
  const replays = (side: 'base' | 'proposed') =>
    view.comparisons.filter((element) => element[side] !== null).length;
  const average = (numbers: Numbers, side: 'base' | 'proposed') =>
    usd(replays(side) === 0 ? 0 : numbers.costUsd / replays(side));
  const { base, proposed } = view.totals;
  const baseLabel = t('baseVersion', {
    version: view.baseVersion,
    active: String(view.baseVersion === view.activeVersion),
  });
  const proposedLabel = t('proposedVersion', {
    version,
    active: String(version === view.activeVersion),
  });
  const row = (key: string, name: string, before: string, after: string) => ({
    key,
    name,
    cells: [`${baseLabel}: ${before}`, `${proposedLabel}: ${after}`],
  });

  return (
    <section className="flex flex-col gap-3">
      <h2 className={HEADING}>{t('comparison')}</h2>
      <TwoLines
        caption={t('comparison')}
        rows={[
          row(
            'errors',
            t('errors'),
            String(base.errors),
            String(proposed.errors),
          ),
          row(
            'calls',
            t('calls'),
            String(base.toolCalls),
            String(proposed.toolCalls),
          ),
          row(
            'cost',
            t('avgCost'),
            average(base, 'base'),
            average(proposed, 'proposed'),
          ),
        ]}
      />
      <ol
        aria-label={t('comparison')}
        className="divide-border flex flex-col divide-y"
      >
        {view.comparisons.map((element, index) => (
          <li key={index} className="flex gap-2 py-2">
            <span className="text-muted-foreground font-mono text-xs leading-5 tabular-nums">
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-foreground text-sm leading-5 break-words">
                {element.task ?? ''}
              </p>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-4">
                <StateBadge
                  state={VERDICT_STATE[element.verdict ?? 'not_compared']}
                >
                  {t(`verdict.${element.verdict ?? 'not_compared'}`)}
                </StateBadge>
                <ReplayLink
                  replay={element.base}
                  label={t('replay', { version: view.baseVersion })}
                />
                <ReplayLink
                  replay={element.proposed}
                  label={t('replay', { version })}
                />
              </p>
              {element.reason !== null && (
                <p className="text-muted-foreground text-xs leading-4 break-words">
                  {element.reason}
                </p>
              )}
              <p className="text-muted-foreground text-xs leading-4 tabular-nums">
                {[
                  `${t('columns.errors')} ${pair(element.base, element.proposed, (replay) => String(replay.errors))}`,
                  `${t('columns.calls')} ${pair(element.base, element.proposed, (replay) => String(replay.toolCalls))}`,
                  `${t('columns.cost')} ${pair(element.base, element.proposed, (replay) => usd(replay.costUsd))}`,
                ].join(' · ')}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
