"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CircleX, LoaderCircle, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { describeAdminError, type AdminErrorContext, type AdminErrorText } from "@/lib/admin/admin-errors";
import { describeApiError, isApiRequestError } from "@/lib/api/api-request";
import { focusShellTarget } from "@/lib/focus";
import { logger } from "@/lib/logger";

/** MC-20. */
export const FORM_TEXT = {
  saving: "Сохраняем…",
  saved: "Сохранено",
  cancel: "Отмена",
} as const;

/** KD-6: a panel control is 28 px, 44 px under a coarse pointer. */
export const CONTROL_SIZE = "h-7 pointer-coarse:h-11";

/** Caption 12 / 16 under a field or a switch (foundations, typography). */
export const CAPTION = "text-xs leading-4";

/**
 * The one handling of a refused change for the panel's forms, confirmations and switches: logged once,
 * here, with the request's shape only (no body, so no secret), and turned into the UXRD text.
 */
export function describeRefusal(
  error: unknown,
  { logEvent, context }: { logEvent: string; context?: AdminErrorContext },
): AdminErrorText | null {
  if (isApiRequestError(error)) logger.warn(`${logEvent}: refused`, describeApiError(error));
  else logger.error(`${logEvent}: failed`, { error });
  return describeAdminError(error, context);
}

/** settings-form «Ошибка формы»: the refusal above the actions; takes focus when it appears. */
export function FormError({ children }: { children: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [children]);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="flex items-start gap-2 rounded-md border border-destructive-border bg-destructive-subtle px-3 py-2 text-data text-foreground outline-none"
    >
      <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <p>{children}</p>
    </div>
  );
}

/** settings-form «Предупреждение»: the consequence of a setting, placed at its field; it does not block saving. */
export function FormWarning({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-data text-foreground">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export type AdminTextFieldProps = {
  id: string;
  label: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  hint?: string;
  /** Mono 13 / 20 for technical values: addresses, ids, tokens. */
  mono?: boolean;
  type?: "text" | "email" | "url";
  inputMode?: "decimal" | "numeric" | "email" | "url";
  maxLength?: number;
  /** The unit after the input, e.g. «часов». */
  suffix?: string;
  /** The input's own width, e.g. `w-24` for a short number. */
  inputClassName?: string;
};

/** One single-line field of a panel form: label, 28 px input, hint and field error (settings-form). */
export function AdminTextField({
  id,
  label,
  value,
  error,
  onChange,
  hint,
  mono = false,
  type = "text",
  inputMode,
  maxLength,
  suffix,
  inputClassName,
}: AdminTextFieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
    .filter((part) => part !== null)
    .join(" ");
  const input = (
    <Input
      id={id}
      name={id}
      type={type}
      inputMode={inputMode}
      maxLength={maxLength}
      autoComplete="off"
      className={cn(CONTROL_SIZE, mono ? "font-mono text-mono-compact" : "text-data md:text-data", inputClassName)}
      value={value}
      aria-invalid={error !== undefined}
      aria-describedby={describedBy === "" ? undefined : describedBy}
      onChange={(event) => onChange(event.target.value)}
    />
  );
  return (
    <Field data-invalid={error !== undefined} className="gap-1.5">
      <FieldLabel htmlFor={id} className="text-data font-medium text-foreground">
        {label}
      </FieldLabel>
      {suffix === undefined ? (
        input
      ) : (
        <div className="flex items-center gap-2">
          {input}
          <span className="text-data text-muted-foreground">{suffix}</span>
        </div>
      )}
      {hint !== undefined && (
        <FieldDescription id={hintId} className={cn(CAPTION, "text-muted-foreground")}>
          {hint}
        </FieldDescription>
      )}
      <FieldError id={errorId} className={CAPTION}>
        {error}
      </FieldError>
    </Field>
  );
}

export type AdminRadioOption<Value extends string> = {
  value: Value;
  label: string;
  /** What the choice means, under its radio. */
  hint?: string;
};

export type AdminRadioFieldProps<Value extends string> = {
  label: string;
  value: Value;
  options: readonly AdminRadioOption<Value>[];
  onChange: (value: Value) => void;
};

/** A one-of-several field of a panel form (settings-form, shadcn `radio-group`): legend, radios, a hint per choice. */
export function AdminRadioField<Value extends string>({ label, value, options, onChange }: AdminRadioFieldProps<Value>) {
  const id = useId();
  const hintId = (option: AdminRadioOption<Value>): string => `${id}-${option.value}`;
  return (
    <FieldSet className="gap-1.5">
      <FieldLegend id={id} variant="label" className="mb-0 text-data font-medium text-foreground">
        {label}
      </FieldLegend>
      <RadioGroup
        aria-labelledby={id}
        value={value}
        onValueChange={(next) => {
          const chosen = options.find((option) => option.value === next);
          if (chosen !== undefined) onChange(chosen.value);
        }}
        className="gap-2"
      >
        {options.map((option) => (
          <div key={option.value} className="flex flex-col gap-0.5">
            <Label className="flex w-fit items-center gap-2 text-data font-normal text-foreground pointer-coarse:min-h-11">
              <RadioGroupItem value={option.value} aria-describedby={option.hint === undefined ? undefined : hintId(option)} />
              {option.label}
            </Label>
            {option.hint !== undefined && (
              <FieldDescription id={hintId(option)} className={cn(CAPTION, "pl-6 text-muted-foreground")}>
                {option.hint}
              </FieldDescription>
            )}
          </div>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}

export type AdminFormApi<Values> = {
  values: Values;
  /** Sets a field's value and clears the error shown at it (settings-form «Ошибка поля»). */
  set: <Key extends keyof Values>(name: Key, value: Values[Key]) => void;
  /** Clears an error whose key is not a value of its own (e.g. `long.inputUsdPerMTok`). */
  clearError: (key: string) => void;
  /** Id and shown error of the field with this key. */
  field: (key: string) => { id: string; error: string | undefined };
  saving: boolean;
};

export type AdminFormProps<Values extends Record<string, unknown>> = {
  variant: "page" | "dialog";
  initialValues: Values;
  /** The form's pure field rule (`form-rules.ts`); an empty object lets the form send. */
  validate: (values: Values) => Partial<Record<string, string>>;
  onSubmit: (values: Values) => Promise<void>;
  submitLabel: string;
  /** The submit button while the request runs, e.g. «Проверяем сервер…»; a function when it depends on the values. */
  savingLabel?: string | ((values: Values) => string);
  /** False while the values hold nothing to send: the submit button is then unavailable. */
  hasChange?: (values: Values) => boolean;
  /** The toast after a save; a page says «Сохранено» unless told otherwise, a dialog says nothing. */
  savedText?: string | null;
  /** After a successful save: the page returns to its record, the dialog's owner closes it. */
  onSaved?: () => void;
  /** A page form's «Отмена»; a dialog's «Отмена» always closes the dialog. */
  onCancel?: () => void;
  /** Keys of `SecretField` values: emptied after a successful save, so a secret lives only until it is sent. */
  secretFields?: readonly (keyof Values)[];
  errorContext?: AdminErrorContext;
  /** Names the change in the log, e.g. «admin: role create». */
  logEvent: string;
  children: (form: AdminFormApi<Values>) => ReactNode;
};

/**
 * KD-5: the panel's form. Checks on submit and sends nothing with field errors (focus on the first one in
 * order); disables itself while saving, so a second press sends nothing; shows a refusal at its field or
 * above the actions, keeping what was typed.
 */
export function AdminForm<Values extends Record<string, unknown>>({
  variant,
  initialValues,
  validate,
  onSubmit,
  submitLabel,
  savingLabel = FORM_TEXT.saving,
  hasChange,
  savedText = variant === "page" ? FORM_TEXT.saved : null,
  onSaved,
  onCancel,
  secretFields = [],
  errorContext,
  logEvent,
  children,
}: AdminFormProps<Values>) {
  const idPrefix = useId();
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Grows with every set of field errors shown, so focus moves to the first of them again. */
  const [fieldErrorsShown, setFieldErrorsShown] = useState(0);
  const savingRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Runs after the commit that enables the fields again, so the field can take focus.
  useEffect(() => {
    if (fieldErrorsShown === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [fieldErrorsShown]);

  const showFieldErrors = (shown: Partial<Record<string, string>>): void => {
    setErrors(shown);
    setFieldErrorsShown((count) => count + 1);
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (savingRef.current || hasChange?.(values) === false) return;
    setFormError(null);
    const checked = validate(values);
    if (Object.values(checked).some((text) => text !== undefined)) {
      showFieldErrors(checked);
      return;
    }
    setErrors({});
    savingRef.current = true;
    setSaving(true);
    try {
      await onSubmit(values);
      logger.info(`${logEvent}: saved`);
      if (secretFields.length > 0) {
        setValues((current) => secretFields.reduce((next, key) => ({ ...next, [key]: undefined }), current));
      }
      if (savedText !== null) toast.success(savedText);
      if (variant === "page") focusShellTarget("page-title");
      onSaved?.();
    } catch (cause) {
      const refusal = describeRefusal(cause, { logEvent, context: errorContext });
      if (refusal === null) return;
      if (refusal.target !== "form" && refusal.target in values) showFieldErrors({ [refusal.target]: refusal.text });
      else setFormError(refusal.text);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const api: AdminFormApi<Values> = {
    values,
    set: (name, value) => {
      setValues((current) => ({ ...current, [name]: value }));
      setErrors((shown) => ({ ...shown, [name]: undefined }));
    },
    clearError: (key) => setErrors((shown) => ({ ...shown, [key]: undefined })),
    field: (key) => ({ id: `${idPrefix}-${key}`, error: errors[key] }),
    saving,
  };

  const submit = (
    <Button type="submit" size="sm" className={CONTROL_SIZE} disabled={saving || hasChange?.(values) === false}>
      {saving && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
      {saving ? (typeof savingLabel === "function" ? savingLabel(values) : savingLabel) : submitLabel}
    </Button>
  );
  const cancel =
    variant === "dialog" ? (
      <DialogClose render={<Button type="button" variant="outline" size="sm" className={CONTROL_SIZE} />} disabled={saving}>
        {FORM_TEXT.cancel}
      </DialogClose>
    ) : onCancel !== undefined ? (
      <Button type="button" variant="outline" size="sm" className={CONTROL_SIZE} disabled={saving} onClick={onCancel}>
        {FORM_TEXT.cancel}
      </Button>
    ) : null;

  return (
    <form ref={formRef} noValidate onSubmit={handleSubmit} className="flex max-w-160 flex-col gap-4">
      {/* A disabled fieldset disables every native field and button inside while the request runs. */}
      <fieldset disabled={saving} className="contents">
        <FieldGroup className="gap-4">{children(api)}</FieldGroup>
      </fieldset>
      {formError !== null && <FormError>{formError}</FormError>}
      {variant === "dialog" ? (
        <DialogFooter className="sm:justify-start">
          {submit}
          {cancel}
        </DialogFooter>
      ) : (
        <div className="flex gap-2">
          {submit}
          {cancel}
        </div>
      )}
    </form>
  );
}
