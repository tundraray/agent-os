"use client";

import { useId, useState } from "react";
import { cn } from "cn";
import { Switch } from "@/components/ui/switch";
import { CAPTION, describeRefusal } from "./admin-form";

export type SavingSwitchProps = {
  /** The switch's accessible name, e.g. «Включено: {название}» in a table row. */
  label: string;
  /** In a table row the column header names the switch, so the label is read but not shown. */
  labelHidden?: boolean;
  /** The saved position, read from the resource. */
  checked: boolean;
  /** Saves the new position; on success the caller reads the resource again (Invariant 4). */
  onSave: (checked: boolean) => Promise<void>;
  /** Names the change in the log, e.g. «admin: server enable». */
  logEvent: string;
  /** The position cannot be changed here, e.g. the built-in role's admin right (DC-5). */
  disabled?: boolean;
};

/**
 * settings-form «Сохранение на месте»: the switch saves at once. It stands in its new position and is
 * unavailable until the answer; a refusal moves it back (the switch's own 150 ms transition) and names the
 * reason under it.
 */
export function SavingSwitch({ label, labelHidden = false, checked, onSave, logEvent, disabled = false }: SavingSwitchProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const [target, setTarget] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new saved position from the re-read resource replaces the one shown since the save.
  const [savedChecked, setSavedChecked] = useState(checked);
  if (savedChecked !== checked) {
    setSavedChecked(checked);
    setTarget(null);
  }

  async function save(next: boolean): Promise<void> {
    setError(null);
    setTarget(next);
    setSaving(true);
    try {
      await onSave(next);
    } catch (cause) {
      setTarget(null);
      setError(describeRefusal(cause, { logEvent })?.text ?? null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex w-fit items-center gap-2">
        <Switch
          checked={target ?? checked}
          disabled={saving || disabled}
          aria-labelledby={labelId}
          aria-describedby={error !== null ? errorId : undefined}
          onCheckedChange={(next) => void save(next)}
          className="pointer-coarse:after:-inset-3"
        />
        <span id={labelId} className={cn("text-data font-medium text-foreground", (saving || disabled) && "opacity-50", labelHidden && "sr-only")}>
          {label}
        </span>
      </label>
      {error !== null && (
        <p id={errorId} role="alert" className={cn(CAPTION, "text-destructive")}>
          {error}
        </p>
      )}
    </div>
  );
}
