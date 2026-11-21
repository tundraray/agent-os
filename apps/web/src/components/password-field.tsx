"use client";

import { useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * On a field where an administrator types someone else's password or a service secret: the browser's and the
 * common extensions' password managers neither offer to save it nor fill their own.
 */
export const NO_PASSWORD_MANAGER = { "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "" } as const;

type RevealInputProps = Omit<ComponentProps<typeof Input>, "type" | "size"> & {
  /** The toggle's name; `aria-pressed` tells whether the value is shown. */
  showLabel: string;
  /** The toggle's name while the value is shown, when it differs. */
  hideLabel?: string;
  /** The panel's density: a 28 px input (44 px under a coarse pointer) instead of 36 px. */
  compact?: boolean;
};

/** A hidden-value input with the button that shows what was typed. */
export function RevealInput({ showLabel, hideLabel = showLabel, compact = false, className, disabled, ...input }: RevealInputProps) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        {...input}
        type={shown ? "text" : "password"}
        disabled={disabled}
        className={cn(compact ? "h-7 pr-9 pointer-coarse:h-11" : "h-9 pr-10", className)}
      />
      <Button
        type="button"
        variant="ghost"
        size={compact ? "icon-xs" : "icon-sm"}
        className={cn("absolute top-1/2 right-1 -translate-y-1/2", compact && "pointer-coarse:size-11")}
        aria-label={shown ? hideLabel : showLabel}
        aria-pressed={shown}
        disabled={disabled}
        onClick={() => setShown((current) => !current)}
      >
        {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      </Button>
    </div>
  );
}

export type PasswordFieldProps = {
  /** Id and `name` of the input; the error text gets `${id}-error`. */
  id: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  inputRef?: ComponentProps<typeof Input>["ref"];
  value: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
  /**
   * In the administrator's panel: the panel's compact density, and a password that is another employee's, so
   * no password manager is offered it.
   */
  panel?: boolean;
};

/** A hidden-input password field with its show button and field error (settings-form «Ошибка поля»). */
export function PasswordField({ id, label, autoComplete, inputRef, value, error, disabled, onChange, panel = false }: PasswordFieldProps) {
  const t = useTranslations("common");
  const errorId = `${id}-error`;
  return (
    <Field data-invalid={error !== undefined} className={cn(panel && "gap-1.5")}>
      <FieldLabel htmlFor={id} className={cn(panel && "text-data font-medium text-foreground")}>
        {label}
      </FieldLabel>
      <RevealInput
        {...(panel ? NO_PASSWORD_MANAGER : {})}
        ref={inputRef}
        id={id}
        name={id}
        autoComplete={autoComplete}
        compact={panel}
        className={cn(panel && "text-data md:text-data")}
        showLabel={t("showPassword")}
        hideLabel={t("hidePassword")}
        value={value}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={errorId} className={cn(panel && "text-xs leading-4")}>
        {error}
      </FieldError>
    </Field>
  );
}
