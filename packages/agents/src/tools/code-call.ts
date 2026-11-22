import type { Logger } from '@agent-os/common';
import {
  RUN_CODE_TOOL,
  type RunCodeArgs,
  type ToolOutcome,
  type ToolRefusalReason,
} from '@agent-os/contracts';

import type { AccessAudit, AccessGate } from '../access-gate';
import {
  checkCall,
  type McpCall,
  pairsOf,
  refuseNoAccess,
  reportCheck,
} from './call-check';
import type { ToolCaller } from './tool';
import {
  type AbortedExecution,
  logCall,
  type LoggedCall,
  type McpCalls,
  type ToolExecution,
} from './tool-execution';
import { callTargetOf, isMcp, type SessionTool } from './tool-registry';

/** A script's request to call a tool: the name from the model's tool list and the arguments. */
export interface CodeCallRequest {
  readonly name: string;
  readonly args: unknown;
}

/** What a call from code is checked against (code-execution KD-2, KD-8, KD-10). */
export interface CodeCallScope {
  /** The calling agent of the run; the call goes out on behalf of its owner. */
  readonly caller: ToolCaller;
  /** `declaredMcpTools` of the servers the agent declares, taken when the run started. */
  readonly snapshot: readonly SessionTool[];
  readonly runClass: RunCodeArgs['class'];
  /** The names of the confirmed «Может вызвать» list; a `write` run always has it. */
  readonly confirmedNames?: readonly string[];
  /** Names of the registered tools (`ToolRegistry.toolNames`): a script never calls them (DC-5). */
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
  Extract<ToolExecution, { kind: 'done' }> | CodeCallRefusal | AbortedExecution;

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

/**
 * Outcomes whose text a script does not get: a server's text, or the platform's failure text when the reason
 * is enough; `unknown` and `auth_required` keep the platform's own text.
 */
const HIDDEN_TEXT_OUTCOMES: ReadonlySet<ToolOutcome> = new Set([
  'tool_error',
  'transport_failure',
]);

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
  if (
    execution.kind !== 'done' ||
    !HIDDEN_TEXT_OUTCOMES.has(execution.outcome)
  ) {
    return execution;
  }
  logger.warn(
    'tool call from code failed; its response is hidden from the script',
    {
      callId: call.callId,
      tool: call.tool,
      server: call.server,
      outcome: execution.outcome,
      reason: execution.failureReason ?? null,
      response: execution.text,
    },
  );
  return { ...execution, text: '' };
}

/** The check and the run of a script's call: `ToolRunner.callFromCode`. */
export function createCodeCall(options: {
  readonly access: Pick<AccessGate, 'tools'>;
  readonly audit: AccessAudit;
  readonly callMcp: McpCalls['fromCode'];
}): (
  request: CodeCallRequest,
  scope: CodeCallScope,
) => Promise<CodeCallExecution> {
  const { access, audit, callMcp } = options;

  /** The filters of «Проверка вызова из кода» in their order, then the MCP call itself. */
  async function checkAndCallFromCode(
    request: CodeCallRequest,
    scope: CodeCallScope,
  ): Promise<CodeCallExecution> {
    const { name } = request;
    const refuse = (
      reason: ToolRefusalReason,
      detail?: string,
    ): CodeCallRefusal => {
      const text = codeRefusalText(name, reason, scope.runClass);
      // DC-2: a refusal for the arguments carries the same error a direct call's refusal does.
      return {
        kind: 'refused',
        reason,
        text: detail === undefined ? text : `${text}: ${detail}`,
      };
    };
    if (name === RUN_CODE_TOOL || scope.agentToolNames.includes(name)) {
      return refuse('not_callable_from_code');
    }
    if (
      scope.runClass === 'write' &&
      !(scope.confirmedNames ?? []).includes(name)
    ) {
      return refuse('not_in_confirmed_script');
    }
    // One answer of the gate for this call: `checkCall` decides with it, and nothing is asked again before the send.
    const allows = await pairsOf(
      access,
      scope.callId,
      scope.caller,
      scope.logger,
    );
    const checked = checkCall(
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
        await refuseNoAccess(
          audit,
          scope,
          { server: target.server, tool: target.tool },
          scope.logger,
        );
      }
      return refuse(checked.reason, checked.text);
    }
    const { call } = checked;
    if (!isMcp(call.tool)) {
      // The snapshot holds MCP tools only; a registered tool here is a wrong snapshot, not a script's error.
      throw new Error(`Tool ${name} of a run's snapshot is not an MCP tool`);
    }
    if (scope.runClass === 'read' && !call.tool.mcp.readOnly) {
      return refuse('changing_in_read_run');
    }
    const mcpCall: McpCall = { ...call, tool: call.tool };
    const execution = await callMcp(mcpCall, scope.signal);
    return execution.kind === 'refused' ? refuse(execution.reason) : execution;
  }

  return async (request, scope) => {
    const startedAt = Date.now();
    const logged: LoggedCall = {
      callId: scope.callId,
      ...callTargetOf(scope.snapshot, request.name),
      args: request.args,
    };
    const execution = await checkAndCallFromCode(request, scope);
    logCall(scope.logger, logged, execution, startedAt);
    return withoutServerText(execution, logged, scope.logger);
  };
}
