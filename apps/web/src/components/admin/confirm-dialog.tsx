"use client";

import { useRef, useState, type ReactNode } from "react";
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
  /**
   * The confirmed action removes the control that opened the dialog (a row, a record page): the closing
   * dialog hands focus to the page `h1` instead. A cancelled dialog still returns it to that control.
   */
  focusTitleAfterConfirm?: boolean;
} & (
  | {
      /** Names the change in the log, e.g. «admin: user block»; the dialog logs the refusal and words it as the panel's. */
      logEvent: string;
      refusalText?: undefined;
    }
  | {
      logEvent?: undefined;
      /** The text of a refusal that the request has logged itself (`recordAction`). */
      refusalText: (cause: unknown) => ReactNode;
    }
);

/**
 * The one confirmation of the panel's destructive actions (block, delete a role, a model, a server), of
 * giving the admin right, and of the library's deleting a record and closing its access.
 * One request per confirmation: while it runs the button and «Отмена» are unavailable and Esc closes nothing, so
 * a refusal is always seen and the request's follow-up never outlives its dialog.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  logEvent,
  refusalText,
  focusTitleAfterConfirm = false,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const titleFocus = useRef<HTMLElement | null>(null);
  // A ref, not `pending`: the success path closes while the state still reads true.
  const running = useRef(false);

  const changeOpen = (next: boolean): void => {
    if (!next && running.current) return;
    if (!next) setError(null);
    onOpenChange(next);
  };

  async function confirm(): Promise<void> {
    if (running.current) return;
    setError(null);
    running.current = true;
    setPending(true);
    titleFocus.current = null;
    try {
      await onConfirm();
      if (focusTitleAfterConfirm) titleFocus.current = document.querySelector('[data-shell-focus="page-title"]');
      running.current = false;
      changeOpen(false);
    } catch (cause) {
      if (refusalText !== undefined) setError(refusalText(cause));
      else setError(describeRefusal(cause, { logEvent })?.text ?? null);
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <AlertDialogContent finalFocus={titleFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-break-word">{title}</AlertDialogTitle>
          <AlertDialogDescription className="wrap-break-word">{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {error !== null && <FormError>{error}</FormError>}
        <AlertDialogFooter>
          <AlertDialogCancel size="sm" className={CONTROL_SIZE} disabled={pending}>
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
