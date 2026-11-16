"use client";

import { useRef, useState } from "react";
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
  /** The confirmed request; the dialog closes when it resolves and stays open with the reason when it rejects. */
  onConfirm: () => Promise<void>;
  /** Names the change in the log, e.g. «admin: user block». */
  logEvent: string;
  /**
   * The confirmed action removes the control that opened the dialog (a row, a record page): the closing
   * dialog hands focus to the page `h1` instead. A cancelled dialog still returns it to that control.
   */
  focusTitleAfterConfirm?: boolean;
};

/**
 * The one confirmation of the panel's destructive actions (block, delete a role, a model, a server) and of
 * giving the admin right.
 * One request per confirmation: the button is unavailable while it runs; «Отмена» and Esc send nothing.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  logEvent,
  focusTitleAfterConfirm = false,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleFocus = useRef<HTMLElement | null>(null);

  const changeOpen = (next: boolean): void => {
    if (!next) setError(null);
    onOpenChange(next);
  };

  async function confirm(): Promise<void> {
    if (pending) return;
    setError(null);
    setPending(true);
    titleFocus.current = null;
    try {
      await onConfirm();
      if (focusTitleAfterConfirm) titleFocus.current = document.querySelector('[data-shell-focus="page-title"]');
      changeOpen(false);
    } catch (cause) {
      setError(describeRefusal(cause, { logEvent })?.text ?? null);
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <AlertDialogContent finalFocus={titleFocus}>
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
