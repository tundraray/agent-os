import { createHash } from 'node:crypto';
import type {
  BridgeRequest,
  CodeRunner,
  FailReason,
  RequestAnswer,
  RunOutcome,
} from '@agent-os/code-runner';
import type { Logger } from '@agent-os/common';
import {
  AGENTS_TOOL_CONFIRMATION,
  RUN_CODE_TOOL,
  type RunCodeArgs,
  RunCodeArgsSchema,
  RunCodeConfirmationContentSchema,
  ToolOutcomeSchema,
} from '@agent-os/contracts';
import { CodeCallsRepository, ToolResultsRepository } from '@agent-os/db';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { OwnerDisabledError } from '../../access-gate';
import { AGENTS_CONFIG, CODE_RUNNER, MASK_SECRETS } from '../../agents.tokens';
import type { AgentsConfig, CodeRunConfig } from '../../config';
import { CallRecords } from '../../store/call-records';
import type { CodeCallScope } from '../code-call';
import { RESULT_NOT_FOUND } from '../large-result';
import type {
  OutsideAgentTool,
  OutsideToolInput,
  ToolCaller,
  ToolRunResult,
} from '../tool';
import { callTargetOf, ToolRegistry } from '../tool-registry';
import { ToolRunner } from '../tool-runner';
import { canCallOf } from './can-call';
import { createScriptTool } from './script-tool';

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
const NO_CONFIRMED_LIST =
  'the decided request has no list of tools the script may call';

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
const DETAILED_REASONS: ReadonlySet<FailReason> = new Set([
  'syntax',
  'exception',
]);

function failureText(
  outcome: Extract<RunOutcome, { status: 'failed' }>,
  texts: RunTexts,
): string {
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
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 0
  );
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
  if (outcome.value === null)
    return { kind: 'done', outcome: 'empty', text: '', output };
  const value = parseResult(outcome.value);
  // The executor is not trusted: a result that is not JSON is a broken protocol.
  if (value === NOT_JSON) return failure(texts.failures.protocol);
  if (value === null || value === '')
    return { kind: 'done', outcome: 'empty', text: '', output };
  if (typeof value === 'string')
    return { kind: 'done', outcome: 'success', text: value, output };
  if (isEmptyContainer(value))
    return { kind: 'done', outcome: 'empty', text: outcome.value, output };
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
  readonly codeCallRows: CodeCallsRepository;
  readonly toolResultRows: ToolResultsRepository;
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

/** What one code run executes: `run_code`'s script, a saved script or a draft (self-learning scripts KD-5). */
export interface CodeRunRequest {
  readonly code: string;
  readonly runClass: RunCodeArgs['class'];
  /** The script's global `input`: `null` for `run_code`. */
  readonly input: unknown;
  readonly description: string;
  /** The saved script's name; `null` for `run_code`. */
  readonly scriptName: string | null;
}

/** The one path of a code run; every entry (`run_code`, a script tool) calls the same instance. */
export type CodeRun = (
  request: CodeRunRequest,
  call: OutsideToolInput<unknown>,
) => Promise<ToolRunResult>;

/** One run: what the requests of its script are checked against and written with. */
interface RunScope {
  readonly caller: ToolCaller;
  readonly callId: string;
  readonly attempt: number;
  readonly codeScope: CodeCallScope;
  readonly guard: OutsideToolInput<unknown>['guard'];
  readonly logger: Logger;
}

/**
 * The code run (design-code-execution.md, Contract «Инструмент `run_code`»; KD-3, KD-6, KD-7, KD-10,
 * KD-11): runs a script through `CodeRunner` on behalf of the owner, with one set of the employees'
 * run places for every entry. Every tool call of the script gets its audit row through the step's
 * `guard` before it reaches its server.
 */
function createCodeRun(deps: RunCodeDeps): CodeRun {
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
      run.logger.warn('code run reached its tool-call limit', {
        seq,
        maxToolCalls: deps.codeRun.maxToolCalls,
      });
      return { kind: 'finish', reason: 'call_limit' };
    }
    const target = callTargetOf(run.codeScope.snapshot, request.name);
    const key = {
      taskId: run.caller.agentId,
      runCallId: run.callId,
      attempt: run.attempt,
      seq,
    };
    const opened = await run.guard(() =>
      deps.codeCallRows.open({ ...key, ...target, args: request.args }),
    );
    if (opened.outcome === 'fenced') {
      run.logger.warn('code call not sent: its audit row was fenced', {
        seq,
        ...target,
      });
      return 'fenced';
    }

    const signal = AbortSignal.any([run.codeScope.signal, runSignal]);
    const execution = await deps.runner
      .callFromCode(
        { name: request.name, args: request.args },
        {
          ...run.codeScope,
          signal,
          logger: run.logger.child({ attempt: run.attempt, seq }),
        },
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
        outcome:
          run.codeScope.runClass === 'write'
            ? ToolOutcomeSchema.enum.unknown
            : ToolOutcomeSchema.enum.interrupted,
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
        error: {
          outcome: 'refused',
          reason: execution.reason,
          text: execution.text,
        },
      };
    }
    await deps.codeCallRows.close(key, {
      outcome: execution.outcome,
      finishedAt: new Date(),
    });
    if (execution.outcome === 'success' || execution.outcome === 'empty') {
      return { kind: 'value', value: execution.fullResult?.value ?? null };
    }
    return {
      kind: 'error',
      error: {
        outcome: execution.outcome,
        reason: execution.failureReason ?? null,
        text: execution.text,
      },
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
    run.logger.debug('code run read a full result', {
      resultId: request.resultId,
      found: found !== undefined,
    });
    return found === undefined
      ? {
          kind: 'error',
          error: {
            outcome: 'not_found',
            reason: null,
            text: texts.resultNotFound,
          },
        }
      : { kind: 'value', value: found.value };
  }

  /** Starts the run and turns its end into the tool's result. */
  async function runScript(
    run: RunScope,
    request: CodeRunRequest,
    signal: AbortSignal,
  ): Promise<ToolRunResult> {
    const startedAt = Date.now();
    let calls = 0;
    let fenced = false;
    // The tools whose calls a training tree recorded and did not send, in call order (design-training.md).
    const recorded: string[] = [];
    run.logger.info('code run started', {
      runClass: request.runClass,
      confirmed: request.runClass === 'write',
      scriptSha256: sha256(request.code),
      scriptName: request.scriptName,
      versionNumber: run.caller.run.version.number,
      attempt: run.attempt,
      description: request.description,
    });
    const outcome = await deps.codeRunner.run({
      script: request.code,
      input: request.input,
      limits: {
        timeoutMs: deps.codeRun.timeoutMs,
        memoryMb: deps.codeRun.memoryMb,
        resultMaxBytes: deps.codeRun.resultMaxBytes,
      },
      onRequest: async (request, runSignal) => {
        if (request.op === 'read') return answerRead(run, request);
        calls += 1;
        const answer = await answerCall(run, request, calls, runSignal);
        if (answer === 'fenced') {
          fenced = true;
          return { kind: 'finish', reason: 'aborted' };
        }
        if (answer.kind === 'error' && answer.error.outcome === 'recorded')
          recorded.push(request.name);
        return answer;
      },
      signal,
      logger: run.logger,
    });

    const result = maskResult(
      fenced ? interrupted(texts) : outcomeOfRun(outcome, texts),
    );
    if (outcome.output !== '')
      run.logger.info('code run output', {
        output: deps.maskSecrets(outcome.output),
      });
    run.logger.info('code run ended', {
      status: outcome.status,
      outcome: result.outcome,
      reason: outcome.status === 'failed' ? outcome.reason : null,
      line: outcome.status === 'failed' ? outcome.line : null,
      calls,
      durationMs: Date.now() - startedAt,
    });
    return recorded.length === 0 ? result : { ...result, recorded };
  }

  /** The attempt of a run: 1 for `write` (it has no `run_attempt` record); for `read`, recorded through `guard` (KD-7). */
  async function attemptOf(
    runClass: RunCodeArgs['class'],
    call: OutsideToolInput<unknown>,
    logger: Logger,
  ): Promise<number | DoneResult> {
    if (runClass === 'write') return 1;
    const bumped = await call.guard(() =>
      deps.callRecords.startAttempt({
        taskId: call.caller.agentId,
        callId: call.callId,
      }),
    );
    if (bumped.outcome === 'fenced') {
      logger.warn('code run not started: its attempt was fenced');
      return interrupted(texts);
    }
    if (bumped.value === null) {
      logger.warn('code run not started: it was lost to a restart twice');
      return failure(texts.twiceInterrupted);
    }
    if (bumped.value > 1)
      logger.warn('code run re-executed after a lost step', {
        attempt: bumped.value,
      });
    return bumped.value;
  }

  return async (request, call) => {
    const { caller, callId } = call;
    const logger = call.logger.child({ runId: callId });
    // A `write` run starts only with the list of its decided request (DC-16); a `read` run has none.
    let confirmedNames: readonly string[] | undefined;
    if (request.runClass === 'write') {
      const confirmed = confirmedNamesOf(call.confirmed);
      if (!confirmed.ok) {
        logger.warn(
          'code run not started: the decided request has no readable list',
        );
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
      const attempt = await attemptOf(request.runClass, call, logger);
      if (typeof attempt !== 'number') return attempt;
      const { registry } = deps;
      // The servers the caller declares from its snapshot, not the library's record now (ADR-0011, ADR-0017).
      const snapshot = await registry.declaredMcpTools(caller.servers);
      return await runScript(
        {
          caller,
          callId,
          attempt,
          guard: call.guard,
          logger,
          codeScope: {
            caller,
            snapshot,
            runClass: request.runClass,
            ...(confirmedNames === undefined ? {} : { confirmedNames }),
            agentToolNames: registry.toolNames(),
            callId,
            signal: call.signal,
            logger,
          },
        },
        request,
        call.signal,
      );
    } finally {
      release();
    }
  };
}

/** `run_code`: the model's own script, a thin entry into the code run. */
function createRunCodeTool(codeRun: CodeRun): OutsideAgentTool<RunCodeArgs> {
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

    execute(input) {
      const { args } = input;
      return codeRun(
        {
          code: args.script,
          runClass: args.class,
          input: null,
          description: args.description,
          scriptName: null,
        },
        input,
      );
    },
  };
}

/**
 * Builds the one code run, with one set of run places, and hands the tools library `run_code` and the builder
 * of a script's tool over it when the module starts: the run reads the registry, so the registry gets them
 * through `useCodeRun` rather than its constructor (no provider cycle).
 */
@Injectable()
export class RunCodeTool implements OnModuleInit {
  private codeRun: CodeRun | undefined;

  constructor(
    @Inject(CODE_RUNNER) private readonly codeRunner: CodeRunner,
    @Inject(CallRecords) private readonly callRecords: CallRecords,
    @Inject(CodeCallsRepository)
    private readonly codeCallRows: CodeCallsRepository,
    @Inject(ToolResultsRepository)
    private readonly toolResultRows: ToolResultsRepository,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(ToolRunner) private readonly runner: ToolRunner,
    @Inject(AGENTS_CONFIG)
    private readonly config: Pick<AgentsConfig, 'codeRun'>,
    @Inject(MASK_SECRETS)
    private readonly maskSecrets: (text: string) => string,
  ) {}

  onModuleInit(): void {
    const codeRun = createCodeRun({
      codeRunner: this.codeRunner,
      callRecords: this.callRecords,
      codeCallRows: this.codeCallRows,
      toolResultRows: this.toolResultRows,
      registry: this.registry,
      runner: this.runner,
      codeRun: this.config.codeRun,
      maskSecrets: this.maskSecrets,
    });
    this.codeRun = codeRun;
    this.registry.useCodeRun(createRunCodeTool(codeRun), (script) =>
      createScriptTool(script, codeRun),
    );
  }

  /** The same code run `run_code` and the scripts use, for the trainer's `try_script`: one set of run places. */
  run(
    request: CodeRunRequest,
    call: OutsideToolInput<unknown>,
  ): Promise<ToolRunResult> {
    if (this.codeRun === undefined)
      throw new Error('The code run is used before RunCodeTool started');
    return this.codeRun(request, call);
  }
}
