import { RUN_CODE_TOOL, RunCodeArgsSchema } from '@agent-os/contracts';
import type { ValueRow } from '@/lib/agents/value-rows';

/** The run's end when the script returned nothing (code-execution UXRD, KD-5). */
export const NO_RUN_VALUE = '—';

/** The built-in `run_code`: the tool name alone is not enough, an MCP server may name a tool the same. */
export function isRunCode(tool: string, server: string | null): boolean {
  return tool === RUN_CODE_TOOL && server === null;
}

/** A code run as the tool-call block and the decision card show it. */
export type RunCodeView = {
  description: string;
  /** «Описание» and «Класс запуска», in the order of `RunCodeArgs` fields, not of the model's keys (KD-2). */
  rows: ValueRow[];
  /** The last row: the script behind «Показать скрипт» (KD-1). */
  script: { label: string; text: string };
};

/**
 * The arguments of a code run as rows; the labels (MC-2) are the catalogue's, like any built-in tool's
 * (`builtinToolLabels`), and the class reads in words (MC-3) from the `agents` messages. Null when the
 * arguments do not pass `RunCodeArgsSchema`: they are then ordinary rows.
 */
export function runCodeView(
  args: unknown,
  labels: Readonly<Record<string, string>> = {},
): RunCodeView | null {
  const parsed = RunCodeArgsSchema.safeParse(args);
  if (!parsed.success) return null;
  const { description, class: runClass, script } = parsed.data;
  return {
    description,
    rows: [
      {
        key: 'description',
        label: labels.description ?? 'description',
        value: { kind: 'text', text: description },
      },
      {
        key: 'class',
        label: labels.class ?? 'class',
        value: { kind: 'message', key: `runCode.class.${runClass}` },
      },
    ],
    script: { label: labels.script ?? 'script', text: script },
  };
}
