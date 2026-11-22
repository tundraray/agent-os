import type { Logger } from '@agent-os/common';
import type { ToolRefusalReason } from '@agent-os/contracts';
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
import type { McpTool } from '../mcp/mcp-tool';
import { cutText } from './large-result';
import type { InCommitAgentTool, ToolCaller } from './tool';
import { isMcp, type McpSessionTool, type SessionTool } from './tool-registry';

/** One tool call of a model answer, as the model wrote it. */
export interface RequestedCall {
  readonly callId: string;
  /** The name the model called. */
  readonly toolName: string;
  readonly args: unknown;
}

/** A call that passed `checkCall`: its session tool, its parsed arguments and the calling agent. */
export interface ResolvedCall {
  readonly callId: string;
  readonly tool: SessionTool;
  readonly args: unknown;
  readonly caller: ToolCaller;
}

/** A resolved call of an MCP tool. */
export type McpCall = ResolvedCall & { readonly tool: McpSessionTool };

/** A call of a tool that runs in the commit transaction of the step. */
export type InCommitCall = ResolvedCall & {
  readonly tool: { readonly tool: InCommitAgentTool<unknown> };
};

export function isInCommit(call: ResolvedCall): call is InCommitCall {
  return !isMcp(call.tool) && call.tool.tool.mode === 'in_commit';
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

/** The arguments of an MCP call are an object; `checkCall` then holds them against the tool's own schema. */
export const MCP_ARGS_SCHEMA = z.record(z.string(), z.unknown());

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

/** The check of a call against its session's tools, the gate's answer and the tool's schema: `ToolRunner.check`. */
export function checkCall(
  requested: RequestedCall,
  scope: {
    readonly sessionTools: readonly SessionTool[];
    readonly caller: ToolCaller;
    readonly allows: PairAllowed;
  },
): CallCheck {
  const { sessionTools, caller, allows } = scope;
  const tool = sessionTools.find((candidate) => candidate.name === requested.toolName);
  if (tool === undefined) return { kind: 'refused', reason: 'tool_not_in_definition' };
  if (isMcp(tool) && !allows(tool.mcp.server, tool.mcp.tool)) {
    return { kind: 'refused', reason: 'no_access' };
  }
  const schema = isMcp(tool) ? MCP_ARGS_SCHEMA : tool.inputSchema;
  const parsed = schema.safeParse(requested.args);
  if (!parsed.success) return invalidArguments(zodErrorText(parsed.error));
  const call: ResolvedCall = { callId: requested.callId, tool, args: parsed.data, caller };
  if (!isMcp(tool)) return { kind: 'allowed', call };
  const schemaCheck = checkMcpArgs(tool.mcp.inputSchema, parsed.data);
  switch (schemaCheck.kind) {
    case 'valid':
      return { kind: 'allowed', call };
    case 'invalid':
      return invalidArguments(schemaCheck.text);
    case 'unchecked':
      return { kind: 'allowed', call, unchecked: schemaCheck.reason };
  }
}

/**
 * The gate's answer for the caller's owner, asked right before a call starts: a disabled owner is logged
 * and thrown as `OwnerDisabledError`, so the call does not start.
 */
export async function pairsOf(
  access: Pick<AccessGate, 'tools'>,
  callId: string,
  caller: ToolCaller,
  logger: Logger,
): Promise<PairAllowed> {
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
export async function refuseNoAccess(
  audit: AccessAudit,
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
export async function admit(
  access: Pick<AccessGate, 'tools'>,
  audit: AccessAudit,
  call: ResolvedCall,
  logger: Logger,
): Promise<NoAccess | undefined> {
  const allows = await pairsOf(access, call.callId, call.caller, logger);
  if (!isMcp(call.tool) || allows(call.tool.mcp.server, call.tool.mcp.tool)) return undefined;
  return refuseNoAccess(audit, call, call.tool.mcp, logger);
}
