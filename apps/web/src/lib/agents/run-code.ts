import {
  isCodeRunCall,
  RUN_CODE_TOOL,
  RunCodeArgsSchema,
  scriptNameOf,
  ScriptToolArgsSchema,
  TRY_SCRIPT_TOOL,
  TryScriptArgsSchema,
  type RunCodeArgs,
} from '@agent-os/contracts';
import { builtinToolLabels } from '@/i18n/builtin-name';
import type { Messages } from '@/i18n/catalog';
import { valueRows, type ValueRow } from '@/lib/agents/value-rows';

/** The run's end when the script returned nothing (code-execution UXRD, KD-5). */
export const NO_RUN_VALUE = '—';

/** A code run as the tool-call block and the decision card show it. */
export type RunCodeView = {
  /** The second header line: a `run_code` description or the draft's name; null for a saved script. */
  description: string | null;
  /** The arguments in the order of the tool's fields, not of the model's keys (KD-2). */
  rows: ValueRow[];
  /** The last row: the code behind «Показать скрипт» (KD-1); absent for a saved script the view does not know. */
  script?: { label: string; text: string };
};

type CodeRunCall = {
  tool: string;
  server: string | null;
  args: unknown;
  scriptCode?: string | null;
};

/**
 * A code run — `run_code`, `try_script` or a saved script — as rows; the labels (MC-2) are the catalogue's, a
 * saved script's those of `try_script`, and the class reads in words (MC-3) from the `agents` messages. Null
 * for any other call and when the arguments do not parse: they are then ordinary rows.
 */
export function runCodeView(
  call: CodeRunCall,
  tools: Messages['tools'],
): RunCodeView | null {
  if (!isCodeRunCall(call.tool, call.server)) return null;
  const savedScript = scriptNameOf(call.tool, call.server) !== null;
  const labels =
    builtinToolLabels(tools, savedScript ? TRY_SCRIPT_TOOL : call.tool)?.args ??
    {};
  const rowsOf = (values: Record<string, unknown>): ValueRow[] =>
    valueRows(values, labels) ?? [];
  const classRow = (runClass: RunCodeArgs['class']): ValueRow => ({
    key: 'class',
    label: labels.class ?? 'class',
    value: { kind: 'message', key: `runCode.class.${runClass}` },
  });
  const code = (key: string, text: string) => ({
    label: labels[key] ?? key,
    text,
  });

  if (call.tool === RUN_CODE_TOOL) {
    const parsed = RunCodeArgsSchema.safeParse(call.args);
    if (!parsed.success) return null;
    const { description, class: runClass, script } = parsed.data;
    return {
      description,
      rows: [...rowsOf({ description }), classRow(runClass)],
      script: code('script', script),
    };
  }
  if (call.tool === TRY_SCRIPT_TOOL) {
    const parsed = TryScriptArgsSchema.safeParse(call.args);
    if (!parsed.success) return null;
    const { name, class: runClass, owner, input } = parsed.data;
    return {
      description: name,
      rows: [
        ...rowsOf({ name }),
        classRow(runClass),
        ...rowsOf({ owner, input }),
      ],
      script: code('code', parsed.data.code),
    };
  }
  const parsed = ScriptToolArgsSchema.safeParse(call.args);
  if (!parsed.success) return null;
  const { input } = parsed.data;
  return {
    description: null,
    rows: input === undefined ? [] : (valueRows(input) ?? rowsOf({ input })),
    script: call.scriptCode == null ? undefined : code('code', call.scriptCode),
  };
}
