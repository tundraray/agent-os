"use client";

import { useId, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { ValueRow } from "@/lib/agents/value-rows";
import { cn } from "@/lib/utils";

/** UXRD MC-28. */
const TEXT = { showJson: "Показать как JSON", hideJson: "Скрыть JSON" } as const;

const CAPTION = "text-muted-foreground text-xs leading-4 font-medium";
/** Value text: Data in the tool-call block, UI in the decision card (tool-call.md, «Строки аргументов»). */
const VALUE_TEXT = { data: "text-[13px] leading-[18px]", ui: "text-sm leading-5" } as const;

/** Exact JSON or a result as it came: Mono 13 / 20 on `--muted`, at most 320 px high, scrolls inside. */
function RawBlock({ id, label, className, children }: { id?: string; label: string; className?: string; children: string }) {
  return (
    <pre
      id={id}
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "bg-muted text-foreground focus-visible:ring-ring max-h-80 overflow-auto rounded-md p-2.5 font-mono text-[13px] leading-5 break-words whitespace-pre-wrap outline-none focus-visible:ring-2",
        className,
      )}
    >
      {children}
    </pre>
  );
}

export type ValueRowsProps = {
  /** «Аргументы» or «Результат». */
  label: string;
  /** Rows «label — value»; null shows `raw` alone, always open. */
  rows: ValueRow[] | null;
  /** The exact JSON of the value, or the value as it came. */
  raw: string;
  /** Whether the rows carry the «Показать как JSON» disclosure: the arguments do, a result does not. */
  disclosure: boolean;
  density: keyof typeof VALUE_TEXT;
};

/**
 * The arguments or the result of a tool call for the employee (tool-call.md, «Строки аргументов»):
 * rows «label — value» as a description list and, for the arguments, a collapsed disclosure that opens
 * the exact JSON under the rows. Shared by the tool-call block and the decision card.
 */
export function ValueRows({ label, rows, raw, disclosure, density }: ValueRowsProps) {
  const [rawOpen, setRawOpen] = useState(false);
  const rawId = useId();

  if (rows === null) {
    return (
      <div data-slot="value-rows" className="flex flex-col gap-1">
        <p className={CAPTION}>{label}</p>
        <RawBlock label={label}>{raw}</RawBlock>
      </div>
    );
  }

  return (
    <div data-slot="value-rows" role="region" aria-label={label} className="flex flex-col gap-1">
      <p className={CAPTION}>{label}</p>
      {rows.length > 0 && (
        <dl className="grid grid-cols-[fit-content(33.333%)_minmax(0,1fr)] gap-x-3 gap-y-1">
          {rows.map((row) => (
            <div key={row.key} className="contents">
              <dt className={cn(CAPTION, "pt-0.5 break-words")}>{row.label}</dt>
              <dd
                className={cn(
                  "text-foreground min-w-0 break-words whitespace-pre-wrap",
                  row.value.json ? "col-span-2 font-mono text-[13px] leading-5" : VALUE_TEXT[density],
                )}
              >
                {row.value.text}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {disclosure && (
        <button
          type="button"
          aria-expanded={rawOpen}
          aria-controls={rawOpen ? rawId : undefined}
          onClick={() => setRawOpen((open) => !open)}
          className={cn(
            CAPTION,
            "hover:text-foreground focus-visible:ring-ring flex h-6 items-center gap-1 self-start rounded-sm outline-none focus-visible:ring-2 pointer-coarse:h-11",
          )}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 transition-transform duration-(--duration-fast) motion-reduce:transition-none",
              rawOpen && "rotate-90",
            )}
          />
          {rawOpen ? TEXT.hideJson : TEXT.showJson}
        </button>
      )}
      {rawOpen && (
        <RawBlock
          id={rawId}
          label="JSON"
          className="animate-in fade-in-0 duration-(--duration-fast) motion-reduce:animate-none"
        >
          {raw}
        </RawBlock>
      )}
    </div>
  );
}
