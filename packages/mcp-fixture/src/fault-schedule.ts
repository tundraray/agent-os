import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DatasetVersionSchema } from './versions.js';

const RuleMatchShape = {
  tool: z.string().min(1),
  /** sha256 of the canonical arguments without `cursor` (`argsHash`), or `*` for any arguments. */
  argsHash: z.union([z.literal('*'), z.string().regex(/^[0-9a-f]{64}$/)]),
  /** 1-based occurrence numbers of the (tool, argsHash) call, counted by the call log, or `all`. */
  occurrences: z.union([z.literal('all'), z.array(z.int().min(1)).min(1)]),
};

function rule<Mode extends string, Params extends z.ZodRawShape>(mode: Mode, params: Params) {
  return z.strictObject({ ...RuleMatchShape, mode: z.literal(mode), ...params });
}

/** Modes the transport applies: the request never reaches the server, or its response is replaced by `id`. */
const TRANSPORT_FAULT_RULES = [
  rule('drop_connection', {}),
  rule('crash_process', {}),
  rule('hang', {}),
  rule('late_response', { ms: z.int().min(1) }),
  rule('jsonrpc_error', { code: z.int(), message: z.string().min(1).optional() }),
  rule('malformed_json', {}),
  rule('invalid_result', {}),
] as const;

/** Modes the server applies to the tool result it builds. */
const RESULT_FAULT_RULES = [
  rule('tool_error', { message: z.string().min(1).optional() }),
  rule('tool_error_args', {}),
  rule('contract_violation', {}),
  rule('empty', {}),
  rule('unknown_total', {}),
  rule('page_cap', { records: z.int().min(0) }),
  rule('total_cap', { total: z.int().min(0) }),
  rule('snapshot_flip', { version: DatasetVersionSchema.optional() }),
  rule('oversize', { bytes: z.int().min(1) }),
  rule('delay_ms', { ms: z.int().min(1) }),
  /** Test latch: the call is already in the call log; the server answers only once the file at `path` exists. */
  rule('wait_for_file', { path: z.string().min(1) }),
] as const;

const FaultRulesFileSchema = z.array(z.discriminatedUnion('mode', [...TRANSPORT_FAULT_RULES, ...RESULT_FAULT_RULES]));

export type TransportFaultRule = z.infer<(typeof TRANSPORT_FAULT_RULES)[number]>;
export type ResultFaultRule = z.infer<(typeof RESULT_FAULT_RULES)[number]>;
export type FaultRule = TransportFaultRule | ResultFaultRule;
export type FaultMode = FaultRule['mode'];

const RESULT_MODES: ReadonlySet<FaultMode> = new Set(RESULT_FAULT_RULES.map((option) => option.shape.mode.value));

export function isResultFault(faultRule: FaultRule): faultRule is ResultFaultRule {
  return RESULT_MODES.has(faultRule.mode);
}

/**
 * Fault rules of one fixture process (`FIXTURE_FAULTS`): the first rule whose tool, argument hash and occurrence
 * match a call decides its fault.
 */
export class FaultSchedule {
  private constructor(private readonly rules: readonly FaultRule[]) {}

  /** Reads a JSON array of rules; an unknown field or mode, or a missing parameter, is an error. */
  static fromFile(path: string): FaultSchedule {
    const parsed = FaultRulesFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) {
      throw new Error(`invalid fault rules in ${path}: ${z.prettifyError(parsed.error)}`);
    }
    return new FaultSchedule(parsed.data);
  }

  static empty(): FaultSchedule {
    return new FaultSchedule([]);
  }

  match(call: { tool: string; argsHash: string; occurrence: number }): FaultRule | undefined {
    return this.rules.find(
      (candidate) =>
        candidate.tool === call.tool &&
        (candidate.argsHash === '*' || candidate.argsHash === call.argsHash) &&
        (candidate.occurrences === 'all' || candidate.occurrences.includes(call.occurrence)),
    );
  }
}
