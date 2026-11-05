'use client';

import { useId, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowUpIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  InfoIcon,
  TelescopeIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type { ResearchAnswerClaim, ResearchAnswerMetadata, ResearchAnswerSource } from '@agent-os/contracts';
import { cn } from 'cn';

export type ResearchAnswerProps = {
  answer: ResearchAnswerMetadata;
  /** «К запросу»; without it the link only follows its `#` anchor. Receives the id of the launch message or tool call. */
  onShowLaunch?: (launchAnchorId: string) => void;
};

const OUTCOME = {
  answered: { label: 'Есть ответ', icon: CircleCheckIcon, tone: 'text-success' },
  partial: { label: 'Частичный ответ', icon: TriangleAlertIcon, tone: 'text-warning' },
  inconclusive: { label: 'Вывода нет', icon: InfoIcon, tone: 'text-info' },
} as const satisfies Record<ResearchAnswerMetadata['outcome'], { label: string; icon: unknown; tone: string }>;

const STOP_REASON = {
  budget_exhausted: 'Остановлен: исчерпан бюджет',
  step_limit: 'Остановлен: достигнут лимит шагов',
  controller_invalid: 'Остановлен: агент не смог выбрать следующий шаг',
  model_unavailable: 'Остановлен: модель недоступна',
  deadline: 'Остановлен: истёк срок расследования',
  context_overflow: 'Остановлен: материала больше, чем агент может учесть',
} as const satisfies Record<NonNullable<ResearchAnswerMetadata['stopReason']>, string>;

const GROUPS = [
  { key: 'established', title: 'Установлено' },
  { key: 'assumed', title: 'Предположения' },
  { key: 'unknown', title: 'Не выяснено' },
] as const;

/**
 * DR-04: the research answer drawn from the `researchAnswer` metadata of its message (research-answer spec); the
 * message's text part is for the model and «Копировать», not for the feed. Without sources the answer opens with MC-32
 * and every claim carries MC-33 in place of footnotes (UXRD KD-9).
 */
export function ResearchAnswer({ answer, onShowLaunch }: ResearchAnswerProps) {
  const idPrefix = useId();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const withoutSources = answer.sourceMode === 'model_knowledge';
  const groups = GROUPS.map((group) => ({ ...group, claims: answer[group.key] })).filter((group) => group.claims.length > 0);
  // The summary retells the claims; with none there is nothing to retell (UXRD KD-11).
  const summary = groups.length > 0 ? answer.summary : null;
  const sourceRecordId = (number: number) => `${idPrefix}-source-${number}`;

  const showSource = (number: number) => {
    flushSync(() => setSourcesOpen(true));
    const record = document.getElementById(sourceRecordId(number));
    record?.scrollIntoView({ block: 'nearest' });
    record?.focus();
  };

  return (
    <article className="flex flex-col gap-2">
      <AnswerHeader answer={answer} onShowLaunch={onShowLaunch} />

      <p className="text-muted-foreground truncate text-sm">{answer.goal}</p>

      {withoutSources && (
        <div className="border-warning-border bg-warning-subtle flex items-start gap-1.5 rounded-lg border p-3 text-sm">
          <TriangleAlertIcon aria-hidden className="text-warning mt-0.75 size-3.5 shrink-0" />
          <p className="text-foreground">
            Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.
          </p>
        </div>
      )}

      {summary !== null && (
        <div className="flex flex-col gap-1">
          <p className="text-foreground text-base leading-[26px] break-words">{summary}</p>
          <p className="text-muted-foreground text-xs font-medium">Краткий пересказ — основания в утверждениях ниже</p>
        </div>
      )}

      {answer.stopReason !== null && <p className="text-muted-foreground text-sm">{STOP_REASON[answer.stopReason]}</p>}

      {groups.length > 0 && (
        <div className="mt-2 flex flex-col gap-4">
          {groups.map((group) => (
            <section key={group.key} className="flex flex-col gap-1">
              <h3 className="text-base font-semibold">{group.title}</h3>
              <ul className="flex flex-col gap-1">
                {group.claims.map((claim, index) => (
                  <Claim
                    key={index}
                    claim={claim}
                    withoutSources={withoutSources}
                    sourceHref={(number) => `#${sourceRecordId(number)}`}
                    onShowSource={showSource}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {!withoutSources && answer.sources.length > 0 && (
        <SourceList
          sources={answer.sources}
          open={sourcesOpen}
          onToggle={() => setSourcesOpen((open) => !open)}
          recordId={sourceRecordId}
        />
      )}
    </article>
  );
}

function AnswerHeader({ answer, onShowLaunch }: ResearchAnswerProps) {
  const outcome = OUTCOME[answer.outcome];
  const OutcomeIcon = outcome.icon;
  const launchAnchorId = 'messageId' in answer.launch ? answer.launch.messageId : answer.launch.toolCallId;
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h2 tabIndex={-1} className="flex items-center gap-1.5 rounded-sm text-base font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring">
        <TelescopeIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        Ответ ресерча
      </h2>
      <span className={cn('flex items-center gap-1 text-xs font-medium', outcome.tone)}>
        <OutcomeIcon aria-hidden className="size-3.5 shrink-0" />
        {outcome.label}
      </span>
      <a
        href={`#${launchAnchorId}`}
        aria-label="К запросу ресерча"
        onClick={(event) => {
          if (onShowLaunch === undefined) return;
          event.preventDefault();
          onShowLaunch(launchAnchorId);
        }}
        className="text-primary ms-auto inline-flex items-center gap-1 rounded-sm text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring pointer-coarse:min-h-11"
      >
        К запросу
        <ArrowUpIcon aria-hidden className="size-3.5" />
      </a>
    </header>
  );
}

function Claim({
  claim,
  withoutSources,
  sourceHref,
  onShowSource,
}: {
  claim: ResearchAnswerClaim;
  withoutSources: boolean;
  sourceHref: (number: number) => string;
  onShowSource: (number: number) => void;
}) {
  return (
    <li className="text-foreground text-base leading-[26px] break-words">
      {claim.text}
      {withoutSources ? (
        <>
          {' '}
          <span className="border-warning-border text-muted-foreground inline-block rounded-sm border px-1 text-xs font-medium whitespace-nowrap">
            из знаний модели, без источника
          </span>
        </>
      ) : (
        <>
          {claim.footnotes.map((number) => (
            <span key={number}>
              {' '}
              <a
                href={sourceHref(number)}
                aria-label={`Источник ${number}`}
                onClick={(event) => {
                  event.preventDefault();
                  onShowSource(number);
                }}
                className="text-primary rounded-sm text-xs font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
              >
                [{number}]
              </a>
            </span>
          ))}
          {!claim.verified && (
            <>
              {' '}
              <span className="border-border text-muted-foreground inline-block rounded-sm border px-1 text-xs font-medium whitespace-nowrap">
                не проверено
              </span>
            </>
          )}
        </>
      )}
    </li>
  );
}

function SourceList({
  sources,
  open,
  onToggle,
  recordId,
}: {
  sources: ResearchAnswerSource[];
  open: boolean;
  onToggle: () => void;
  recordId: (number: number) => string;
}) {
  const listId = useId();
  const buttonId = useId();
  return (
    <div className="mt-2 flex flex-col gap-1">
      <button
        id={buttonId}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
        className="text-foreground flex w-fit items-center gap-1 rounded-sm text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring pointer-coarse:min-h-11"
      >
        <ChevronRightIcon aria-hidden className={cn('size-4 transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')} />
        Источники ({sources.length})
      </button>
      <ol id={listId} aria-labelledby={buttonId} hidden={!open} className="flex flex-col">
        {sources.map((source) => (
          <li
            key={source.number}
            id={recordId(source.number)}
            tabIndex={-1}
            className="focus:bg-accent flex flex-col rounded-sm px-2 py-1 outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="min-w-0 truncate">
                {source.number}. {source.sourceId}
              </span>
              <span className="font-mono text-sm leading-[22px]">{source.toolName}</span>
            </span>
            <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm tabular-nums">
              {source.snapshot}
              {source.truncated && (
                <span className="text-warning flex items-center gap-1">
                  <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                  данные усечены
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
