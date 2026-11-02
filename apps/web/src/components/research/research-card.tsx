'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ArrowDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CircleStopIcon,
  CircleXIcon,
  HandIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type { ResearchDecision, ResearchLaunchView } from '@agent-os/contracts';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';

export type ResearchCardAction = ResearchDecision['action'];

/** A decision turn that failed or was interrupted (MC-15, MC-29, MC-16). */
export type ResearchCardDecisionError = 'launch_failed' | 'decline_failed' | 'stop_failed';

export type ResearchCardProps = {
  launch: ResearchLaunchView;
  /** The decision whose turn is in flight: «Запуск», «Отклонение» or «Остановка» until the turn returns. */
  pendingDecision?: ResearchCardAction | null;
  decisionError?: ResearchCardDecisionError | null;
  /** A reply streams in this tab: decision buttons do nothing and say why (UXRD KD-8, MC-30). */
  replyStreaming: boolean;
  onDecision: (action: ResearchCardAction) => void;
  /** «К ответу»; without it the link only follows its `#` anchor. */
  onShowAnswer?: (answerMessageId: string) => void;
};

/**
 * What the card draws. A pending decision or an error applies only while the launch is still in the state the decision
 * was made from; once the server reports another state the card shows that one, without an error line (stale card).
 */
type CardView =
  | { kind: 'proposal'; pending: 'confirm' | 'decline' | null; error: 'launch_failed' | 'decline_failed' | null }
  | { kind: 'running'; error: 'stop_failed' | null }
  | { kind: 'stopping' }
  | { kind: 'completed'; answerMessageId: string | null }
  | { kind: 'failed' }
  | { kind: 'stopped' }
  | { kind: 'not_launched'; reason: ResearchLaunchView['notLaunchedReason'] };

function cardView(
  launch: ResearchLaunchView,
  pending: ResearchCardAction | null,
  error: ResearchCardDecisionError | null,
): CardView {
  switch (launch.state) {
    case 'proposed':
      return {
        kind: 'proposal',
        pending: pending === 'confirm' || pending === 'decline' ? pending : null,
        error: error === 'launch_failed' || error === 'decline_failed' ? error : null,
      };
    case 'running':
      if (pending === 'stop') return { kind: 'stopping' };
      return { kind: 'running', error: error === 'stop_failed' ? error : null };
    case 'completed':
      return { kind: 'completed', answerMessageId: launch.answerPending ? null : launch.answerMessageId };
    case 'failed':
      return { kind: 'failed' };
    case 'stopped':
      return { kind: 'stopped' };
    case 'not_launched':
      return { kind: 'not_launched', reason: launch.notLaunchedReason };
  }
}

const ERROR_COPY = {
  launch_failed: 'Не удалось запустить ресерч. Попробуйте ещё раз.',
  decline_failed: 'Не удалось отклонить предложение. Попробуйте ещё раз.',
  stop_failed: 'Не удалось остановить ресерч. Попробуйте ещё раз.',
} as const satisfies Record<ResearchCardDecisionError, string>;

const NOT_LAUNCHED_REASON_COPY = {
  declined: 'Вы отказались.',
  superseded: 'Беседа продолжилась без него.',
} as const;

const UNAVAILABLE_COPY = 'Доступно, когда агент закончит ответ.';

/** «до {N} токенов» with a narrow no-break space between digit groups (research-card spec, Content Rules). */
function formatBudget(tokens: number): string {
  return `до ${tokens.toLocaleString('ru-RU').replace(/\s/g, ' ')} токенов`;
}

const TIME_FORMAT = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const DAY_FORMAT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

/** «ЧЧ:ММ» today, otherwise «30 окт., ЧЧ:ММ». */
function formatLaunchTime(createdAt: Date, now: Date): string {
  const time = TIME_FORMAT.format(createdAt);
  return createdAt.toDateString() === now.toDateString() ? time : `${DAY_FORMAT.format(createdAt)}, ${time}`;
}

/**
 * DR-03: one investigation in the feed from the proposal to its result (research-card spec). Data comes through props;
 * the card neither reads the store nor announces state changes — the screen does (UXRD Accessibility).
 */
export function ResearchCard({
  launch,
  pendingDecision = null,
  decisionError = null,
  replyStreaming,
  onDecision,
  onShowAnswer,
}: ResearchCardProps) {
  const view = cardView(launch, pendingDecision, decisionError);
  const cardRef = useRef<HTMLDivElement>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [focusTarget, setFocusTarget] = useState<'continue' | 'stop' | null>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const unavailableId = useId();
  const createdAt = new Date(launch.createdAt);

  const showConfirmation = confirmingStop && view.kind === 'running';

  useEffect(() => {
    if (focusTarget === 'continue') continueRef.current?.focus();
    if (focusTarget === 'stop') stopRef.current?.focus();
  }, [focusTarget, showConfirmation]);

  const decide = (action: ResearchCardAction) => {
    if (replyStreaming) return;
    setConfirmingStop(false);
    setFocusTarget(null);
    cardRef.current?.focus();
    onDecision(action);
  };

  const openConfirmation = () => {
    if (replyStreaming) return;
    setConfirmingStop(true);
    setFocusTarget('continue');
  };

  const closeConfirmation = () => {
    setConfirmingStop(false);
    setFocusTarget('stop');
  };

  const onConfirmationKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeConfirmation();
  };

  /** A decision button that stays in the Tab order while a reply streams, with MC-30 as its description. */
  const decisionButtonProps = {
    disabled: replyStreaming,
    focusableWhenDisabled: true,
    'aria-describedby': replyStreaming ? unavailableId : undefined,
  };

  const isProposal = view.kind === 'proposal';

  return (
    <div
      ref={cardRef}
      role="group"
      aria-label={`Ресерч: ${launch.goal}`}
      tabIndex={-1}
      className={cn(
        'flex w-full max-w-160 flex-col gap-2 rounded-lg border p-3 text-sm outline-none transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-3 focus-visible:ring-ring',
        isProposal ? 'border-approval-border bg-approval-subtle' : 'border-border bg-card',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <StatusLine view={view} />
        <time dateTime={launch.createdAt} className="text-muted-foreground text-xs font-medium tabular-nums">
          {formatLaunchTime(createdAt, new Date())}
        </time>
      </div>

      {isProposal && <h3 className="text-base font-semibold">Запустить глубокий ресерч?</h3>}

      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1">
        <dt className="text-muted-foreground text-xs font-medium">Цель</dt>
        <dd className="text-foreground break-words">{launch.goal}</dd>
        <dt className="text-muted-foreground text-xs font-medium">Бюджет</dt>
        <dd className="text-foreground tabular-nums">{formatBudget(launch.tokenBudget)}</dd>
      </dl>

      {launch.sourceMode === 'model_knowledge' && (
        <p className="text-foreground flex items-start gap-1.5 break-words">
          <TriangleAlertIcon aria-hidden className="text-warning mt-0.75 size-3.5 shrink-0" />
          Источники данных не подключены — ответ будет из знаний модели.
        </p>
      )}

      {(view.kind === 'proposal' || view.kind === 'running') && view.error !== null && (
        <p role="alert" className="text-foreground flex items-start gap-1.5">
          <CircleXIcon aria-hidden className="text-destructive mt-0.75 size-3.5 shrink-0" />
          {ERROR_COPY[view.error]}
        </p>
      )}

      {view.kind === 'proposal' && (
        <ActionRow>
          <Button size="sm" className="pointer-coarse:h-11" onClick={() => decide('confirm')} {...decisionButtonProps} disabled={replyStreaming || view.pending !== null}>
            {view.pending === 'confirm' ? <PendingLabel text="Запускаем…" /> : 'Запустить'}
          </Button>
          <Button size="sm" variant="outline" className="pointer-coarse:h-11" onClick={() => decide('decline')} {...decisionButtonProps} disabled={replyStreaming || view.pending !== null}>
            {view.pending === 'decline' ? <PendingLabel text="Отклоняем…" /> : 'Не нужно'}
          </Button>
        </ActionRow>
      )}

      {view.kind === 'running' && !showConfirmation && (
        <ActionRow>
          <Button ref={stopRef} size="sm" variant="outline" className="pointer-coarse:h-11" onClick={openConfirmation} {...decisionButtonProps}>
            Остановить
          </Button>
        </ActionRow>
      )}

      {showConfirmation && (
        <div className="flex flex-col gap-2" onKeyDown={onConfirmationKeyDown}>
          <p className="text-foreground">Остановить ресерч? Ответа не будет, потраченный бюджет не вернётся.</p>
          <ActionRow>
            <Button size="sm" variant="destructive" className="pointer-coarse:h-11" onClick={() => decide('stop')} {...decisionButtonProps}>
              Остановить
            </Button>
            <Button ref={continueRef} size="sm" variant="outline" className="pointer-coarse:h-11" onClick={closeConfirmation}>
              Продолжить
            </Button>
          </ActionRow>
        </div>
      )}

      {view.kind === 'completed' && view.answerMessageId !== null && (
        <AnswerLink answerMessageId={view.answerMessageId} onShowAnswer={onShowAnswer} />
      )}
      {view.kind === 'failed' && (
        <p className="text-foreground">
          Ответа не будет. Чтобы попробовать снова, отправьте вопрос в режиме „Глубокий ресерч“.
        </p>
      )}
      {view.kind === 'stopped' && <p className="text-foreground">Ответа не будет.</p>}
      {view.kind === 'not_launched' && view.reason !== null && (
        <p className="text-foreground">{NOT_LAUNCHED_REASON_COPY[view.reason]}</p>
      )}

      {replyStreaming && (
        <span id={unavailableId} hidden>
          {UNAVAILABLE_COPY}
        </span>
      )}
    </div>
  );
}

function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function PendingLabel({ text }: { text: string }) {
  return (
    <>
      <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:animate-none" />
      {text}
    </>
  );
}

/** The phase of the 1 s spin, shared by every running card so that they turn together (research-card spec, «Идёт»). */
function useSharedSpinPhase(): string {
  const [delay] = useState(() => `-${Date.now() % 1000}ms`);
  return delay;
}

function RunningIcon() {
  const animationDelay = useSharedSpinPhase();
  return (
    <>
      <LoaderCircleIcon aria-hidden style={{ animationDelay }} className="text-info size-3.5 shrink-0 animate-spin motion-reduce:hidden" />
      <CircleDashedIcon aria-hidden className="text-info hidden size-3.5 shrink-0 motion-reduce:block" />
    </>
  );
}

const STATUS_ICON = 'size-3.5 shrink-0';

function StatusLine({ view }: { view: CardView }) {
  const { icon, label, tone } = statusOf(view);
  return (
    <p className={cn('flex items-center gap-1.5 text-xs font-medium', tone)}>
      {icon}
      {label}
    </p>
  );
}

function statusOf(view: CardView): { icon: ReactNode; label: string; tone: string } {
  switch (view.kind) {
    case 'proposal':
      return { icon: <HandIcon aria-hidden className={STATUS_ICON} />, label: 'Ждёт подтверждения', tone: 'text-approval' };
    case 'running':
      return { icon: <RunningIcon />, label: 'Ресерч идёт', tone: 'text-info' };
    case 'stopping':
      return { icon: <CircleDashedIcon aria-hidden className={STATUS_ICON} />, label: 'Останавливаем…', tone: 'text-muted-foreground' };
    case 'completed':
      return { icon: <CircleCheckIcon aria-hidden className={STATUS_ICON} />, label: 'Ресерч завершён', tone: 'text-success' };
    case 'failed':
      return { icon: <CircleXIcon aria-hidden className={STATUS_ICON} />, label: 'Ресерч не удался', tone: 'text-destructive' };
    case 'stopped':
      return { icon: <CircleStopIcon aria-hidden className={STATUS_ICON} />, label: 'Ресерч остановлен', tone: 'text-muted-foreground' };
    case 'not_launched':
      return { icon: <CircleMinusIcon aria-hidden className={STATUS_ICON} />, label: 'Ресерч не запущен', tone: 'text-muted-foreground' };
  }
}

function AnswerLink({
  answerMessageId,
  onShowAnswer,
}: {
  answerMessageId: string;
  onShowAnswer: ((answerMessageId: string) => void) | undefined;
}) {
  return (
    <a
      href={`#${answerMessageId}`}
      onClick={(event) => {
        if (onShowAnswer === undefined) return;
        event.preventDefault();
        onShowAnswer(answerMessageId);
      }}
      className="text-primary inline-flex w-fit items-center gap-1 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring pointer-coarse:min-h-11"
    >
      К ответу
      <ArrowDownIcon aria-hidden className="size-3.5" />
    </a>
  );
}
