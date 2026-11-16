"use client";

import { useState, type RefObject } from "react";
import { LoaderCircle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { CONTROL_SIZE, describeRefusal, FORM_TEXT, FormError } from "./admin-form";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  confirmLabel: string;
  /** The destructive request; the dialog closes when it resolves and stays open with the reason when it rejects. */
  onConfirm: () => Promise<void>;
  /** Names the change in the log, e.g. «admin: user block». */
  logEvent: string;
  /** Where focus goes after the dialog closes; by default the element that opened it. */
  finalFocus?: RefObject<HTMLElement | null>;
};

/**
 * The one confirmation of the panel's destructive actions (block, delete a role, a model, a server).
 * One request per confirmation: the button is unavailable while it runs; «Отмена» and Esc send nothing.
 */
export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel, onConfirm, logEvent, finalFocus }: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeOpen = (next: boolean): void => {
    if (!next) setError(null);
    onOpenChange(next);
  };

  async function confirm(): Promise<void> {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await onConfirm();
      changeOpen(false);
    } catch (cause) {
      setError(describeRefusal(cause, { logEvent })?.text ?? null);
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <AlertDialogContent finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {error !== null && <FormError>{error}</FormError>}
        <AlertDialogFooter>
          <AlertDialogCancel size="sm" className={CONTROL_SIZE}>
            {FORM_TEXT.cancel}
          </AlertDialogCancel>
          <Button variant="destructive" size="sm" className={CONTROL_SIZE} disabled={pending} onClick={() => void confirm()}>
            {pending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
