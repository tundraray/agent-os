import type { Logger } from '@agent-os/common';
import {
  AGENTS_TOOL_CONFIRMATION,
  RUN_CODE_TOOL,
  type RunCodeArgs,
  type ToolOutcome,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import type { RuntimeTx, StepContext, StepEffects } from '@agent-os/runtime';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { z } from 'zod';

import {
  type AccessAudit,
  type AccessDeniedEntry,
  type AccessGate,
  OwnerDisabledError,
  type ToolAccess,
  type ToolCallRefusedEntry,
} from '../access-gate';
import type { McpAccounts } from '../mcp/mcp-accounts';
import type { McpCallResponse, McpClient } from '../mcp/mcp-client';
import type { McpFailureReason } from '../mcp/mcp-failure';
import type { McpTool } from '../mcp/mcp-tool';
import { type McpOutcome, scriptValueOf, toOutcome } from '../mcp/mcp-outcome';
import { type Session, sessionInputOf } from '../store/sessions.repository';
import { callRecords } from '../store/call-records.repository';
import type { StoredToolResult, ToolResultSettingsRow } from '../store/tool-results.repository';
import { cutText, maskValue, wrapperText } from './large-result';
import type { InCommitAgentTool, StartChild, ToolCaller, ToolReview } from './tool';
import { callTarget, callTargetOf, loggedArgs, type SessionTool } from './tool-registry';

/** One tool call of a model answer, as the model wrote it. */
export interface RequestedCall {
  readonly callId: string;
  /** The name the model called. */
  readonly toolName: string;
  readonly args: unknown;
}

/** A call that passed `check`: its session tool, its parsed arguments and the calling agent. */
export interface ResolvedCall {
  readonly callId: string;
  readonly tool: SessionTool;
  readonly args: unknown;
  readonly caller: ToolCaller;
}

/** A call of a tool that runs in the commit transaction of the step. */
export type InCommitCall = ResolvedCall & {
  readonly tool: { readonly kind: 'agent'; readonly tool: InCommitAgentTool<unknown> };
};

export function isInCommit(call: ResolvedCall): call is InCommitCall {
  return call.tool.kind === 'agent' && call.tool.tool.mode === 'in_commit';
}

export type CallCheck =
  | {
      readonly kind: 'allowed';
      readonly call: ResolvedCall;
      /** Why the MCP arguments went unchecked: the tool's schema could not be built (AC-02.3). */
      readonly unchecked?: string;
    }
  | {
      readonly kind: 'refused';
      readonly reason: ToolRefusalReason;
      /** With `invalid_arguments`: each wrong argument by its path and what was expected (AC-02.2). */
      readonly text?: string;
    };

/** Whether the owner may call this tool of this server: the answer of `AccessGate.tools` for him. */
export type PairAllowed = Extract<ToolAccess, { readonly kind: 'allowed' }>['allows'];

/** A call refused because the gate does not allow its server–tool pair. */
export interface NoAccess {
  readonly kind: 'refused';
  readonly reason: 'no_access';
}

/** The `access_denied` record of a tool call refused `no_access` (KD-6): one per refusal. */
export function toolDeniedEntry(ownerId: string, server: string, tool: string): AccessDeniedEntry {
  return {
    kind: 'access_denied',
    actor: ownerId,
    objectType: 'tool',
    objectId: `${server}/${tool}`,
    outcome: 'rejected',
    reason: 'no_access',
  };
}

/** The `tool_call_refused` record of an MCP call refused for its arguments or as a repeat (KD-6): one per refusal. */
export function toolRefusedEntry(
  ownerId: string,
  server: string,
  tool: string,
  reason: ToolCallRefusedEntry['reason'],
): ToolCallRefusedEntry {
  return {
    kind: 'tool_call_refused',
    actor: ownerId,
    objectType: 'tool',
    objectId: `${server}/${tool}`,
    outcome: 'rejected',
    reason,
  };
}

/** Who answers for a checked call: the owner the audit names, the step's or run's logger, the audit port. */
export interface CheckReportScope {
  readonly ownerId: string;
  readonly logger: Logger;
  readonly audit: AccessAudit;
}

/**
 * What a decided check of an MCP call owes besides the call's ending, for a direct call and a call from code
 * alike (KD-6, AC-02.3): one `tool_call_refused` record of a refusal for its arguments; the warning of a call
 * whose arguments went unchecked — server, tool and why the schema could not be built, never the arguments
 * (NFR-01). A built-in tool owes neither.
 */
export async function reportCheck(
  checked: CallCheck,
  call: { readonly callId: string; readonly server: string | null; readonly tool: string },
  scope: CheckReportScope,
): Promise<void> {
  const { callId, server, tool } = call;
  if (server === null) return;
  if (checked.kind === 'allowed' && checked.unchecked !== undefined) {
    scope.logger.warn('tool arguments not checked', { callId, server, tool, reason: checked.unchecked });
  }
  if (checked.kind === 'refused' && checked.reason === 'invalid_arguments') {
    await scope.audit(toolRefusedEntry(scope.ownerId, server, tool, 'invalid_arguments'));
  }
}

/** How a tool call the runner ran ended; a refusal reached no external system. */
export type ToolExecution =
  | {
      readonly kind: 'done';
      readonly outcome: McpOutcome;
      readonly text: string;
      /** Why an MCP call got no answer; only with `transport_failure` and `unknown`. */
      readonly failureReason?: McpFailureReason;
      /** Script output of a `run_code` run: text of a successful run, `null` of a failed one. */
      readonly output?: string | null;
      /** The value a script gets for its call from code with `success` or `empty` (code-execution KD-2). */
      readonly fullResult?: { readonly value: unknown };
      /**
       * The full result of a direct MCP call with `success` or `empty`, secrets masked: the step's commit
       * stores it with the closing, whatever its length (code-execution KD-5, DC-8; tool-result-reading R-4).
       */
      readonly stored?: StoredToolResult;
      /** The child a `start_agent`-like call started. */
      readonly childAgentId?: string;
    }
  | {
      readonly kind: 'refused';
      readonly reason: ToolRefusalReason;
      /** The refused model of a refusal by model; absent otherwise. */
      readonly refusalDetail?: { readonly model: string } | null;
      /** What the model reads after `[refused: <reason>]` (deep-agents KD-4); absent — the reason alone. */
      readonly text?: string;
    };

/**
 * The step's signal was aborted around an outside call: the step's result is rejected by the runtime,
 * so the step writes nothing (T4.1).
 */
export interface AbortedExecution {
  readonly kind: 'aborted';
}

/** A confirmed call that was not sent: the intent was fenced, or the call was no longer awaiting. */
export interface NotSent {
  readonly kind: 'not_sent';
  readonly reason: 'fenced' | 'not_awaiting';
}

/** What `planInCommit` gives the step: run inside `commit(tx, effects)`. */
export type InCommitPlan = (tx: RuntimeTx, effects: StepEffects) => Promise<ToolExecution>;

export type ConfirmedSend =
  | { readonly kind: 'sent'; readonly execution: ToolExecution | AbortedExecution }
  | NotSent
  /** An in-commit tool: the intent and the call happen in the step's commit transaction. */
  | {
      readonly kind: 'in_commit';
      readonly commit: (tx: RuntimeTx, effects: StepEffects) => Promise<ToolExecution | NotSent>;
    };

/** The decision request of a tool with confirmation (design-agents.md, «Сообщения и события»). */
export interface ConfirmationRequest {
  readonly kind: string;
  readonly payload: {
    readonly agentId: string;
    readonly description: string;
    readonly callId: string;
    readonly tool: string;
    readonly server: string | null;
    readonly args: unknown;
    readonly content: unknown;
  };
}

/** The card of a call that needs a decision, or the refusal its tool's `review` gave before any card (deep-agents KD-3). */
export type ConfirmationCard =
  | { readonly kind: 'request'; readonly request: ConfirmationRequest }
  | Extract<ToolReview, { readonly kind: 'refused' }>;

/** What the spawn helper of one in-commit call is bound to. */
export interface StartChildScope {
  readonly tx: RuntimeTx;
  readonly effects: StepEffects;
  readonly caller: ToolCaller;
}

export interface ToolRunnerOptions {
  /** Sends a call to its server with the credentials of the call (KD-3). */
  readonly client: Pick<McpClient, 'callTool'>;
  /** The credentials of the caller's owner, read just before the call (KD-5). */
  readonly accounts: Pick<McpAccounts, 'credentialsFor'>;
  /**
   * Asked before every call the runner starts — direct, in-commit, confirmed and from code (design-access.md
   * KD-1, KD-4): a disabled owner rejects the runner's method with `OwnerDisabledError` and the call does not
   * start; an MCP pair it does not allow is refused `no_access` before any credentials are read.
   */
  readonly access: Pick<AccessGate, 'tools'>;
  /**
   * Gets the `access_denied` record of each `no_access` the runner decides, and the `tool_call_refused` record of
   * each call from code refused for its arguments (KD-6).
   */
  readonly audit: AccessAudit;
  /** `MCP_CALL_TIMEOUT_MS`: bounds one call, the handshake included. */
  readonly callTimeoutMs: number;
  /**
   * The settings row of large results (tool-result-reading R-5), read on every direct MCP call that ends
   * `success` or `tool_error`: its threshold decides whether the model gets the whole text or the wrapper.
   */
  readonly resultSettings: () => Promise<ToolResultSettingsRow>;
  /** The logger's redaction by value: every MCP text the model gets and every stored result passes it. */
  readonly maskSecrets: (text: string) => string;
  /** Binds `createStartChild` (T3.4) to the commit transaction and the caller; `createAgents` supplies it. */
  readonly startChildFor: (scope: StartChildScope) => StartChild;
}

/** A script's request to call a tool: the name from the model's tool list and the arguments. */
export interface CodeCallRequest {
  readonly name: string;
  readonly args: unknown;
}

/** What a call from code is checked against (code-execution KD-2, KD-8, KD-10). */
export interface CodeCallScope {
  /** The calling agent of the run; the call goes out on behalf of its owner. */
  readonly caller: ToolCaller;
  /** `definitionMcpTools` of the agent's definition, taken when the run started. */
  readonly snapshot: readonly SessionTool[];
  readonly runClass: RunCodeArgs['class'];
  /** The names of the confirmed «Может вызвать» list; a `write` run always has it. */
  readonly confirmedNames?: readonly string[];
  /** Names of the built-in and registered tools (`ToolRegistry.toolNames`): a script never calls them (DC-5). */
  readonly agentToolNames: readonly string[];
  /** `callId` of the `run_code` call: the run the request belongs to. */
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

/** A refused call from code: the text names the tool, the reason and the run class. */
export interface CodeCallRefusal {
  readonly kind: 'refused';
  readonly reason: ToolRefusalReason;
  readonly text: string;
}

/**
 * How a call from code ended: a refusal, the step's signal, or the MCP outcome; `fullResult` holds the
 * whole value of `success`/`empty`; a `tool_error` or `transport_failure` has an empty text (its text
 * is only in the run log); an `unknown` keeps the platform's text that the action may have run.
 */
export type CodeCallExecution =
  | Extract<ToolExecution, { kind: 'done' }>
  | CodeCallRefusal
  | AbortedExecution;

/** A resolved call of an MCP tool. */
type McpCall = ResolvedCall & { readonly tool: Extract<SessionTool, { kind: 'mcp' }> };

/** The step context the runner needs for an outside call; the tool gets it in its input. */
export type OutsideContext = Pick<StepContext, 'signal' | 'logger' | 'guard'>;

/** The step context of a confirmed call: the intent goes through `guard`. */
export type ConfirmContext = Pick<StepContext, 'taskId' | 'signal' | 'logger' | 'guard'>;

export interface ToolRunner {
  /**
   * Checks a call (C3; Flow 1, Failure handling; DC-6): the tool is in the session's check set
   * (`ToolRegistry.checkTools`: a disabled, removed or unnamed server's tool is not), the owner may
   * use its server–tool pair — `allows`, the gate's answer for this step — and the arguments fit the tool's
   * schema: a built-in or registered tool's zod schema, an MCP tool's stored JSON Schema (agent-harness KD-2).
   * An `invalid_arguments` refusal carries the error text; an MCP schema that cannot be built lets the call
   * through `unchecked`. A refused call never reaches the server; allowed arguments are the parsed ones. A
   * `no_access` decided here is audited by the caller of `check`; the rest is `reportCheck`'s.
   */
  check(
    requested: RequestedCall,
    scope: {
      readonly sessionTools: readonly SessionTool[];
      readonly caller: ToolCaller;
      readonly allows: PairAllowed;
    },
  ): CallCheck;
  /**
   * A changing MCP tool (not `readOnlyHint`), or a tool with `confirmation` whose `required(args)` is
   * true or not set (KD-4; code-execution KD-4).
   */
  needsConfirmation(call: ResolvedCall): boolean;
  /**
   * The `await_decision` request of the call; `agents.tool_confirmation` for an MCP tool. A tool with
   * `review` is asked first, outside any transaction: its refusal is the answer and no request is made, its
   * card is the request's content (deep-agents KD-3). Without `review` the content is the tool's
   * `content(args, tools)` — `tools` the session's tool set (code-execution KD-10).
   */
  confirmationRequest(
    call: ResolvedCall,
    session: Pick<Session, 'description'>,
    tools: readonly SessionTool[],
  ): Promise<ConfirmationCard>;
  /** Runs an MCP tool or an `outside` tool, outside any transaction, under the step's signal. */
  runOutside(call: ResolvedCall, ctx: OutsideContext): Promise<ToolExecution | AbortedExecution>;
  /**
   * Checks and runs a script's call (code-execution «Проверка вызова из кода»; KD-2, KD-8, DC-5, DC-6):
   * a built-in or registered tool or `run_code` — `not_callable_from_code`; a `write` run and a name
   * outside the confirmed list — `not_in_confirmed_script`; then `check` against the snapshot; a `read`
   * run and a tool without `McpTool.readOnly` — `changing_in_read_run`. `check` gets the gate's answer asked
   * for this call: a disabled owner rejects, a pair it does not allow is `no_access` with one audit record.
   * An allowed call goes to its server on behalf of the caller's owner; a value is not cut, a server's error
   * text is not returned.
   */
  callFromCode(request: CodeCallRequest, scope: CodeCallScope): Promise<CodeCallExecution>;
  /**
   * The closure an `in_commit` tool runs in `commit(tx, effects)`, with the spawn helper. The gate is asked and
   * the tool's `prepare` runs first, outside the transaction.
   */
  planInCommit(call: InCommitCall, logger: Logger): Promise<InCommitPlan>;
  /**
   * Sends a confirmed call once (Flow 5): first the `tool_sent` intent through `ctx.guard`; `fenced`, or a
   * call no longer awaiting confirmation, is not sent (Invariant 2). `editedArgs` are the arguments the
   * employee edited; they replace the call's. `confirmed` — `content` of the resolved request, given to
   * the tool in its input, `outside` or `in_commit` (code-execution KD-10; deep-agents KD-3).
   */
  sendConfirmed(
    call: ResolvedCall,
    ctx: ConfirmContext,
    editedArgs?: unknown,
    confirmed?: unknown,
  ): Promise<ConfirmedSend>;
}

/** The arguments of an MCP call are an object; `check` then holds them against the tool's own schema. */
const MCP_ARGS_SCHEMA = z.record(z.string(), z.unknown());

/** The longest argument error a refusal's text carries (design-core.md «Что модель видит об исходе вызова»). */
const ARGUMENT_ERROR_MAX_CHARS = 1_000;

/** What the tool's JSON Schema says of an MCP call's arguments (KD-2). */
type SchemaCheck =
  | { readonly kind: 'valid' }
  | { readonly kind: 'invalid'; readonly text: string }
  | { readonly kind: 'unchecked'; readonly reason: string };

/** Keywords left to the server: a server-supplied regex or format runs synchronously and could block the event loop (ReDoS). */
const SERVER_ONLY_KEYWORDS = new Set(['pattern', 'patternProperties', 'format']);
/** Keywords whose keys are property or definition names, not keywords. */
const NAME_MAP_KEYWORDS = new Set(['properties', '$defs', 'definitions', 'dependentSchemas']);
/** Keywords whose values are data, not subschemas. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);

/** A copy of a JSON Schema without `pattern`, `patternProperties` and `format` at any depth. */
function withoutServerOnlyKeywords(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutServerOnlyKeywords);
  if (typeof schema !== 'object' || schema === null) return schema;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SERVER_ONLY_KEYWORDS.has(key)) continue;
    if (DATA_KEYWORDS.has(key)) copy[key] = value;
    else if (NAME_MAP_KEYWORDS.has(key) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      copy[key] = Object.fromEntries(
        Object.entries(value).map(([name, subschema]) => [name, withoutServerOnlyKeywords(subschema)]),
      );
    } else copy[key] = withoutServerOnlyKeywords(value);
  }
  return copy;
}

/**
 * Holds MCP arguments against the schema the server listed, without its regex and format keywords. A schema
 * of an unknown dialect, one that does not compile, or a throw while validating: the call goes unchecked.
 */
function checkMcpArgs(schema: McpTool['inputSchema'], args: unknown): SchemaCheck {
  try {
    // A fresh engine per call, never a shared one: ajv resolves a schema with an `$id` by that `$id`, so two
    // tools declaring the same `$id` would have one server's calls checked against another server's schema.
    const validator = new AjvJsonSchemaValidator();
    const result = validator.getValidator(withoutServerOnlyKeywords(schema) as McpTool['inputSchema'])(args);
    return result.valid ? { kind: 'valid' } : { kind: 'invalid', text: result.errorMessage ?? '' };
  } catch (error) {
    return { kind: 'unchecked', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** A built-in tool's argument error: each issue by its path and what was expected. */
function zodErrorText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? 'arguments' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/** The refusal of a call whose arguments do not fit, its text cut to the bound. */
function invalidArguments(text: string): CallCheck {
  return { kind: 'refused', reason: 'invalid_arguments', text: cutText(text, ARGUMENT_ERROR_MAX_CHARS) };
}

/** The calling agent of a step. */
export function callerOf(ctx: StepContext): ToolCaller {
  return {
    agentId: ctx.taskId,
    ownerId: ctx.ownerId,
    rootId: ctx.rootId,
    parentId: ctx.parentId,
    depth: ctx.depth,
    snapshot: sessionInputOf(ctx.input).snapshot,
  };
}

/**
 * The text of a refused call from code: it names the tool, the reason and the run class
 * (code-execution «Error handling», AC-05.5, AC-03.7).
 */
function codeRefusalText(
  tool: string,
  reason: ToolRefusalReason,
  runClass: RunCodeArgs['class'],
): string {
  const run = `${runClass} run`;
  switch (reason) {
    case 'not_in_confirmed_script':
      return `${tool}: the tool is not in the confirmed code (${reason}, ${run})`;
    case 'changing_in_read_run':
      return `${tool}: the tool is not marked read-only, and a ${run} only reads (${reason})`;
    default:
      return `${tool}: refused, ${reason} (${run})`;
  }
}

/** What a log record of a call names: its id, tool, server and arguments. */
interface LoggedCall {
  readonly callId: string;
  readonly tool: string;
  readonly server: string | null;
  readonly args: unknown;
}

function loggedCall(call: ResolvedCall): LoggedCall {
  return { callId: call.callId, ...callTarget(call.tool), args: loggedArgs(call.tool, call.args) };
}

/** Logs one tool call the runner ran (rule 9 of the plan): ids, tool, server, arguments, outcome, reason, duration. */
function logCall(
  logger: Logger,
  call: LoggedCall,
  execution: ToolExecution | AbortedExecution | NotSent | CodeCallRefusal,
  startedAt: number,
): void {
  const fields = { ...call, durationMs: Date.now() - startedAt };
  switch (execution.kind) {
    case 'done':
      logger.info('tool call finished', {
        ...fields,
        outcome: execution.outcome,
        reason: execution.failureReason ?? null,
        resultChars: execution.text.length,
      });
      return;
    case 'refused':
      logger.info('tool call finished', { ...fields, outcome: 'refused', reason: execution.reason });
      return;
    case 'aborted':
      logger.info('tool call aborted by the step signal', { ...fields, outcome: null, reason: 'aborted' });
      return;
    case 'not_sent':
      logger.warn('confirmed tool call not sent', { ...fields, outcome: null, reason: execution.reason });
      return;
  }
}

/**
 * Outcomes whose text a script does not get: a server's text, or the platform's failure text when the reason
 * is enough; `unknown` and `auth_required` keep the platform's own text.
 */
const HIDDEN_TEXT_OUTCOMES: ReadonlySet<ToolOutcome> = new Set(['tool_error', 'transport_failure']);

/**
 * A call from code the server did not answer with a value: the script gets the outcome and reason
 * only, never the server's text, which may carry a secret; the full response goes to the run log as
 * one warning, where the logger masks the known secrets.
 */
function withoutServerText(
  execution: CodeCallExecution,
  call: LoggedCall,
  logger: Logger,
): CodeCallExecution {
  if (execution.kind !== 'done' || !HIDDEN_TEXT_OUTCOMES.has(execution.outcome)) {
    return execution;
  }
  logger.warn('tool call from code failed; its response is hidden from the script', {
    callId: call.callId,
    tool: call.tool,
    server: call.server,
    outcome: execution.outcome,
    reason: execution.failureReason ?? null,
    response: execution.text,
  });
  return { ...execution, text: '' };
}

/** The tool runner of the step (C3 `ToolRunner`; KD-4, KD-5, Flow 5). */
export function createToolRunner(options: ToolRunnerOptions): ToolRunner {
  const { client, accounts, access, audit, callTimeoutMs, resultSettings, maskSecrets } = options;

  /**
   * The gate's answer for the caller's owner, asked right before a call starts: a disabled owner is logged
   * and thrown as `OwnerDisabledError`, so the call does not start.
   */
  async function pairsOf(callId: string, caller: ToolCaller, logger: Logger): Promise<PairAllowed> {
    const answer = await access.tools(caller.ownerId);
    if (answer.kind === 'allowed') return answer.allows;
    logger.warn('access gate refused a tool call', {
      ownerId: caller.ownerId,
      agentId: caller.agentId,
      callId,
      reason: 'owner_disabled',
    });
    throw new OwnerDisabledError(caller.ownerId);
  }

  /** The one audit record of a `no_access` the runner decided, and its log line. */
  async function refuseNoAccess(
    call: { readonly callId: string; readonly caller: ToolCaller },
    target: { readonly server: string; readonly tool: string },
    logger: Logger,
  ): Promise<NoAccess> {
    logger.warn('access gate refused a tool pair', {
      ownerId: call.caller.ownerId,
      agentId: call.caller.agentId,
      callId: call.callId,
      server: target.server,
      tool: target.tool,
      reason: 'no_access',
    });
    await audit(toolDeniedEntry(call.caller.ownerId, target.server, target.tool));
    return { kind: 'refused', reason: 'no_access' };
  }

  /**
   * The admission point every execution path goes through right before it starts (design-access.md KD-1):
   * the owner is on, and an MCP pair is still allowed — a right taken away after the set was built or while
   * a confirmation waited is `no_access`, with no token read and no request sent. A built-in tool asks only
   * whether the owner is on.
   */
  async function admit(call: ResolvedCall, logger: Logger): Promise<NoAccess | undefined> {
    const allows = await pairsOf(call.callId, call.caller, logger);
    if (call.tool.kind !== 'mcp' || allows(call.tool.mcp.server, call.tool.mcp.tool)) return undefined;
    return refuseNoAccess(call, call.tool.mcp, logger);
  }

  /**
   * Sends one MCP call with the owner's credentials (KD-5): without an account the call is `auth_required`
   * and reaches no server (DC-3); an `oauth` call that ends `auth_required` loses the account it used. A
   * server removed or switched off after the call check is `server_gone`, and nothing is sent (DC-2).
   */
  async function sendMcp(request: {
    readonly server: string;
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly ownerId: string;
    readonly signal: AbortSignal;
  }): Promise<McpCallResponse | { readonly kind: 'server_gone' }> {
    const credentials = await accounts.credentialsFor(request.server, request.ownerId, 'call');
    if (credentials.kind !== 'ready') return credentials;
    const response = await client.callTool({
      url: credentials.url,
      auth: credentials.auth,
      timeoutMs: callTimeoutMs,
      signal: request.signal,
      request: { name: request.tool, arguments: request.args },
    });
    if (response.kind === 'auth_required') await credentials.rejected();
    return response;
  }

  /**
   * Sends an MCP call and turns its answer into an execution with `finish`; the step's signal and a server
   * gone since the check end it before.
   */
  async function callMcp(
    call: McpCall,
    signal: AbortSignal,
    finish: (response: McpCallResponse) => ToolExecution | Promise<ToolExecution>,
  ): Promise<ToolExecution | AbortedExecution> {
    if (signal.aborted) return { kind: 'aborted' };
    const args = MCP_ARGS_SCHEMA.parse(call.args);
    const { server, tool } = call.tool.mcp;
    try {
      const response = await sendMcp({ server, tool, args, ownerId: call.caller.ownerId, signal });
      if (signal.aborted) return { kind: 'aborted' };
      if (response.kind === 'server_gone') return { kind: 'refused', reason: 'tool_not_in_definition' };
      const execution = await finish(response);
      return signal.aborted ? { kind: 'aborted' } : execution;
    } catch (error) {
      if (signal.aborted) return { kind: 'aborted' };
      throw error;
    }
  }

  /**
   * A direct call's answer for the model (tool-result-reading R-1, R-3, R-4): the text masked; a `success`
   * longer than `storeFromChars` becomes the wrapper, a `tool_error` is cut there; `success` and `empty`
   * carry their full result for the step's commit.
   */
  async function directExecution(
    call: McpCall,
    response: McpCallResponse,
    logger: Logger,
  ): Promise<ToolExecution> {
    const { server, tool, readOnly } = call.tool.mcp;
    const result = toOutcome(response, { server, readOnly });
    const done = {
      kind: 'done',
      outcome: result.outcome,
      ...(result.reason === undefined ? {} : { failureReason: result.reason }),
    } as const;
    if (response.kind !== 'result') return { ...done, text: result.text };
    const text = maskSecrets(result.text);
    const stored = (): StoredToolResult => ({
      value: maskValue(scriptValueOf(response.result), maskSecrets),
      text,
    });
    if (result.outcome === 'empty') return { ...done, text, stored: stored() };
    const settings = await resultSettings();
    if (result.outcome === 'tool_error') return { ...done, text: cutText(text, settings.storeFromChars) };
    if (text.length <= settings.storeFromChars) return { ...done, text, stored: stored() };
    logger.info('tool result wrapped', {
      callId: call.callId,
      server,
      tool,
      chars: text.length,
      previewChars: settings.previewChars,
    });
    return {
      ...done,
      text: wrapperText({ callId: call.callId, text, previewChars: settings.previewChars }),
      stored: stored(),
    };
  }

  /** A script's call's answer, as today: the whole text and, with `success` or `empty`, the value. */
  function codeExecution(call: McpCall, response: McpCallResponse): ToolExecution {
    const { server, readOnly } = call.tool.mcp;
    const result = toOutcome(response, { server, readOnly });
    const hasValue =
      response.kind === 'result' && (result.outcome === 'success' || result.outcome === 'empty');
    return {
      kind: 'done',
      outcome: result.outcome,
      text: result.text,
      ...(result.reason === undefined ? {} : { failureReason: result.reason }),
      ...(hasValue ? { fullResult: { value: scriptValueOf(response.result) } } : {}),
    };
  }

  async function execute(
    call: ResolvedCall,
    ctx: OutsideContext,
    confirmed?: unknown,
  ): Promise<ToolExecution | AbortedExecution> {
    const { tool } = call;
    if (tool.kind === 'mcp') {
      const mcpCall: McpCall = { ...call, tool };
      return callMcp(mcpCall, ctx.signal, (response) => directExecution(mcpCall, response, ctx.logger));
    }
    if (tool.tool.mode !== 'outside') {
      throw new Error(`Tool ${tool.name} runs in the commit transaction, not outside it`);
    }
    if (ctx.signal.aborted) return { kind: 'aborted' };
    const result = await tool.tool.execute({
      args: call.args,
      caller: call.caller,
      callId: call.callId,
      signal: ctx.signal,
      logger: ctx.logger,
      guard: (work) => ctx.guard(work),
      ...(confirmed === undefined ? {} : { confirmed }),
    });
    return ctx.signal.aborted ? { kind: 'aborted' } : result;
  }

  /** The tool's `prepare`, run before the commit transaction opens. */
  function prepareInCommit(call: InCommitCall): Promise<unknown> {
    return call.tool.tool.prepare?.({ args: call.args, caller: call.caller }) ?? Promise.resolve(undefined);
  }

  function runInCommit(
    call: InCommitCall,
    prepared: unknown,
    tx: RuntimeTx,
    effects: StepEffects,
    confirmed?: unknown,
  ): Promise<ToolExecution> {
    return call.tool.tool.execute({
      callId: call.callId,
      args: call.args,
      caller: call.caller,
      tx,
      effects,
      startChild: options.startChildFor({ tx, effects, caller: call.caller }),
      prepared,
      ...(confirmed === undefined ? {} : { confirmed }),
    });
  }

  const check: ToolRunner['check'] = (requested, { sessionTools, caller, allows }) => {
    const tool = sessionTools.find((candidate) => candidate.name === requested.toolName);
    if (tool === undefined) return { kind: 'refused', reason: 'tool_not_in_definition' };
    if (tool.kind === 'mcp' && !allows(tool.mcp.server, tool.mcp.tool)) {
      return { kind: 'refused', reason: 'no_access' };
    }
    const schema = tool.kind === 'agent' ? tool.inputSchema : MCP_ARGS_SCHEMA;
    const parsed = schema.safeParse(requested.args);
    if (!parsed.success) return invalidArguments(zodErrorText(parsed.error));
    const call: ResolvedCall = { callId: requested.callId, tool, args: parsed.data, caller };
    if (tool.kind !== 'mcp') return { kind: 'allowed', call };
    const schemaCheck = checkMcpArgs(tool.mcp.inputSchema, parsed.data);
    switch (schemaCheck.kind) {
      case 'valid':
        return { kind: 'allowed', call };
      case 'invalid':
        return invalidArguments(schemaCheck.text);
      case 'unchecked':
        return { kind: 'allowed', call, unchecked: schemaCheck.reason };
    }
  };

  /** The filters of «Проверка вызова из кода» in their order, then the MCP call itself. */
  async function checkAndCallFromCode(
    request: CodeCallRequest,
    scope: CodeCallScope,
  ): Promise<CodeCallExecution> {
    const { name } = request;
    const refuse = (reason: ToolRefusalReason, detail?: string): CodeCallRefusal => {
      const text = codeRefusalText(name, reason, scope.runClass);
      // DC-2: a refusal for the arguments carries the same error a direct call's refusal does.
      return { kind: 'refused', reason, text: detail === undefined ? text : `${text}: ${detail}` };
    };
    if (name === RUN_CODE_TOOL || scope.agentToolNames.includes(name)) {
      return refuse('not_callable_from_code');
    }
    if (scope.runClass === 'write' && !(scope.confirmedNames ?? []).includes(name)) {
      return refuse('not_in_confirmed_script');
    }
    // One answer of the gate for this call: `check` decides with it, and nothing is asked again before the send.
    const allows = await pairsOf(scope.callId, scope.caller, scope.logger);
    const checked = check(
      { callId: scope.callId, toolName: name, args: request.args },
      { sessionTools: scope.snapshot, caller: scope.caller, allows },
    );
    const target = callTargetOf(scope.snapshot, name);
    await reportCheck(
      checked,
      { callId: scope.callId, ...target },
      { ownerId: scope.caller.ownerId, logger: scope.logger, audit },
    );
    if (checked.kind === 'refused') {
      if (checked.reason === 'no_access' && target.server !== null) {
        await refuseNoAccess(scope, { server: target.server, tool: target.tool }, scope.logger);
      }
      return refuse(checked.reason, checked.text);
    }
    const { call } = checked;
    if (call.tool.kind !== 'mcp') {
      // The snapshot holds MCP tools only; an agent tool here is a wrong snapshot, not a script's error.
      throw new Error(`Tool ${name} of a run's snapshot is not an MCP tool`);
    }
    if (scope.runClass === 'read' && !call.tool.mcp.readOnly) {
      return refuse('changing_in_read_run');
    }
    const mcpCall: McpCall = { ...call, tool: call.tool };
    const execution = await callMcp(mcpCall, scope.signal, (response) => codeExecution(mcpCall, response));
    return execution.kind === 'refused' ? refuse(execution.reason) : execution;
  }

  return {
    check,

    needsConfirmation(call) {
      if (call.tool.kind === 'mcp') return !call.tool.mcp.readOnly;
      const { confirmation } = call.tool.tool;
      if (confirmation === undefined) return false;
      return confirmation.required === undefined || confirmation.required(call.args);
    },

    async confirmationRequest(call, session, tools) {
      const { tool, server } = callTarget(call.tool);
      const confirmation = call.tool.kind === 'agent' ? call.tool.tool.confirmation : undefined;
      const review: ToolReview =
        confirmation?.review === undefined
          ? {
              kind: 'card',
              content:
                confirmation === undefined
                  ? { toolDescription: call.tool.description }
                  : confirmation.content(call.args, tools),
            }
          : await confirmation.review(call.args, call.caller);
      if (review.kind === 'refused') return review;
      return {
        kind: 'request',
        request: {
          kind: confirmation?.kind ?? AGENTS_TOOL_CONFIRMATION,
          payload: {
            agentId: call.caller.agentId,
            description: session.description,
            callId: call.callId,
            tool,
            server,
            args: call.args,
            content: review.content,
          },
        },
      };
    },

    async runOutside(call, ctx) {
      const startedAt = Date.now();
      const execution = (await admit(call, ctx.logger)) ?? (await execute(call, ctx));
      logCall(ctx.logger, loggedCall(call), execution, startedAt);
      return execution;
    },

    async callFromCode(request, scope) {
      const startedAt = Date.now();
      const logged: LoggedCall = {
        callId: scope.callId,
        ...callTargetOf(scope.snapshot, request.name),
        args: request.args,
      };
      const execution = await checkAndCallFromCode(request, scope);
      logCall(scope.logger, logged, execution, startedAt);
      return withoutServerText(execution, logged, scope.logger);
    },

    async planInCommit(call, logger) {
      const refusal = await admit(call, logger);
      const prepared = refusal === undefined ? await prepareInCommit(call) : undefined;
      return async (tx, effects) => {
        const startedAt = Date.now();
        const execution = refusal ?? (await runInCommit(call, prepared, tx, effects));
        logCall(logger, loggedCall(call), execution, startedAt);
        return execution;
      };
    },

    async sendConfirmed(call, ctx, editedArgs, confirmed) {
      const sent: ResolvedCall = editedArgs === undefined ? call : { ...call, args: editedArgs };
      const refusal = await admit(call, ctx.logger);
      if (refusal !== undefined) {
        // The right went away while the confirmation waited: no intent and no request (INT-1 steps 5–6).
        logCall(ctx.logger, loggedCall(sent), refusal, Date.now());
        return { kind: 'sent', execution: refusal };
      }
      const key = {
        taskId: ctx.taskId,
        callId: call.callId,
        ...(editedArgs === undefined ? {} : { args: editedArgs }),
      };
      if (isInCommit(call)) {
        const inCommit = { ...call, args: sent.args };
        const prepared = await prepareInCommit(inCommit);
        return {
          kind: 'in_commit',
          commit: async (tx, effects) => {
            const startedAt = Date.now();
            const execution: ToolExecution | NotSent = (await callRecords.markSent(tx, key))
              ? await runInCommit(inCommit, prepared, tx, effects, confirmed)
              : { kind: 'not_sent', reason: 'not_awaiting' };
            logCall(ctx.logger, loggedCall(sent), execution, startedAt);
            return execution;
          },
        };
      }
      const startedAt = Date.now();
      // Committed before the request leaves: a step lost from here on finds the intent and never resends.
      const intent = await ctx.guard((tx) => callRecords.markSent(tx, key));
      if (intent.outcome === 'fenced' || !intent.value) {
        const notSent: NotSent = {
          kind: 'not_sent',
          reason: intent.outcome === 'fenced' ? 'fenced' : 'not_awaiting',
        };
        logCall(ctx.logger, loggedCall(sent), notSent, startedAt);
        return notSent;
      }
      const execution = await execute(sent, ctx, confirmed);
      logCall(ctx.logger, loggedCall(sent), execution, startedAt);
      return { kind: 'sent', execution };
    },
  };
}
