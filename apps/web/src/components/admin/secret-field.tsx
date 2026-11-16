"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "cn";
import { StateBadge } from "@/components/state-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { CAPTION, CONTROL_SIZE } from "./admin-form";

/** MC-28. */
const SECRET_TEXT = {
  set: "Задан",
  replace: "Заменить",
  cancelReplace: "Отменить замену",
  placeholder: "Новое значение",
  show: "Показать введённое значение",
} as const;

export type SecretFieldProps = {
  id: string;
  label: string;
  /** Whether the platform holds a value (`options.clientSecretSet`, `sharedTokenSet`); the value itself never comes back. */
  isSet: boolean;
  /** The typed replacement; `undefined` while there is none, so the secret stays out of the request body. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  error: string | undefined;
};

type FocusTarget = "input" | "replace";

/**
 * design-system secret-field: a secret can only be set or replaced. A held secret shows «Задан» and
 * «Заменить»; the replacement exists only in the form's state until it is sent (Invariant 3).
 */
export function SecretField({ id, label, isSet, value, onChange, error }: SecretFieldProps) {
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const [shown, setShown] = useState(false);
  /** Where focus goes once the next commit has rendered it: the field after «Заменить», «Заменить» after the cancel. */
  const pendingFocus = useRef<FocusTarget | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const replacing = value !== undefined;

  useEffect(() => {
    if (pendingFocus.current === "input") inputRef.current?.focus();
    if (pendingFocus.current === "replace") replaceRef.current?.focus();
    pendingFocus.current = null;
  });

  if (isSet && !replacing) {
    return (
      <Field role="group" aria-labelledby={labelId} className="gap-1.5">
        <div id={labelId} className="text-data font-medium text-foreground">
          {label}
        </div>
        <div className="flex items-center justify-between gap-2">
          <StateBadge state="neutral">{SECRET_TEXT.set}</StateBadge>
          <Button
            ref={replaceRef}
            type="button"
            variant="outline"
            size="sm"
            className={CONTROL_SIZE}
            aria-label={`${SECRET_TEXT.replace}: ${label}`}
            onClick={() => {
              setShown(false);
              pendingFocus.current = "input";
              onChange("");
            }}
          >
            {SECRET_TEXT.replace}
          </Button>
        </div>
      </Field>
    );
  }

  return (
    <Field data-invalid={error !== undefined} className="gap-1.5">
      <FieldLabel htmlFor={id} className="text-data font-medium text-foreground">
        {label}
      </FieldLabel>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            ref={inputRef}
            id={id}
            name={id}
            type={shown ? "text" : "password"}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={SECRET_TEXT.placeholder}
            className={cn(CONTROL_SIZE, "pr-9 font-mono text-mono-compact")}
            value={value ?? ""}
            aria-invalid={error !== undefined}
            aria-describedby={error !== undefined ? errorId : undefined}
            onChange={(event) => onChange(event.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute top-1/2 right-1 -translate-y-1/2 pointer-coarse:size-11"
            aria-label={SECRET_TEXT.show}
            aria-pressed={shown}
            onClick={() => setShown((current) => !current)}
          >
            {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </Button>
        </div>
        {isSet && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={CONTROL_SIZE}
            onClick={() => {
              pendingFocus.current = "replace";
              onChange(undefined);
            }}
          >
            {SECRET_TEXT.cancelReplace}
          </Button>
        )}
      </div>
      <FieldError id={errorId} className={CAPTION}>
        {error}
      </FieldError>
    </Field>
  );
}
