'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslations } from 'next-intl';
import { INSTRUCTIONS_MAX_LENGTH } from '@agent-os/contracts';
import { LoaderCircle } from 'lucide-react';
import {
  CAPTION,
  CONTROL_SIZE,
  describeRefusal,
  FormError,
  FormWarning,
} from '@/components/admin/admin-form';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useResource } from '@/hooks/use-resource';
import { useShellServices } from '@/components/shell/shell-actions';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';

/** How long «Сохранено» stays in the save row (instruction-field.md, States «Готово»). */
const SAVED_SHOWN_MS = 4000;

/**
 * Characters over the limit, 0 within it. The length is the string's `length`, as the `contracts` schema's `max`
 * counts it, so the counter and the server never disagree (design-web.md KD-4).
 */
export const instructionOverflow = (text: string): number =>
  Math.max(0, text.length - INSTRUCTIONS_MAX_LENGTH);

/**
 * Part 4: the characters left, or how far over the limit in `--destructive`. It describes the field; only a crossing
 * of the limit, either way, is announced.
 */
function Counter({ id, text }: { id: string; text: string }) {
  const t = useTranslations('common.instructionField');
  const over = instructionOverflow(text);
  const shown =
    over > 0
      ? t('over', { count: over })
      : t('left', { count: INSTRUCTIONS_MAX_LENGTH - text.length });
  const [wasOver, setWasOver] = useState(over > 0);
  const [announced, setAnnounced] = useState('');
  if (wasOver !== over > 0) {
    setWasOver(over > 0);
    setAnnounced(shown);
  }
  return (
    <>
      <p
        id={id}
        className={cn(
          CAPTION,
          'self-end font-medium tabular-nums',
          over > 0 ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {shown}
      </p>
      <span aria-live="polite" className="sr-only">
        {announced}
      </span>
    </>
  );
}

/** The field error «Сократите текст на …» under the field. */
function OverflowError({ id, text }: { id: string; text: string }) {
  const t = useTranslations('common.instructionField');
  return (
    <p id={id} className={cn(CAPTION, 'text-destructive font-medium')}>
      {t('cut', { count: instructionOverflow(text) })}
    </p>
  );
}

type CardVariantProps = {
  variant: 'card';
  /** The text the card shows while it waits or once decided. */
  text: string;
  /** The text in «Правка»; null outside it, and the field is then the text itself. */
  draft: string | null;
  onDraftChange: (draft: string) => void;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  /** «Сохранить с правками» found the draft over the limit. */
  tooLong: boolean;
  busy: boolean;
  /** The card's heading: the field's name. */
  labelledBy: string;
  /** The line in place of an empty text. */
  emptyText: string;
  placeholder: string;
};

/**
 * «В карточке» (instruction-field.md, Variants): parts 3 and 4 inside the card of a personal instruction. The card
 * owns the draft, the buttons and the outcome; this draws the text or the field and the counter.
 */
function CardField({
  text,
  draft,
  onDraftChange,
  fieldRef,
  tooLong,
  busy,
  labelledBy,
  emptyText,
  placeholder,
}: CardVariantProps) {
  const id = useId();
  const counterId = `${id}-counter`;
  const errorId = `${id}-error`;
  if (draft === null) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {text === '' ? (
          <p className="text-muted-foreground text-sm leading-5">{emptyText}</p>
        ) : (
          <p className="text-foreground text-sm leading-5 break-words whitespace-pre-wrap">
            {text}
          </p>
        )}
        <Counter id={counterId} text={text} />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Textarea
        ref={fieldRef}
        value={draft}
        disabled={busy}
        placeholder={placeholder}
        aria-labelledby={labelledBy}
        aria-invalid={tooLong || undefined}
        aria-describedby={tooLong ? `${counterId} ${errorId}` : counterId}
        onChange={(event) => onDraftChange(event.target.value)}
        className="min-h-0 text-sm leading-5 md:text-sm"
      />
      <Counter id={counterId} text={draft} />
      {tooLong && <OverflowError id={errorId} text={draft} />}
    </div>
  );
}

type OrganisationVariantProps = {
  variant: 'organisation';
  title: string;
  description: string;
  warning: ReactNode;
  placeholder: string;
  /** The resource key of the read, and the log's area. */
  resourceKey: string;
  read: () => Promise<{ text: string }>;
  /** Saves the text; the answer's text becomes the saved one. */
  write: (text: string) => Promise<{ text: string }>;
  /** Names the save in the log, e.g. «admin: organisation instructions». */
  logEvent: string;
};

/**
 * «Организация» (instruction-field.md): the section reads its text on open (read-on-open.md) and shows no field
 * until the text is there, so an empty field never reads as an empty instruction.
 */
function OrganisationField(props: OrganisationVariantProps) {
  const t = useTranslations('common.instructionField');
  const headingId = useId();
  const resource = useResource(props.read, props.resourceKey);
  const saved = resource.data?.text;
  return (
    <section
      aria-labelledby={saved === undefined ? undefined : headingId}
      className="flex max-w-160 flex-col gap-3"
    >
      {resource.status === 'loading' && saved === undefined ? (
        <>
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-[calc(6*26px+18px)] w-full" />
        </>
      ) : saved === undefined ? (
        <>
          <h2 className="text-base leading-6 font-semibold">{props.title}</h2>
          <div className="flex flex-col items-start gap-2">
            <p className="text-foreground text-data">{t('loadFailed')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={CONTROL_SIZE}
              onClick={resource.reload}
            >
              {t('retry')}
            </Button>
          </div>
        </>
      ) : (
        <OrganisationEditor {...props} headingId={headingId} initial={saved} />
      )}
    </section>
  );
}

/** The section once its text is read: «Изменено», the save row, Ctrl+S and the leave question (KD-4, Flow 2). */
function OrganisationEditor({
  title,
  description,
  warning,
  placeholder,
  write,
  logEvent,
  headingId,
  initial,
}: OrganisationVariantProps & { headingId: string; initial: string }) {
  const t = useTranslations('common.instructionField');
  const tCommon = useTranslations('common');
  const tErrors = useTranslations('errors');
  const { leaveGuard } = useShellServices();
  const id = useId();
  const descriptionId = `${id}-description`;
  const counterId = `${id}-counter`;
  const errorId = `${id}-error`;
  const [saved, setSaved] = useState(initial);
  const [text, setText] = useState(initial);
  const [tooLong, setTooLong] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [formError, setFormError] = useState<ReactNode>(null);
  const savingRef = useRef(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const changed = text !== saved;

  useEffect(() => {
    if (changed) leaveGuard.hold({ kind: 'instructions', title });
    else leaveGuard.release();
  }, [changed, title, leaveGuard]);
  useEffect(() => () => leaveGuard.release(), [leaveGuard]);

  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), SAVED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [justSaved]);

  const change = (next: string): void => {
    setText(next);
    setTooLong(false);
    setJustSaved(false);
  };

  async function save(): Promise<void> {
    if (savingRef.current || !changed) return;
    setFormError(null);
    if (instructionOverflow(text) > 0) {
      setTooLong(true);
      fieldRef.current?.focus();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const answer = await write(text);
      // The log names the save and the length, never the text (Security Considerations).
      logger.info(`${logEvent}: saved`, { length: answer.text.length });
      setSaved(answer.text);
      setText(answer.text);
      setJustSaved(true);
    } catch (cause) {
      const refusal = describeRefusal(tErrors, cause, { logEvent });
      if (refusal !== null) setFormError(refusal.text);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Runs after the commit that enables the field again, so focus lands on «Сохранить» (States «Готово»).
  useEffect(() => {
    if (justSaved) saveRef.current?.focus();
  }, [justSaved]);

  const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's')
      return;
    event.preventDefault();
    void save();
  };

  const describedBy = [descriptionId, counterId, tooLong ? errorId : null]
    .filter((part) => part !== null)
    .join(' ');

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-base leading-6 font-semibold">
          {title}
        </h2>
        <p id={descriptionId} className={cn(CAPTION, 'text-muted-foreground')}>
          {description}
        </p>
      </div>
      <FormWarning>{warning}</FormWarning>
      <div className="flex flex-col gap-1">
        <Textarea
          ref={fieldRef}
          value={text}
          disabled={saving}
          placeholder={placeholder}
          aria-labelledby={headingId}
          aria-describedby={describedBy}
          aria-invalid={tooLong || undefined}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onFieldKeyDown}
          className="min-h-[calc(6*26px+18px)] text-base leading-6.5 md:max-h-[50vh] md:overflow-y-auto md:text-base"
        />
        <Counter id={counterId} text={text} />
        {tooLong && <OverflowError id={errorId} text={text} />}
      </div>
      {formError !== null && <FormError>{formError}</FormError>}
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2 max-[30rem]:flex-col max-[30rem]:items-stretch">
        <div className={cn(CAPTION, 'text-muted-foreground min-w-0')}>
          {changed && (
            <p className="animate-in fade-in-0 flex items-center gap-1.5 duration-(--duration-fast) motion-reduce:animate-none">
              <span
                aria-hidden
                className="bg-muted-foreground size-1.5 shrink-0 rounded-full"
              />
              {t('changed')}
            </p>
          )}
          <p aria-live="polite">
            {justSaved && !changed && (
              <span className="animate-in fade-in-0 duration-(--duration-fast) motion-reduce:animate-none">
                {tCommon('saved')}
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2 max-[30rem]:flex-col max-[30rem]:items-stretch">
          {changed && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={CONTROL_SIZE}
              disabled={saving}
              onClick={() => change(saved)}
            >
              {t('discard')}
            </Button>
          )}
          <Button
            ref={saveRef}
            type="button"
            size="sm"
            className={cn(CONTROL_SIZE, 'aria-disabled:opacity-50')}
            aria-disabled={!changed || undefined}
            aria-busy={saving || undefined}
            onClick={() => void save()}
          >
            {saving && (
              <LoaderCircle
                className="animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            )}
            {saving ? tCommon('saving') : t('save')}
          </Button>
        </div>
      </div>
    </>
  );
}

export type InstructionFieldProps = CardVariantProps | OrganisationVariantProps;

/**
 * One long text the agents receive, with a counter of the characters left (instruction-field.md, design-web.md
 * KD-4): «Организация» in the panel, «В карточке» in the card of a personal instruction.
 */
export function InstructionField(props: InstructionFieldProps) {
  return props.variant === 'card' ? (
    <CardField {...props} />
  ) : (
    <OrganisationField {...props} />
  );
}
