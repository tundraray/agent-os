import { createHash } from 'node:crypto';
import type { BridgeRequest, CodeRunner, FailReason, RequestAnswer, RunOutcome } from '@agent-os/code-runner';
import type { Logger } from '@agent-os/common';
import {
  AGENTS_TOOL_CONFIRMATION,
  RUN_CODE_TOOL,
  type RunCodeArgs,
  RunCodeArgsSchema,
  RunCodeConfirmationContentSchema,
  ToolOutcomeSchema,
} from '@agent-os/contracts';
import { AgentCodeCallsRepository, AgentToolResultsRepository } from '@agent-os/db';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { OwnerDisabledError } from '../../access-gate';
import { AGENTS_CONFIG, CODE_RUNNER, MASK_SECRETS } from '../../agents.tokens';
import type { AgentsConfig, CodeRunConfig } from '../../config';
import { CallRecords, interruptedRunOutcome } from '../../store/call-records';
import type { CodeCallScope } from '../code-call';
import { RESULT_NOT_FOUND } from '../large-result';
import type { OutsideAgentTool, OutsideToolInput, ToolCaller, ToolRunResult } from '../tool';
import { callTargetOf, ToolRegistry } from '../tool-registry';
import { ToolRunner } from '../tool-runner';
import { canCallOf } from './can-call';

/** What the texts of a run name: the run settings with its result limit. */
type RunTextSettings = Omit<CodeRunConfig, 'maxConcurrent'>;

/** Every text a run gives the model (design-code-execution.md, «Error handling»): one table. */
export interface RunTexts {
  readonly failures: Readonly<Record<FailReason, string>>;
  readonly perUserLimit: string;
  readonly twiceInterrupted: string;
  readonly resultNotFound: string;
}

/** The text of a `write` run whose decided request has no readable list (DC-16). */
const NO_CONFIRMED_LIST = 'the decided request has no list of tools the script may call';

export function runTexts(settings: RunTextSettings): RunTexts {
  return {
    failures: {
      syntax: 'syntax error',
      exception: 'exception',
      timeout: `time limit exceeded (${settings.timeoutMs / 1000} s)`,
      memory: `memory limit exceeded (${settings.memoryMb} MB)`,
      result_too_large: `the result is larger than the limit (${settings.resultMaxBytes} bytes)`,
      result_not_json: 'the result cannot be converted to JSON',
      call_limit: `tool call limit exceeded (${settings.maxToolCalls})`,
      protocol: 'the executor broke the protocol',
      crashed: 'the executor process crashed',
      handler_failed: 'platform failure while handling a call from the script',
      busy: 'the code executor is busy',
      aborted: 'the run was interrupted',
    },
    perUserLimit: `concurrent run limit exceeded (${settings.maxConcurrentPerUser})`,
    twiceInterrupted: 'the run was interrupted by a restart twice',
    resultNotFound: RESULT_NOT_FOUND,
  };
}

type DoneResult = Extract<ToolRunResult, { kind: 'done' }>;

function failure(text: string): DoneResult {
  return { kind: 'done', outcome: 'tool_error', text, output: null };
}

/** Reasons whose run carries the script's own message, which the model needs to fix the script. */
const DETAILED_REASONS: ReadonlySet<FailReason> = new Set(['syntax', 'exception']);

function failureText(outcome: Extract<RunOutcome, { status: 'failed' }>, texts: RunTexts): string {
  const message = DETAILED_REASONS.has(outcome.reason) ? outcome.text : null;
  const detail = message === null || message === '' ? '' : `: ${message}`;
  const line = outcome.line === null ? '' : `; line ${outcome.line}`;
  return `${texts.failures[outcome.reason]}${detail}${line}`;
}

const NOT_JSON = Symbol('not JSON');

function parseResult(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return NOT_JSON;
  }
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && value !== null && Object.keys(value).length === 0;
}

/**
 * The run's end as the model gets it (DC-2): a string as it is; `undefined`, `null` or an empty
 * string — `empty` with no text; an empty array or object — `empty` with `[]` or `{}`; any other value
 * — `success` with its JSON. A failed run is `tool_error` `reason; line N` (DC-13, «Error
 * handling»); only a successful run keeps its output (DC-14).
 */
export function outcomeOfRun(outcome: RunOutcome, texts: RunTexts): DoneResult {
  if (outcome.status === 'failed') return failure(failureText(outcome, texts));
  const { output } = outcome;
  if (outcome.value === null) return { kind: 'done', outcome: 'empty', text: '', output };
  const value = parseResult(outcome.value);
  // The executor is not trusted: a result that is not JSON is a broken protocol.
  if (value === NOT_JSON) return failure(texts.failures.protocol);
  if (value === null || value === '') return { kind: 'done', outcome: 'empty', text: '', output };
  if (typeof value === 'string') return { kind: 'done', outcome: 'success', text: value, output };
  if (isEmptyContainer(value)) return { kind: 'done', outcome: 'empty', text: outcome.value, output };
  return { kind: 'done', outcome: 'success', text: outcome.value, output };
}

export type ConfirmedNames =
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly text: string };

/**
 * The tool names a confirmed `write` run may call: only the «Может вызвать» list of the decided
 * request (KD-10, DC-16). A request without a readable list gives no names, and the run does not start.
 */
export function confirmedNamesOf(confirmed: unknown): ConfirmedNames {
  const parsed = RunCodeConfirmationContentSchema.safeParse(confirmed);
  return parsed.success
    ? { ok: true, names: parsed.data.canCall.map((entry) => entry.name) }
    : { ok: false, text: NO_CONFIRMED_LIST };
}

export interface RunCodeDeps {
  readonly codeRunner: CodeRunner;
  /** The attempts of a read run, the audit rows of the calls a script makes and the results it reads. */
  readonly callRecords: CallRecords;
  readonly codeCallRows: AgentCodeCallsRepository;
  readonly toolResultRows: AgentToolResultsRepository;
  /** The MCP tools a run checks its calls against and the names a script never calls. */
  readonly registry: Pick<ToolRegistry, 'declaredMcpTools' | 'toolNames'>;
  readonly runner: Pick<ToolRunner, 'callFromCode'>;
  readonly codeRun: CodeRunConfig;
  /**
   * The logger's redaction by value over the settings' secrets (FR-11): applied to a run's output and
   * result text before they are stored or given to the model; never to what the script itself gets.
   */
  readonly maskSecrets: (text: string) => string;
}

const DESCRIPTION = [
  'Runs a short JavaScript script and returns only its result to you. Use it to filter, count, join or page',
  'through tool results instead of reading them yourself. The script is the body of an async function:',
  'top-level `await` and `return` work; the returned value is your result. The script has no network, files,',
  'timers, modules or `Intl`. It has exactly these functions:',
  '- `callTool(name, args)` calls an MCP tool under the same name and with the same arguments as in your tool',
  '  list (`mcp__<server>__<tool>`) and resolves with its full answer; a refusal or a tool error rejects with',
  "  an error that has `outcome`, `reason` and `text`; the text of a tool error is empty, not the server's.",
  '  When the server sent `structuredContent`, `callTool` resolves with it, and the description of the tool',
  '  shows its structure.',
  '- `readResult(callId)` resolves with the full result of an earlier direct tool call of yours that came to you',
  '  as a stored result, by the `callId` the stored result names.',
  '- `console.log`, `console.info`, `console.warn`, `console.error` write to the script output, which the',
  '  employee sees and you do not.',
  'Class `read` runs at once and may call only tools marked read-only; class `write` waits for one decision',
  'of the employee, who sees the script and the tools it names, and may call only the tools named literally',
  'in the script.',
].join('\n');

/** A run the step can no longer write: the runtime fences its commit too, so nothing is stored (Flow 4). */
function interrupted(texts: RunTexts): DoneResult {
  return failure(texts.failures.aborted);
}

/**
 * The places of employees' runs in this API process (KD-11): taken right before the run, freed when
 * it ends. Each API process keeps its own count.
 */
function createSeats(maxPerOwner: number) {
  const taken = new Map<string, number>();
  return {
    /** A release function, or `undefined` when the owner has no free place. */
    take(ownerId: string): (() => void) | undefined {
      const count = taken.get(ownerId) ?? 0;
      if (count >= maxPerOwner) return undefined;
      taken.set(ownerId, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (taken.get(ownerId) ?? 1) - 1;
        if (left === 0) taken.delete(ownerId);
        else taken.set(ownerId, left);
      };
    },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** One run: what the requests of its script are checked against and written with. */
interface RunScope {
  readonly caller: ToolCaller;
  readonly callId: string;
  readonly runArgs: RunCodeArgs;
  readonly attempt: number;
  readonly codeScope: CodeCallScope;
  readonly guard: OutsideToolInput<RunCodeArgs>['guard'];
  readonly logger: Logger;
}

/**
 * `run_code` (design-code-execution.md, Contract «Инструмент `run_code`»; KD-3, KD-6, KD-7, KD-10,
 * KD-11): runs the model's script through `CodeRunner` on behalf of the owner. Every tool call of the
 * script gets its audit row through the step's `guard` before it reaches its server.
 */
function createRunCodeTool(deps: RunCodeDeps): OutsideAgentTool<RunCodeArgs> {
  const texts = runTexts(deps.codeRun);
  const seats = createSeats(deps.codeRun.maxConcurrentPerUser);

  /** What a run stores and gives the model, with the settings' secrets masked (FR-11, AC-11.1). */
  function maskResult(result: DoneResult): DoneResult {
    const text = deps.maskSecrets(result.text);
    return typeof result.output === 'string'
      ? { ...result, text, output: deps.maskSecrets(result.output) }
      : { ...result, text };
  }

  /** A script's tool call: counted, written open through `guard`, run by `callFromCode`, closed. */
  async function answerCall(
    run: RunScope,
    request: Extract<BridgeRequest, { op: 'call' }>,
    seq: number,
    runSignal: AbortSignal,
  ): Promise<RequestAnswer | 'fenced'> {
    if (seq > deps.codeRun.maxToolCalls) {
      run.logger.warn('code run reached its tool-call limit', { seq, maxToolCalls: deps.codeRun.maxToolCalls });
      return { kind: 'finish', reason: 'call_limit' };
    }
    const target = callTargetOf(run.codeScope.snapshot, request.name);
    const key = { taskId: run.caller.agentId, runCallId: run.callId, attempt: run.attempt, seq };
    const opened = await run.guard(() =>
      deps.codeCallRows.open({ ...key, ...target, args: request.args }),
    );
    if (opened.outcome === 'fenced') {
      run.logger.warn('code call not sent: its audit row was fenced', { seq, ...target });
      return 'fenced';
    }

    const signal = AbortSignal.any([run.codeScope.signal, runSignal]);
    const execution = await deps.runner
      .callFromCode(
        { name: request.name, args: request.args },
        { ...run.codeScope, signal, logger: run.logger.child({ attempt: run.attempt, seq }) },
      )
      .catch(async (error: unknown) => {
        // The gate refused a disabled owner before the call started (KD-4): `interrupted` even in a `write`
        // run, never `unknown`. The rejection still ends the run; the agent fails at its next model call.
        if (error instanceof OwnerDisabledError) {
          await deps.codeCallRows.close(key, {
            outcome: ToolOutcomeSchema.enum.interrupted,
            finishedAt: new Date(),
          });
        }
        throw error;
      });
    if (execution.kind === 'aborted') {
      // A record that the call was cancelled, not a new action: its own transaction, no `guard` (Flow 4).
      await deps.codeCallRows.close(key, {
        outcome: interruptedRunOutcome(run.runArgs),
        finishedAt: new Date(),
      });
      return { kind: 'finish', reason: 'aborted' };
    }
    if (execution.kind === 'refused') {
      await deps.codeCallRows.close(key, {
        outcome: 'refused',
        refusalReason: execution.reason,
        finishedAt: new Date(),
      });
      return {
        kind: 'error',
        error: { outcome: 'refused', reason: execution.reason, text: execution.text },
      };
    }
    await deps.codeCallRows.close(key, { outcome: execution.outcome, finishedAt: new Date() });
    if (execution.outcome === 'success' || execution.outcome === 'empty') {
      return { kind: 'value', value: execution.fullResult?.value ?? null };
    }
    return {
      kind: 'error',
      error: { outcome: execution.outcome, reason: execution.failureReason ?? null, text: execution.text },
    };
  }

  /** A script's `readResult`: only a result of the run's own session and owner (AC-04.3). */
  async function answerRead(
    run: RunScope,
    request: Extract<BridgeRequest, { op: 'read' }>,
  ): Promise<RequestAnswer> {
    const found = await deps.toolResultRows.findForRun({
      callId: request.resultId,
      taskId: run.caller.agentId,
      ownerId: run.caller.ownerId,
    });
    run.logger.debug('code run read a full result', { resultId: request.resultId, found: found !== undefined });
    return found === undefined
      ? { kind: 'error', error: { outcome: 'not_found', reason: null, text: texts.resultNotFound } }
      : { kind: 'value', value: found.value };
  }

  /** Starts the run and turns its end into the tool's result. */
  async function runScript(run: RunScope, input: OutsideToolInput<RunCodeArgs>): Promise<ToolRunResult> {
    const startedAt = Date.now();
    let calls = 0;
    let fenced = false;
    run.logger.info('code run started', {
      runClass: run.runArgs.class,
      confirmed: run.runArgs.class === 'write',
      scriptSha256: sha256(run.runArgs.script),
      attempt: run.attempt,
      description: run.runArgs.description,
    });
    const outcome = await deps.codeRunner.run({
      script: run.runArgs.script,
      limits: {
        timeoutMs: deps.codeRun.timeoutMs,
        memoryMb: deps.codeRun.memoryMb,
        resultMaxBytes: deps.codeRun.resultMaxBytes,
      },
      onRequest: async (request, runSignal) => {
        if (request.op === 'read') return answerRead(run, request);
        calls += 1;
        const answer = await answerCall(run, request, calls, runSignal);
        if (answer !== 'fenced') return answer;
        fenced = true;
        return { kind: 'finish', reason: 'aborted' };
      },
      signal: input.signal,
      logger: run.logger,
    });

    const result = maskResult(fenced ? interrupted(texts) : outcomeOfRun(outcome, texts));
    if (outcome.output !== '') run.logger.info('code run output', { output: deps.maskSecrets(outcome.output) });
    run.logger.info('code run ended', {
      status: outcome.status,
      outcome: result.outcome,
      reason: outcome.status === 'failed' ? outcome.reason : null,
      line: outcome.status === 'failed' ? outcome.line : null,
      calls,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  /** The attempt of a run: 1 for `write` (it has no `run_attempt` record); for `read`, recorded through `guard` (KD-7). */
  async function attemptOf(input: OutsideToolInput<RunCodeArgs>, logger: Logger): Promise<number | DoneResult> {
    if (input.args.class === 'write') return 1;
    const bumped = await input.guard(() =>
      deps.callRecords.startAttempt({ taskId: input.caller.agentId, callId: input.callId }, input.args),
    );
    if (bumped.outcome === 'fenced') {
      logger.warn('code run not started: its attempt was fenced');
      return interrupted(texts);
    }
    if (bumped.value === null) {
      logger.warn('code run not started: it was lost to a restart twice');
      return failure(texts.twiceInterrupted);
    }
    if (bumped.value > 1) logger.warn('code run re-executed after a lost step', { attempt: bumped.value });
    return bumped.value;
  }

  return {
    name: RUN_CODE_TOOL,
    mode: 'outside',
    description: DESCRIPTION,
    argsSchema: RunCodeArgsSchema,
    confirmation: {
      kind: AGENTS_TOOL_CONFIRMATION,
      required: (args) => args.class === 'write',
      editableArgs: false,
      content: (args, tools) => ({ canCall: canCallOf(args.script, tools) }),
    },

    async execute(input) {
      const { args, caller, callId } = input;
      const logger = input.logger.child({ runId: callId });

      let confirmedNames: readonly string[] | undefined;
      if (args.class === 'write') {
        const confirmed = confirmedNamesOf(input.confirmed);
        if (!confirmed.ok) {
          logger.warn('code run not started: the decided request has no readable list');
          return failure(confirmed.text);
        }
        confirmedNames = confirmed.names;
      }

      const release = seats.take(caller.ownerId);
      if (release === undefined) {
        logger.warn('code run refused: the employee has no free run place', {
          maxConcurrentPerUser: deps.codeRun.maxConcurrentPerUser,
        });
        return failure(texts.perUserLimit);
      }
      try {
        const attempt = await attemptOf(input, logger);
        if (typeof attempt !== 'number') return attempt;
        const { registry } = deps;
        // The servers the caller declares from its snapshot, not the library's record now (ADR-0011, ADR-0017).
        const snapshot = await registry.declaredMcpTools(caller.servers);
        return await runScript(
          {
            caller,
            callId,
            runArgs: args,
            attempt,
            guard: input.guard,
            logger,
            codeScope: {
              caller,
              snapshot,
              runClass: args.class,
              ...(confirmedNames === undefined ? {} : { confirmedNames }),
              agentToolNames: registry.toolNames(),
              callId,
              signal: input.signal,
              logger,
            },
          },
          input,
        );
      } finally {
        release();
      }
    },
  };
}

/**
 * Builds `run_code` and hands it to the tools library when the module starts: the tool reads the registry, so
 * the registry gets it through `useRunCode` rather than its constructor (no provider cycle).
 */
@Injectable()
export class RunCodeTool implements OnModuleInit {
  constructor(
    @Inject(CODE_RUNNER) private readonly codeRunner: CodeRunner,
    @Inject(CallRecords) private readonly callRecords: CallRecords,
    @Inject(AgentCodeCallsRepository) private readonly codeCallRows: AgentCodeCallsRepository,
    @Inject(AgentToolResultsRepository) private readonly toolResultRows: AgentToolResultsRepository,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(ToolRunner) private readonly runner: ToolRunner,
    @Inject(AGENTS_CONFIG) private readonly config: Pick<AgentsConfig, 'codeRun'>,
    @Inject(MASK_SECRETS) private readonly maskSecrets: (text: string) => string,
  ) {}

  onModuleInit(): void {
    this.registry.useRunCode(
      createRunCodeTool({
        codeRunner: this.codeRunner,
        callRecords: this.callRecords,
        codeCallRows: this.codeCallRows,
        toolResultRows: this.toolResultRows,
        registry: this.registry,
        runner: this.runner,
        codeRun: this.config.codeRun,
        maskSecrets: this.maskSecrets,
      }),
    );
  }
}
