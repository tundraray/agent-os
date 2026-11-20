"use client";

import { useState } from "react";
import { SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { focusShellTarget } from "@/lib/focus";

export type InterruptButtonProps = {
  /** Interrupts the agent; rejects when the server did not take it — the feed store has then logged the failure. */
  onInterrupt: () => Promise<void>;
};

/**
 * «Прервать» next to «Отправить» while the agent works (UXRD KD-2, CV-05, MC-13). It only stops the
 * agent: the text in the field stays there, and a message to a working agent goes by «Отправить».
 * Focus returns to the field.
 */
export function InterruptButton({ onInterrupt }: InterruptButtonProps) {
  const [pending, setPending] = useState(false);

  async function interrupt(): Promise<void> {
    if (pending) return;
    setPending(true);
    focusShellTarget("composer");
    try {
      await onInterrupt();
    } catch {
      // Handled by the feed store: logged once.
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
      Прервать
    </Button>
  );
}
