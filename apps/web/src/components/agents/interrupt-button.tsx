"use client";

import { useState } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { focusShellTarget } from "@/lib/focus";

/** UXRD MC-13, verbatim. */
const TEXT = {
  interrupt: "Прервать",
  interruptAndSend: "Прервать и отправить",
} as const;

export type InterruptButtonProps = {
  /**
   * Interrupts the agent, with the text when the field holds one; rejects when the server did not take
   * it — the feed store has then logged the failure and keeps the text for the composer (KD-4, MC-27).
   */
  onInterrupt: (text?: string) => Promise<void>;
};

/**
 * «Прервать» next to «Отправить» while the agent works (UXRD KD-2, CV-05, MC-13); with text in the field
 * it is «Прервать и отправить» and takes the text along. The field is cleared at once and focus returns
 * to it, as after «Отправить».
 */
export function InterruptButton({ onInterrupt }: InterruptButtonProps) {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const [pending, setPending] = useState(false);
  const withText = text.trim() !== "";

  async function interrupt(): Promise<void> {
    if (pending) return;
    const message = withText ? text : undefined;
    setPending(true);
    if (message !== undefined) aui.composer.setText("");
    focusShellTarget("composer");
    try {
      await onInterrupt(message);
    } catch {
      // Handled by the feed store: logged once, and `sendFailure` returns the text to the field with MC-27.
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={() => void interrupt()}
      className="rounded-full pointer-coarse:h-11"
    >
      <SquareIcon aria-hidden className="size-3 fill-current" />
      {withText ? TEXT.interruptAndSend : TEXT.interrupt}
    </Button>
  );
}
