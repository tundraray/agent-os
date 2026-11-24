'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Mono 13 / 20 up to 320 px in the tool-call block, Mono 14 / 22 whole in the decision card (tool-call.md). */
const CODE = {
  data: {
    block: 'max-h-80 overflow-auto text-[13px] leading-5',
    line: 'min-h-5',
  },
  ui: { block: 'text-sm leading-[22px]', line: 'min-h-[22px]' },
} as const;

export type ScriptToggleProps = {
  /** The script exactly as it went to the tool. */
  script: string;
  density: keyof typeof CODE;
};

/** The JavaScript line terminators: the card's lines are the lines the engine executes (KD-9). */
const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029]/;

/**
 * The value of the «Скрипт» row (tool-call.md, «Строки аргументов»): a disclosure, collapsed by default
 * (KD-1), that opens the whole script as a code block on its own line under the row. Renders the row's
 * `dd` parts, so it stands in a `dl` right after the row's `dt`.
 */
export function ScriptToggle({ script, density }: ScriptToggleProps) {
  const t = useTranslations('agents');
  const [open, setOpen] = useState(false);
  const blockId = useId();
  const lines = script.split(LINE_TERMINATOR);
  const numberWidth = `${String(lines.length).length}ch`;

  return (
    <>
      <dd className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? blockId : undefined}
          onClick={() => setOpen((value) => !value)}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-6 items-center gap-1 rounded-sm text-xs leading-4 font-medium outline-none focus-visible:ring-2 pointer-coarse:h-11"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              'size-3.5 transition-transform duration-(--duration-fast) motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
          {t(open ? 'runCode.hideScript' : 'runCode.showScript')}
        </button>
      </dd>
      {open && (
        <dd className="col-span-2 min-w-0">
          <div
            id={blockId}
            role="region"
            aria-label={t('runCode.script')}
            // Only the bounded block scrolls, so only it is a focus stop for the arrow keys.
            tabIndex={density === 'data' ? 0 : undefined}
            className={cn(
              'bg-muted text-foreground focus-visible:ring-ring animate-in fade-in-0 rounded-md p-2.5 font-mono outline-none duration-(--duration-fast) focus-visible:ring-2 motion-reduce:animate-none',
              CODE[density].block,
            )}
          >
            {lines.map((line, index) => (
              // Lines are positional: the script is shown as it is and never reordered.
              <div key={index} className={cn('flex gap-3', CODE[density].line)}>
                <span
                  aria-hidden
                  style={{ minWidth: numberWidth }}
                  className="text-muted-foreground shrink-0 text-end tabular-nums select-none"
                >
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                  {line}
                </span>
              </div>
            ))}
          </div>
        </dd>
      )}
    </>
  );
}
