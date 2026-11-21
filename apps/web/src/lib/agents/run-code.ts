import { RUN_CODE_TOOL, RunCodeArgsSchema, type RunCodeArgs } from "@agent-os/contracts";
import type { ValueRow } from "@/lib/agents/value-rows";

/** code-execution UXRD, MC-4: the caption of the script output under the run's end. */
export const SCRIPT_OUTPUT_LABEL = "Вывод скрипта";

/** The run's end when the script returned nothing (code-execution UXRD, KD-5). */
export const NO_RUN_VALUE = "—";

/** code-execution UXRD, MC-3: the run class in words. */
const CLASS_TEXT: Record<RunCodeArgs["class"], string> = {
  read: "читающий",
  write: "изменяющий: может менять данные во внешних системах",
};

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
 * (`builtinToolLabels`). Null when the arguments do not pass `RunCodeArgsSchema`: they are then ordinary rows.
 */
export function runCodeView(args: unknown, labels: Readonly<Record<string, string>> = {}): RunCodeView | null {
  const parsed = RunCodeArgsSchema.safeParse(args);
  if (!parsed.success) return null;
  const { description, class: runClass, script } = parsed.data;
  const row = (key: string, text: string): ValueRow => ({
    key,
    label: labels[key] ?? key,
    value: { text, json: false },
  });
  return {
    description,
    rows: [row("description", description), row("class", CLASS_TEXT[runClass])],
    script: { label: labels.script ?? "script", text: script },
  };
}
