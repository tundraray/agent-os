"use client";

import { useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

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
};

/** A hidden-input password field with its show button and field error (settings-form «Ошибка поля»). */
export function PasswordField({ id, label, autoComplete, inputRef, value, error, disabled, onChange }: PasswordFieldProps) {
  const [shown, setShown] = useState(false);
  const errorId = `${id}-error`;
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          name={id}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          className="h-9 pr-10"
          value={value}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={error !== undefined ? errorId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-1/2 right-1 -translate-y-1/2"
          aria-label={shown ? "Скрыть пароль" : "Показать пароль"}
          aria-pressed={shown}
          disabled={disabled}
          onClick={() => setShown((current) => !current)}
        >
          {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
        </Button>
      </div>
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}
