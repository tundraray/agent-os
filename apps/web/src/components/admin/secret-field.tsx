'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import { NO_PASSWORD_MANAGER, RevealInput } from '@/components/password-field';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { CAPTION, CONTROL_SIZE } from './admin-form';

export type SecretFieldProps = {
  id: string;
  label: string;
  /** Whether the platform holds a value (`options.clientSecretSet`, `sharedTokenSet`); the value itself never comes back. */
  isSet: boolean;
  /** The typed replacement; `undefined` while there is none, so the secret stays out of the request body. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  error: string | undefined;
  /** The held secret's last four characters as the server reports them (`apiKeyLast4`), shown after «Задан». */
  lastFour?: string | null;
  /** The hint under the field, read as its description. */
  hint?: string;
};

type FocusTarget = 'input' | 'replace';

/**
 * design-system secret-field: a secret can only be set or replaced. A held secret shows «Задан» and
 * «Заменить»; the replacement exists only in the form's state until it is sent (Invariant 3).
 */
export function SecretField({
  id,
  label,
  isSet,
  value,
  onChange,
  error,
  lastFour,
  hint,
}: SecretFieldProps) {
  const t = useTranslations('admin.secret');
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  // Never more than four characters, whatever the caller passes.
  const tail =
    lastFour === undefined || lastFour === null || lastFour === ''
      ? null
      : lastFour.slice(-4);
  const describedBy = [
    hint !== undefined ? hintId : null,
    error !== undefined ? errorId : null,
  ]
    .filter((part) => part !== null)
    .join(' ');
  const hintText =
    hint === undefined ? null : (
      <FieldDescription
        id={hintId}
        className={cn(CAPTION, 'text-muted-foreground')}
      >
        {hint}
      </FieldDescription>
    );
  /** Where focus goes once the next commit has rendered it: the field after «Заменить», «Заменить» after the cancel. */
  const pendingFocus = useRef<FocusTarget | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const replacing = value !== undefined;

  useEffect(() => {
    if (pendingFocus.current === 'input') inputRef.current?.focus();
    if (pendingFocus.current === 'replace') replaceRef.current?.focus();
    pendingFocus.current = null;
  });

  if (isSet && !replacing) {
    const badge = <StateBadge state="neutral">{t('set')}</StateBadge>;
    return (
      <Field
        role="group"
        aria-labelledby={labelId}
        aria-describedby={hint !== undefined ? hintId : undefined}
        className="gap-1.5"
      >
        <div id={labelId} className="text-data font-medium text-foreground">
          {label}
        </div>
        <div className="flex items-center justify-between gap-2">
          {tail === null ? (
            badge
          ) : (
            <span className="flex items-center gap-2">
              {badge}
              <span
                aria-hidden
                className="font-mono text-mono-compact text-muted-foreground"
              >
                …{tail}
              </span>
              <span className="sr-only">{t('endsWith', { tail })}</span>
            </span>
          )}
          <Button
            ref={replaceRef}
            type="button"
            variant="outline"
            size="sm"
            className={CONTROL_SIZE}
            aria-label={t('replaceLabel', { label })}
            onClick={() => {
              pendingFocus.current = 'input';
              onChange('');
            }}
          >
            {t('replace')}
          </Button>
        </div>
        {hintText}
      </Field>
    );
  }

  return (
    <Field data-invalid={error !== undefined} className="gap-1.5">
      <FieldLabel
        htmlFor={id}
        className="text-data font-medium text-foreground"
      >
        {label}
      </FieldLabel>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {/* Mounted with the replacement, so a new «Заменить» starts hidden again. */}
          <RevealInput
            {...NO_PASSWORD_MANAGER}
            ref={inputRef}
            id={id}
            name={id}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={t('placeholder')}
            compact
            className="font-mono text-mono-compact"
            showLabel={t('show')}
            value={value ?? ''}
            aria-invalid={error !== undefined}
            aria-describedby={describedBy === '' ? undefined : describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
        {isSet && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={CONTROL_SIZE}
            onClick={() => {
              pendingFocus.current = 'replace';
              onChange(undefined);
            }}
          >
            {t('cancelReplace')}
          </Button>
        )}
      </div>
      {hintText}
      <FieldError id={errorId} className={CAPTION}>
        {error}
      </FieldError>
    </Field>
  );
}
