'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { TestRunView, TestVerdict } from '@agent-os/contracts';
import { ShellLink } from '@/components/shell/shell-link';
import { StateBadge, type StateBadgeState } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import { agentPath, recordPath } from '@/lib/shell-route';
import { DefinitionView } from './definition-view';
import { RecordLabel } from './record-label';
import {
  HEADING,
  TwoLines,
  useUsdAmount,
  VersionChanges,
} from './training-parts';

const VERDICT_STATE: Record<TestVerdict, StateBadgeState> = {
  passed: 'ok',
  failed: 'failed',
  unchecked: 'off',
};

type Agent = NonNullable<TestRunView['agent']>;

/**
 * The middle block of «Проверка» (CT-04 parts 2–4): the rounds' numbers and each test's round lines, what each fix
 * changes against the round before it, and the agent with its first version's definition.
 */
export function TestRunRounds({
  view,
  agent,
}: {
  view: TestRunView;
  agent: Agent;
}) {
  const t = useTranslations('library.testRun');
  const tTraining = useTranslations('library.training');
  const tChat = useTranslations('chat.testRun.plan');
  const usd = useUsdAmount();
  // A round shows once any test has started in it; round k is position k − 1 of each test's results.
  const rounds = view.rounds
    .map((round, index) => ({ ...round, index }))
    .filter(({ index }) =>
      view.tests.some((test) => test.rounds[index] !== undefined),
    );
  const roundName = (version: number) => t('round', { fix: version - 1 });
  const row = (
    key: string,
    name: string,
    value: (round: (typeof rounds)[number]) => string,
  ) => ({
    key,
    name,
    cells: rounds.map(
      (round) => `${roundName(round.version)}: ${value(round)}`,
    ),
  });

  return (
    <>
      {rounds.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className={HEADING}>{t('tests')}</h2>
          <TwoLines
            caption={t('tests')}
            rows={[
              row('passed', t('passedRow'), (round) =>
                t('passedOf', { passed: round.passed, total: round.total }),
              ),
              row('errors', tTraining('errors'), (round) =>
                String(round.errors),
              ),
              row('calls', tTraining('calls'), (round) =>
                String(round.toolCalls),
              ),
              row('cost', tTraining('columns.cost'), (round) =>
                usd(round.costUsd),
              ),
            ]}
          />
          <ol
            aria-label={t('tests')}
            className="divide-border flex flex-col divide-y"
          >
            {view.tests.map((test, number) => (
              <li key={number} className="flex gap-2 py-2">
                <span className="text-muted-foreground font-mono text-xs leading-5 tabular-nums">
                  {number + 1}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-foreground text-sm leading-5 break-words whitespace-pre-wrap">
                    {test.task}
                  </h3>
                  <p className="text-muted-foreground text-xs leading-4 break-words whitespace-pre-wrap">
                    {tChat('expected', { result: test.expected })}
                  </p>
                  {rounds.map((round) => {
                    const result = test.rounds[round.index];
                    // A verdict still to come while the round runs is not shown yet.
                    if (result?.verdict == null && view.phase === 'working')
                      return null;
                    if (result === undefined && view.phase !== 'ended')
                      return null;
                    const verdict = result?.verdict ?? 'unchecked';
                    const runId = agent.deleted
                      ? null
                      : (result?.conversationId ?? null);
                    const reason =
                      result?.reason ??
                      (verdict === 'unchecked' ? t('notChecked') : null);
                    return (
                      <div key={round.versionId} className="flex flex-col">
                        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="text-foreground text-sm leading-5">
                            {roundName(round.version)}
                          </span>
                          <StateBadge state={VERDICT_STATE[verdict]}>
                            {t(`verdict.${verdict}`)}
                          </StateBadge>
                          {runId !== null && (
                            <ShellLink
                              href={agentPath(runId)}
                              aria-label={t('runName', {
                                number: number + 1,
                                round: roundName(round.version),
                              })}
                              className="text-primary text-xs leading-4 underline-offset-4 hover:underline"
                            >
                              {t('run')}
                            </ShellLink>
                          )}
                        </p>
                        {reason !== null && (
                          <p className="text-muted-foreground text-xs leading-4 break-words whitespace-pre-wrap">
                            {reason}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      {view.rounds.slice(1).map((round, index) => (
        <VersionChanges
          key={round.versionId}
          proposal={{
            base: view.rounds[index]?.texts ?? null,
            proposed: round.texts,
            changes: round.changes,
          }}
          heading={t('changes', { fix: round.version - 1 })}
        />
      ))}
      <AgentPart agent={agent} />
    </>
  );
}

/** «Агент» (CT-04 part 4, MC-10): the label, then version 1's definition folded until asked. */
function AgentPart({ agent }: { agent: Agent }) {
  const t = useTranslations('library.testRun');
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-2">
      <h2 className={HEADING}>{t('agent')}</h2>
      <RecordLabel
        variant="row"
        chip={{ id: agent.id, kind: 'deep_agent', name: agent.name }}
        href={agent.deleted ? undefined : recordPath(agent.id)}
      />
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        className="self-start pointer-coarse:h-11"
        onClick={() => setOpen((shown) => !shown)}
      >
        {t(open ? 'hideDefinition' : 'showDefinition')}
      </Button>
      {open && (
        <DefinitionView
          definition={{
            description: agent.description,
            kind: 'deep_agent',
            content: agent.content,
          }}
          missingRights={[]}
          variant="card"
        />
      )}
    </section>
  );
}
