'use client';

import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  ANSWER_OTHER_MAX_LENGTH,
  AskUserArgsSchema,
  type Confirmation,
  type DecisionRequest,
  type Question,
  type QuestionAnswer,
} from '@agent-os/contracts';
import { CircleCheckIcon, CircleMinusIcon, CircleStopIcon } from 'lucide-react';
import {
  CardHeader,
  CardSource,
  DecisionButton,
  ErrorLine,
  frameClass,
  useDecisionSend,
  type Outcome,
} from '@/components/agents/card-parts';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { formatListTime, type Formatter } from '@/i18n/formats';
import {
  EMPTY_PICK,
  isAnswered,
  questionAnswers,
  type QuestionPick,
} from '@/lib/agents/question-answers';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';

type QuestionTranslator = ReturnType<typeof useTranslations<'agents.question'>>;

/** The radio value of «Другое»; an option's value is its index, so no label can collide with it. */
const OTHER = 'other';
const optionValue = (index: number): string => `o${index}`;

/**
 * MC-4 from the re-read card only (Invariant 1): answered — `answers` in the resolution; skipped — resolved without
 * them; «Не понадобилось» — the agent was stopped while the question waited.
 */
function questionOutcomeOf(
  t: QuestionTranslator,
  format: Formatter,
  confirmation: Confirmation,
): Outcome | null {
  if (confirmation.status === 'open') return null;
  if (confirmation.status === 'cancelled')
    return {
      kind: 'cancelled',
      text: t('cancelled'),
      Icon: CircleStopIcon,
      tone: 'text-muted-foreground',
    };
  const time = formatListTime(
    format,
    confirmation.resolvedAt ?? confirmation.createdAt,
  );
  if (confirmation.resolution?.answers !== undefined)
    return {
      kind: 'approved',
      text: t('answered', { time }),
      Icon: CircleCheckIcon,
      tone: 'text-success',
    };
  return {
    kind: 'rejected',
    text: t('skipped', { time }),
    Icon: CircleMinusIcon,
    tone: 'text-muted-foreground',
  };
}

/** MC-2: the questions «Ответить» would send without an answer, by their numbers; null when none or all are. */
function unansweredSummary(
  t: QuestionTranslator,
  answers: readonly QuestionAnswer[],
): string | null {
  const numbers = answers.flatMap((answer, index) =>
    isAnswered(answer) ? [] : [index + 1],
  );
  if (numbers.length === 0 || numbers.length === answers.length) return null;
  const [a, b, c] = numbers;
  if (b === undefined) return t('unansweredOne', { a });
  if (c === undefined) return t('unansweredTwo', { a, b });
  return t('unansweredThree', { a, b, c });
}

/** The first control of a question: its chosen radio, else its first radio or checkbox. */
function firstControl(
  fieldset: HTMLFieldSetElement | null,
): HTMLElement | null {
  return (
    fieldset?.querySelector<HTMLElement>(
      '[role="radio"][aria-checked="true"]',
    ) ??
    fieldset?.querySelector<HTMLElement>('[role="radio"], [role="checkbox"]') ??
    null
  );
}

const ROW_CLASS =
  'hover:bg-accent flex min-w-0 cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 pointer-coarse:min-h-11';

/** One question while the card waits: its options and «Другое» (question-card.md, parts 4–7). */
function QuestionFields({
  question,
  index,
  numbered,
  pick,
  busy,
  onChange,
  onOtherEnter,
  fieldsetRef,
}: {
  question: Question;
  index: number;
  numbered: boolean;
  pick: QuestionPick;
  busy: boolean;
  onChange: (pick: QuestionPick) => void;
  onOtherEnter: () => void;
  fieldsetRef: (element: HTMLFieldSetElement | null) => void;
}) {
  const t = useTranslations('agents.question');
  const id = useId();
  const otherRef = useRef<HTMLTextAreaElement | null>(null);
  const number = index + 1;
  const describedBy = (option: number) => `${id}-d${option}`;

  const chooseOther = (): void => {
    onChange({
      ...pick,
      otherChosen: true,
      selected: question.multiSelect ? pick.selected : [],
    });
    otherRef.current?.focus();
  };
  const typeOther = (text: string): void =>
    onChange({
      otherText: text,
      otherChosen: true,
      selected: question.multiSelect ? pick.selected : [],
    });
  const onOtherKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    onOtherEnter();
  };

  const optionRow = (
    control: ReactNode,
    label: string,
    description: string,
    option: number,
  ) => (
    <label key={option} className={ROW_CLASS}>
      {control}
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground text-sm leading-5 break-all">
          {label}
        </span>
        <span
          id={describedBy(option)}
          className="text-muted-foreground text-sm leading-5 break-all"
        >
          {description}
        </span>
      </span>
    </label>
  );

  const otherField = (
    <Textarea
      ref={otherRef}
      rows={1}
      value={pick.otherText}
      maxLength={ANSWER_OTHER_MAX_LENGTH}
      disabled={busy}
      placeholder={t('otherPlaceholder')}
      aria-label={t('otherLabel', { number })}
      onChange={(event) => typeOther(event.target.value)}
      onKeyDown={onOtherKeyDown}
      className={cn(
        'min-h-0 min-w-0 flex-1 py-1 text-sm leading-5 md:text-sm max-[30rem]:basis-full',
        !pick.otherChosen && 'text-muted-foreground',
      )}
    />
  );
  const otherLabel = (control: ReactNode) => (
    <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 px-1.5 py-1">
      <label className="flex cursor-pointer items-center gap-2 pt-1 pointer-coarse:min-h-11">
        {control}
        <span className="text-foreground text-sm leading-5">{t('other')}</span>
      </label>
      {otherField}
    </div>
  );

  const legend = (
    <legend className="mb-1 flex w-full items-baseline justify-between gap-3">
      <span className="text-foreground text-sm leading-5 font-medium break-all">
        {numbered ? `${number}. ${question.question}` : question.question}
      </span>
      {question.multiSelect && (
        <span className="text-muted-foreground shrink-0 text-xs leading-4 font-medium">
          {t('multiSelect')}
        </span>
      )}
    </legend>
  );

  if (question.multiSelect) {
    const toggle = (label: string, checked: boolean): void =>
      onChange({
        ...pick,
        selected: checked
          ? [...pick.selected, label]
          : pick.selected.filter((chosen) => chosen !== label),
      });
    return (
      <fieldset
        ref={fieldsetRef}
        disabled={busy}
        className="flex min-w-0 flex-col gap-1"
      >
        {legend}
        {question.options.map((option, optionIndex) =>
          optionRow(
            <Checkbox
              className="mt-0.5"
              checked={pick.selected.includes(option.label)}
              aria-describedby={describedBy(optionIndex)}
              onCheckedChange={(checked) => toggle(option.label, checked)}
            />,
            option.label,
            option.description,
            optionIndex,
          ),
        )}
        {otherLabel(
          <Checkbox
            checked={pick.otherChosen}
            onCheckedChange={(checked) => {
              if (checked) chooseOther();
              else onChange({ ...pick, otherChosen: false });
            }}
          />,
        )}
      </fieldset>
    );
  }

  const chosenIndex = question.options.findIndex((option) =>
    pick.selected.includes(option.label),
  );
  const value = pick.otherChosen
    ? OTHER
    : chosenIndex === -1
      ? null
      : optionValue(chosenIndex);
  return (
    <fieldset
      ref={fieldsetRef}
      disabled={busy}
      className="flex min-w-0 flex-col gap-1"
    >
      {legend}
      <RadioGroup
        value={value}
        disabled={busy}
        onValueChange={(next) => {
          if (next === OTHER) {
            chooseOther();
            return;
          }
          const option = question.options.find(
            (_, optionIndex) => optionValue(optionIndex) === next,
          );
          if (option !== undefined)
            onChange({ ...pick, selected: [option.label], otherChosen: false });
        }}
        className="flex flex-col gap-1"
      >
        {question.options.map((option, optionIndex) =>
          optionRow(
            <RadioGroupItem
              className="mt-0.5"
              value={optionValue(optionIndex)}
              aria-describedby={describedBy(optionIndex)}
            />,
            option.label,
            option.description,
            optionIndex,
          ),
        )}
        {otherLabel(<RadioGroupItem value={OTHER} />)}
      </RadioGroup>
    </fieldset>
  );
}

/** The answered card: each question with its answer (question-card.md, «Отвечено»), as a description list. */
function AnsweredList({
  questions,
  answers,
}: {
  questions: readonly Question[];
  answers: readonly QuestionAnswer[];
}) {
  const t = useTranslations('agents.question');
  return (
    <dl className="flex flex-col gap-2">
      {questions.map((question, index) => {
        const answer = answers[index];
        const answered = answer !== undefined && isAnswered(answer);
        return (
          <div key={index} className="flex min-w-0 flex-col">
            <dt className="text-foreground text-sm leading-5 font-medium break-all">
              {question.question}
            </dt>
            {answered ? (
              <dd className="text-foreground text-sm leading-5 break-all whitespace-pre-wrap">
                {answer.selected.length > 0 && (
                  <span className="block">{answer.selected.join(', ')}</span>
                )}
                {answer.other !== null && (
                  <span className="block">
                    {t('ownAnswer', { text: answer.other })}
                  </span>
                )}
              </dd>
            ) : (
              <dd className="text-muted-foreground text-sm leading-5">
                {t('noAnswer')}
              </dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}

export type QuestionCardProps = {
  confirmation: Confirmation;
  /** The conversation's root asks: «Чат спрашивает:» (MC-1). */
  byChat: boolean;
  /** Sends the decision and re-reads; rejects when the server did not take it. */
  onDecide: (decision: DecisionRequest) => Promise<void>;
};

/**
 * The card of an `agents.question` decision (question-card.md, UXRD QC-01 – QC-03, MC-1 – MC-4): the employee
 * answers the agent's questions or skips them. What is marked lives only here (Invariant 2); the outcome comes from
 * the re-read card, so an answer given in another copy shows its outcome with no error line. «Пропустить» is
 * `approve: true` without `answers`; the card never sends `approve: false`.
 */
export function QuestionCard({
  confirmation,
  byChat,
  onDecide,
}: QuestionCardProps) {
  const t = useTranslations('agents.question');
  const format = useFormatter();
  const parsed = AskUserArgsSchema.safeParse(confirmation.content);
  const questions = parsed.success ? parsed.data.questions : [];
  const outcome = questionOutcomeOf(t, format, confirmation);
  const { pressed, busy, failed, containerRef, decide, clearFailure } =
    useDecisionSend<'answer' | 'skip'>({
      onDecide,
      decided: outcome !== null,
    });
  const [picks, setPicks] = useState<QuestionPick[]>(() =>
    questions.map(() => EMPTY_PICK),
  );
  const fieldsets = useRef<(HTMLFieldSetElement | null)[]>([]);
  const answerRef = useRef<HTMLButtonElement | null>(null);
  const hintId = useId();

  if (!parsed.success) {
    logger.error('[web-feed] question card outside the contract', {
      decisionId: confirmation.decisionId,
    });
    return null;
  }

  const answers = questionAnswers(questions, picks);
  const anyAnswer = answers.some(isAnswered);
  const summary = unansweredSummary(t, answers);
  const who = byChat ? 'chat' : 'agent';

  const sendAs = (
    which: 'answer' | 'skip',
    decision: DecisionRequest,
  ): void => {
    // The log names the card and the action, never the answers (Security Considerations).
    logger.info('[web-feed] question card decision', {
      decisionId: confirmation.decisionId,
      action: which,
    });
    void decide(which, decision);
  };
  const answer = (): void => {
    if (busy || !anyAnswer) return;
    sendAs('answer', { approve: true, answers });
  };
  const setPick = (index: number, pick: QuestionPick): void => {
    clearFailure();
    setPicks((current) =>
      current.map((value, at) => (at === index ? pick : value)),
    );
  };
  const focusAfter = (index: number): void => {
    const next = firstControl(fieldsets.current[index + 1] ?? null);
    (next ?? answerRef.current)?.focus();
  };
  const onCardKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (outcome !== null || event.key !== 'Enter') return;
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    answer();
  };

  let body: ReactNode;
  if (outcome === null) {
    body = (
      <>
        <div className="flex flex-col gap-4">
          {questions.map((question, index) => (
            <QuestionFields
              key={index}
              question={question}
              index={index}
              numbered={questions.length > 1}
              pick={picks[index] ?? EMPTY_PICK}
              busy={busy}
              onChange={(pick) => setPick(index, pick)}
              onOtherEnter={() => focusAfter(index)}
              fieldsetRef={(element) => {
                fieldsets.current[index] = element;
              }}
            />
          ))}
        </div>
        {(summary !== null || !anyAnswer) && (
          <p
            id={hintId}
            className="text-muted-foreground text-xs leading-4 font-medium"
          >
            {summary ?? t('answerUnavailable')}
          </p>
        )}
      </>
    );
  } else if (outcome.kind === 'approved') {
    body = (
      <AnsweredList
        questions={questions}
        answers={confirmation.resolution?.answers ?? []}
      />
    );
  } else {
    body = (
      <ul className="flex flex-col gap-1">
        {questions.map((question, index) => (
          <li
            key={index}
            className="text-foreground text-sm leading-5 font-medium break-all"
          >
            {question.question}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={t('group', { who, description: confirmation.description })}
      tabIndex={-1}
      data-slot="decision-card"
      data-variant="question"
      data-decision-id={confirmation.decisionId}
      data-state={outcome?.kind ?? 'open'}
      className={frameClass(outcome)}
      onKeyDown={onCardKeyDown}
    >
      <CardHeader outcome={outcome} createdAt={confirmation.createdAt} />
      <CardSource
        confirmation={confirmation}
        byChat={byChat}
        phrase={(link) =>
          t.rich(outcome === null ? 'source' : 'sourcePast', {
            who,
            description: confirmation.description,
            link,
          })
        }
      />
      {body}
      {failed && outcome === null && <ErrorLine>{t('sendFailed')}</ErrorLine>}
      {outcome === null && (
        <div className="flex flex-wrap items-center gap-2 max-[30rem]:flex-col max-[30rem]:items-stretch">
          <DecisionButton
            label={t('answer')}
            variant="default"
            pressed={pressed === 'answer'}
            busy={busy}
            unavailable={!anyAnswer}
            describedBy={summary !== null || !anyAnswer ? hintId : undefined}
            onClick={answer}
            buttonRef={(element) => {
              answerRef.current = element;
            }}
          />
          <DecisionButton
            label={t('skip')}
            variant="ghost"
            pressed={pressed === 'skip'}
            busy={busy}
            onClick={() => sendAs('skip', { approve: true })}
          />
        </div>
      )}
    </div>
  );
}
