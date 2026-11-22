'use client';

import { useId, useState } from 'react';
import { ArrowRight, Info, LoaderCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CAPTION } from '@/components/admin/admin-form';
import { ShellLink } from '@/components/shell/shell-link';
import { Switch } from '@/components/ui/switch';
import { cn } from 'cn';

export type SelfLearningFieldProps = {
  /** The flag of the saved record. */
  checked: boolean;
  /** Saves the record with the flag flipped; a refusal is already logged by the caller's `recordAction`. */
  onSave: (checked: boolean) => Promise<void>;
  /** The knowledge screen of the deep agent; `null` where the page has its own entry to it. */
  knowledgeHref: string | null;
};

/**
 * «Самообучение» on the deep agent's card (deep-agents UXRD DA-13; self-learning UXRD, MC-1): the switch saves
 * at once. While the save runs it stands in its new position, unavailable, with `LoaderCircle`; a refusal moves
 * it back and shows MC-26 under it. The «kept» note follows a switch-off made here. The hint and the note are the
 * switch's description, not alerts.
 */
export function SelfLearningField({
  checked,
  onSave,
  knowledgeHref,
}: SelfLearningFieldProps) {
  const id = useId();
  const t = useTranslations('library');
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const noteId = `${id}-note`;
  const errorId = `${id}-error`;
  const [target, setTarget] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [turnedOff, setTurnedOff] = useState(false);
  const saving = target !== null;
  const shown = target ?? checked;
  const kept = turnedOff && !shown;

  async function save(next: boolean): Promise<void> {
    setFailed(false);
    setTarget(next);
    try {
      await onSave(next);
      setTurnedOff(!next);
    } catch {
      // `recordAction` has logged the refusal; the switch goes back and MC-26 names the failure.
      setFailed(true);
    } finally {
      setTarget(null);
    }
  }

  const describedBy = [hintId, kept ? noteId : null, failed ? errorId : null]
    .filter((part) => part !== null)
    .join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex w-fit items-center gap-2 pointer-coarse:min-h-11">
        <Switch
          checked={shown}
          disabled={saving}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          onCheckedChange={(next) => void save(next)}
          className="pointer-coarse:after:-inset-3"
        />
        <span
          id={labelId}
          className={cn(
            'text-foreground text-sm leading-5 font-medium',
            saving && 'opacity-50',
          )}
        >
          {t('fields.selfLearning')}
        </span>
        {saving && (
          <LoaderCircle
            aria-hidden
            className="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
          />
        )}
      </label>
      <p id={hintId} className={cn(CAPTION, 'text-muted-foreground')}>
        {t('selfLearning.hint')}
      </p>
      {kept && (
        <p
          id={noteId}
          className={cn(CAPTION, 'text-foreground flex items-start gap-1.5')}
        >
          <Info aria-hidden className="text-info mt-px size-3.5 shrink-0" />
          {t('selfLearning.kept')}
        </p>
      )}
      {failed && (
        <p
          id={errorId}
          role="alert"
          className={cn(CAPTION, 'text-destructive')}
        >
          {t('card.saveFailed')}
        </p>
      )}
      {knowledgeHref !== null && (
        <ShellLink
          href={knowledgeHref}
          className="text-primary focus-visible:ring-ring/50 inline-flex w-fit items-center gap-1 rounded-sm text-sm leading-5 font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 pointer-coarse:min-h-11"
        >
          {t('knowledge.entry')}
          <ArrowRight aria-hidden className="size-3.5" />
        </ShellLink>
      )}
    </div>
  );
}
