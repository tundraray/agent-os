'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { TrainingView, Verdict } from '@agent-os/contracts';
import { DataTable } from '@/components/admin/data-table';
import { ShellLink } from '@/components/shell/shell-link';
import { StateBadge, type StateBadgeState } from '@/components/state-badge';
import { agentPath } from '@/lib/shell-route';

const VERDICT_STATE: Record<Verdict, StateBadgeState> = {
  proposed_better: 'ok',
  base_better: 'worse',
  equal: 'neutral',
  not_compared: 'off',
};

export const HEADING = 'text-foreground text-base leading-6 font-semibold';

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

/** Part 3 «Сравнение на прошлых задачах»: the two versions' numbers, then one row per compared past task. */
export function Comparison({ view }: { view: TrainingView }) {
  const t = useTranslations('library.training');
  const format = useFormatter();
  const version = view.proposal.version;
  if (version === null || view.comparisons.length === 0) return null;

  const usd = (value: number) => format.number(value, 'usd');
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

  return (
    <section className="flex flex-col gap-3">
      <h2 className={HEADING}>{t('comparison')}</h2>
      <DataTable
        caption={t('comparison')}
        twoLines
        columns={[
          { header: '' },
          {
            header: t('baseVersion', {
              version: view.baseVersion,
              active: String(view.baseVersion === view.activeVersion),
            }),
            align: 'end',
          },
          {
            header: t('proposedVersion', {
              version,
              active: String(version === view.activeVersion),
            }),
            align: 'end',
          },
        ]}
        state={{
          status: 'ready',
          rows: [
            {
              key: 'errors',
              name: t('errors'),
              cells: [t('errors'), base.errors, proposed.errors],
            },
            {
              key: 'calls',
              name: t('calls'),
              cells: [t('calls'), base.toolCalls, proposed.toolCalls],
            },
            {
              key: 'cost',
              name: t('avgCost'),
              cells: [
                t('avgCost'),
                average(base, 'base'),
                average(proposed, 'proposed'),
              ],
            },
          ],
        }}
      />
      <DataTable
        caption={t('comparison')}
        twoLines
        columns={[
          { header: t('columns.task'), shrinks: true },
          { header: t('columns.outcome') },
          { header: t('columns.errors'), align: 'end' },
          { header: t('columns.calls'), align: 'end' },
          { header: t('columns.cost'), align: 'end' },
        ]}
        state={{
          status: 'ready',
          rows: view.comparisons.map((element, index) => ({
            key: String(index),
            name: String(index + 1),
            cells: [
              <span
                key="task"
                className="flex min-w-0 flex-col whitespace-normal"
              >
                <span>{`${index + 1}  ${element.task ?? ''}`}</span>
                {element.reason !== null && (
                  <span className="text-muted-foreground text-xs leading-4">
                    {element.reason}
                  </span>
                )}
                <span className="flex flex-wrap gap-x-3 text-xs leading-4">
                  <ReplayLink
                    replay={element.base}
                    label={t('replay', { version: view.baseVersion })}
                  />
                  <ReplayLink
                    replay={element.proposed}
                    label={t('replay', { version })}
                  />
                </span>
              </span>,
              <StateBadge
                key="verdict"
                state={VERDICT_STATE[element.verdict ?? 'not_compared']}
              >
                {t(`verdict.${element.verdict ?? 'not_compared'}`)}
              </StateBadge>,
              pair(element.base, element.proposed, (replay) =>
                String(replay.errors),
              ),
              pair(element.base, element.proposed, (replay) =>
                String(replay.toolCalls),
              ),
              pair(element.base, element.proposed, (replay) =>
                usd(replay.costUsd),
              ),
            ],
          })),
        }}
      />
    </section>
  );
}
