"use client";

import { useEffect, useId, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useShellServices } from "@/components/shell/shell-actions";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/** settings-form «Значение скопировано»: the check stays 2 s. */
const COPIED_MS = 2000;

const COPY_TEXT = { copy: "Копировать", copied: "Скопировано" } as const;

/** settings-form «Значение для копирования»: a read-only Mono value with its copy button. */
export function CopyValue({ label, value }: { label: string; value: string }) {
  const labelId = useId();
  const { announcer } = useShellServices();
  const { isCopied, copyToClipboard } = useCopyToClipboard({ copiedDuration: COPIED_MS });
  // Controlled from the first render: the tooltip is open on hover or focus and for the 2 s of «Скопировано».
  const [hinted, setHinted] = useState(false);

  useEffect(() => {
    if (isCopied) announcer.getState().announce(COPY_TEXT.copied);
  }, [isCopied, announcer]);

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <div id={labelId} className="text-data font-medium text-foreground">
        {label}
      </div>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 rounded-md bg-muted px-2.5 py-1 font-mono text-mono-compact break-all text-foreground">
          {value}
        </code>
        <TooltipProvider>
          <Tooltip open={isCopied || hinted} onOpenChange={setHinted}>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-coarse:size-11"
                  aria-label={`${COPY_TEXT.copy}: ${label}`}
                  onClick={() => copyToClipboard(value)}
                />
              }
            >
              {isCopied ? <Check aria-hidden /> : <Copy aria-hidden />}
            </TooltipTrigger>
            <TooltipContent>{isCopied ? COPY_TEXT.copied : `${COPY_TEXT.copy}: ${label}`}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}
