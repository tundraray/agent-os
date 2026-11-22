import type { Runtime } from '@agent-os/runtime';

import { envelope } from '../model/provider-messages';
import { utf8Bytes } from '../model/token-estimate';
import { codeCalls } from '../store/code-calls.repository';
import { history } from '../store/history.repository';
import type { StoreReader } from '../store/sessions.repository';
import { descendantsOf } from '../tools/builtin/list-agents';
import type { RoundCall, RoundCallOutcome } from './check-operations';
import type { KnowledgeRun } from './knowledge-runs.repository';

/*
 * The input of an extraction round (design-core.md, Contract «Вход извлечения», KD-3): the MCP calls
 * of the deep agent's subtree that finished after the run's extracted-up-to mark and not later than
 * the read, cut to the sizes below. It only reads; it neither calls a model nor writes the graph,
 * and it logs nothing — the caller logs the counts, never the text.
 */

/** A call's result text in the input is cut to this many UTF-8 bytes. */
const EXTRACTION_RESULT_BYTES = 2_000;
/** A call's arguments (as JSON) in the input are cut to this many UTF-8 bytes. */
const EXTRACTION_ARGS_BYTES = 500;
/** Calls past this many UTF-8 bytes of input give only tool, arguments and outcome, without result. */
const EXTRACTION_INPUT_BYTES = 48_000;

/** The only outcomes taken: refused, rejected, interrupted and the other outcomes are left out (F12). */
const ROUND_OUTCOMES: readonly RoundCallOutcome[] = ['success', 'empty', 'tool_error'];

const ENVELOPE_SOURCE = 'tool calls';
const ENVELOPE_AUTHOR = 'this run of the deep agent';

/** What the round knows of its run: the row of `agent_knowledge_runs` with the deep agent's owner. */
export type ExtractionRun = Pick<KnowledgeRun, 'runId' | 'ownerId' | 'extractedUpTo'>;

export interface ExtractionInputDeps {
  readonly database: StoreReader;
  readonly tasks: Pick<Runtime['tasks'], 'get' | 'listTree'>;
}

/** What is told to the log about the input: numbers only. */
export interface ExtractionInputCounts {
  /** Calls in the input, both kinds. */
  readonly calls: number;
  /** Of them, calls made inside `run_code`. */
  readonly codeCalls: number;
  /** UTF-8 bytes of the input text, envelope included. */
  readonly bytes: number;
  /** Results cut to `EXTRACTION_RESULT_BYTES`. */
  readonly cutResults: number;
  /** Arguments cut to `EXTRACTION_ARGS_BYTES`. */
  readonly cutArgs: number;
  /** Direct calls whose result was left out past `EXTRACTION_INPUT_BYTES`. */
  readonly withoutResult: number;
}

export interface ExtractionInput {
  /** The calls as data in the envelope, numbered `c1…` by end time. */
  readonly text: string;
  /** `c…` → the call, as `checkOperations` takes it. */
  readonly calls: ReadonlyMap<string, RoundCall>;
  /** The upper bound of the window: a successful round moves the mark to it. */
  readonly readAt: Date;
  readonly counts: ExtractionInputCounts;
}

/** One call read from either source, before it is numbered and written as text. */
interface InputCall {
  readonly server: string;
  readonly tool: string;
  readonly outcome: RoundCallOutcome;
  readonly args: unknown;
  /** `null` for a call inside `run_code`: its result is not stored. */
  readonly resultText: string | null;
  readonly inCode: boolean;
  readonly finishedAt: Date;
}

interface CutText {
  readonly text: string;
  readonly cut: boolean;
}

/** Cuts a text to `maxBytes` of UTF-8 on a character boundary and says how much was cut. */
function cutToBytes(text: string, maxBytes: number): CutText {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, cut: false };
  let cut = maxBytes;
  // A UTF-8 continuation byte (10xxxxxx) is the middle of a character: step back to its first byte.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return {
    text: `${bytes.subarray(0, cut).toString('utf8')}\n[cut: ${bytes.length - cut} more bytes]`,
    cut: true,
  };
}

/**
 * The tasks whose calls the round may read: the deep agent and its descendants in its own tree and
 * of its owner — never sibling runs of the same conversation, another tree or another owner.
 */
async function subtreeTaskIds(deps: ExtractionInputDeps, run: ExtractionRun): Promise<string[]> {
  const deepAgent = await deps.tasks.get(run.runId, run.ownerId);
  const tree = await deps.tasks.listTree(deepAgent.rootId, run.ownerId);
  return [run.runId, ...descendantsOf(tree, run.runId).map((task) => task.taskId)];
}

/** The head of a call: number, server, tool, outcome and the cut arguments. */
function callHead(key: string, call: InputCall, args: string): string {
  const where = call.inCode ? ' (inside run_code; its result is not stored)' : '';
  return `${key} server=${call.server} tool=${call.tool} outcome=${call.outcome}${where}\nargs: ${args}`;
}

/** Numbers the calls by end time and writes them, the results only while the input fits its limit. */
function writeInput(ordered: readonly InputCall[]): Omit<ExtractionInput, 'readAt'> {
  const calls = new Map<string, RoundCall>();
  const blocks: string[] = [];
  let dataBytes = 0;
  let overLimit = false;
  let cutResults = 0;
  let cutArgs = 0;
  let withoutResult = 0;
  ordered.forEach((call, index) => {
    const key = `c${index + 1}`;
    calls.set(key, { server: call.server, tool: call.tool, outcome: call.outcome });
    const args = cutToBytes(JSON.stringify(call.args), EXTRACTION_ARGS_BYTES);
    if (args.cut) cutArgs += 1;
    const head = callHead(key, call, args.text);
    let block = head;
    if (call.resultText !== null) {
      const result = cutToBytes(call.resultText, EXTRACTION_RESULT_BYTES);
      const full = `${head}\nresult:\n${result.text}`;
      overLimit ||= dataBytes + utf8Bytes(full) > EXTRACTION_INPUT_BYTES;
      if (overLimit) {
        block = `${head}\nresult: left out, the input limit is reached`;
        withoutResult += 1;
      } else {
        block = full;
        if (result.cut) cutResults += 1;
      }
    }
    blocks.push(block);
    dataBytes += utf8Bytes(block) + 2;
  });
  const text = envelope(ENVELOPE_SOURCE, ENVELOPE_AUTHOR, blocks.join('\n\n'));
  return {
    text,
    calls,
    counts: {
      calls: ordered.length,
      codeCalls: ordered.filter((call) => call.inCode).length,
      bytes: utf8Bytes(text),
      cutResults,
      cutArgs,
      withoutResult,
    },
  };
}

/**
 * Reads the round's input. `readAt` is taken first, before the tree and the calls are read; a call
 * that finishes later goes to the next round, whose window starts at `readAt` once this round has
 * moved the mark to it. A call that finished by `readAt` but was committed after the read is missed
 * by both rounds — lost, never doubled (design-core.md, Risks).
 */
export async function readExtractionInput(
  deps: ExtractionInputDeps,
  run: ExtractionRun,
): Promise<ExtractionInput> {
  const readAt = new Date();
  const taskIds = await subtreeTaskIds(deps, run);
  // `finished_at` in (`extractedUpTo`, `readAt`]: no lower bound before the first round.
  const window = { after: run.extractedUpTo, through: readAt };
  const results = await history.mcpResults(deps.database, taskIds, ROUND_OUTCOMES, window);
  const direct: InputCall[] = results.map(({ text, ...call }) => ({ ...call, resultText: text, inCode: false }));
  // Calls a `run_code` script made, of its latest attempt only (Invariant 3).
  const scripted = await codeCalls.mcpCallsOfLatestAttempts(deps.database, taskIds, ROUND_OUTCOMES, window);
  const inCode: InputCall[] = scripted.map((call) => ({ ...call, resultText: null, inCode: true }));
  // A stable sort: calls ending at the same moment keep their order within each table.
  const ordered = [...direct, ...inCode].sort(
    (a, b) => a.finishedAt.getTime() - b.finishedAt.getTime(),
  );
  return { ...writeInput(ordered), readAt };
}
