import type { Clock } from '@agent-os/runtime';
import type { AssessBinding, AssessUsage } from '../assess/assess.js';
import { type AgentDefinition, AgentProcessConfigSchema } from '../config/agent-config.schema.js';
import type { ModelCatalog } from '../config/model-catalog.js';
import { renderPromptTemplate } from '../config/prompt-template.js';
import { callCostUsd, type CallUsage } from '../model/cost.js';
import { promptVersion } from '../model/prompt-version.js';
import { classifyRejection, PROVIDER_RETRIES, providerRetryDelayMs } from '../model/retry-policy.js';
import {
  type AgentToolCall,
  type AgentTurnGeneration,
  type AgentTurnModelClient,
  mastraAgentTurnClient,
  type ReportedUsage,
} from '../model/role-agent.js';
import type { EngineLogger, RoleModel } from '../ports.js';
import type { OutsideTaskTranscripts } from '../transcripts/transcript-writes.js';
import { agentFingerprint, definitionMemoryFingerprint } from './fingerprint.js';
import { firstMessageFits, prologueInputFits } from './process-code.js';
import type { ClosureDecision, FormBindings, ResultForm, ResultFormRegistry } from './result-forms.js';
import { NOTICES } from './run-session.js';
import { buildSessionView, type MemoryEntry, type SessionMessage, type SessionOpening, type WindowStage } from './session-window.js';
import { agentToolsOf, type ToolRegistry } from './tool-registry.js';
import { decideView, toolsOfTurn } from './turn-rules.js';

/**
 * `Engine.assessAgent` (design-agent-core.md, «Операции движка», DC-25, UC-14): the turns of one definition outside an
 * investigation, for calibration and for measuring the influence of a text, beside `Engine.assess`. The prologue's
 * `build` makes the first message; the turns go with the same view, tool schemas and turn limit as in an investigation;
 * every `finish` goes through the closure's `evaluate`, and a refusal is the notice `invalid_result` and the next turn.
 * `collect`, `write` and the forced end are never called. There is no reserve and no token counter: the window stage is
 * chosen by the `BYTES_PER_TOKEN` estimate alone, with no counted-input check, and a view that does not fit at stage 4
 * ends the call `context_overflow` without a request (DC-30); no task, run row, session or
 * ledger row is written — only one transcript of role `agent` per turn, with its whole input and the agent's name.
 */

/**
 * The mark that replaces a binding of kind `definition_pair_table` outside an investigation (DC-25): the pair this
 * call's definition and `deployment` entries make, which no calibrated table may answer yet. A form that groups by such
 * a table reads it and returns a status and a profile without a group.
 */
export interface CalibratingMark {
  readonly calibrating: { readonly agentFingerprint: string; readonly definitionMemoryFingerprint: string };
}

export interface AssessAgentRequest {
  /** An agents-form configuration as data; it is checked with the agents schema. */
  readonly config: unknown;
  readonly agentName: string;
  /** The prologue's input; for a form without a prologue, the assignment. */
  readonly prologueInput: unknown;
  /** The `deployment` entries of the definition memory the turns run with: rules in the system block. */
  readonly deploymentEntries: readonly MemoryEntry[];
  readonly binding: AssessBinding;
  /** No turn starts at or after it. */
  readonly notAfter: Date;
}

export type AssessAgentResult =
  | { readonly outcome: 'finished'; readonly result: unknown; readonly usage: AssessUsage }
  | { readonly outcome: 'ended'; readonly result: unknown; readonly usage: AssessUsage }
  | { readonly outcome: 'invalid_result'; readonly usage: AssessUsage }
  | {
      readonly outcome: 'failed';
      readonly code: 'model_unavailable' | 'not_after' | 'context_overflow' | 'prologue_oversize' | 'prologue_refused';
      readonly usage: AssessUsage;
    }
  | { readonly outcome: 'rejected'; readonly code: 'agent_not_detachable' | 'model_unavailable' };

export type AssessAgent = (request: AssessAgentRequest) => Promise<AssessAgentResult>;

export interface AssessAgentDeps {
  /** The models `Engine.assess` may call (`assessModels`); any other is refused before the first turn. */
  readonly models: ReadonlyMap<string, RoleModel>;
  readonly catalog: ModelCatalog;
  readonly forms: ResultFormRegistry;
  readonly tools: ToolRegistry;
  readonly clock: Clock;
  readonly logger: EngineLogger;
  readonly transcripts: OutsideTaskTranscripts;
  /** Boundary double in unit tests; the Mastra turn client by default. */
  readonly client?: AgentTurnModelClient;
}

const NO_USAGE: AssessUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const FINISH = 'finish';
/** The mode a prompt is rendered in outside an investigation: no source is read. */
const OUTSIDE_SOURCE_MODE = 'model_knowledge';

/** A definition runs outside an investigation only with `finish` alone and a closure that reads nothing (DC-25). */
function detachable(definition: AgentDefinition, form: ResultForm): boolean {
  return definition.tools.length === 0 && form.closure?.collect === undefined;
}

/** The form's bindings with each `definition_pair_table` replaced by the calibrating mark of the pair (DC-25). */
function calibratingBindings(form: ResultForm, mark: CalibratingMark): FormBindings {
  return Object.fromEntries(
    Object.entries(form.bindings ?? {}).map(([name, binding]) => [
      name,
      binding.kind === 'definition_pair_table' ? { kind: 'fixed', value: mark } : binding,
    ]),
  );
}

/** The closure's `evaluate` without `collect` and `write`; a form without a closure accepts a result of its schema. */
function evaluate(form: ResultForm, result: unknown, prologueInput: unknown, bindings: FormBindings): ClosureDecision {
  if (form.closure === undefined) {
    const parsed = form.resultSchema.safeParse(result);
    return parsed.success ? { kind: 'accept', result: parsed.data } : { kind: 'refuse', reason: 'invalid_result' };
  }
  return form.closure.evaluate({ result, prologueInput, collected: null }, bindings);
}

function completeUsage(reported: ReportedUsage): CallUsage | null {
  if (reported.inputTokens === null || reported.outputTokens === null) return null;
  return {
    inputTokens: reported.inputTokens,
    outputTokens: reported.outputTokens,
    cacheReadTokens: reported.cachedInputTokens ?? 0,
    cacheWriteTokens: reported.cacheCreationInputTokens ?? 0,
  };
}

function addUsage(total: AssessUsage, usage: CallUsage | null, costUsd: number): AssessUsage {
  if (usage === null) return total;
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
    costUsd: total.costUsd + costUsd,
  };
}

/** What a turn's calls write back into the session outside an investigation: only `finish` exists. */
type TurnVerdict =
  | { readonly kind: 'accepted'; readonly result: unknown }
  | { readonly kind: 'next'; readonly results: readonly { readonly call: AgentToolCall; readonly reason: string }[]; readonly notice: string | null };

export function createAssessAgent(deps: AssessAgentDeps): AssessAgent {
  const client = deps.client ?? mastraAgentTurnClient;
  const neverAborted = new AbortController().signal;
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      deps.clock.setTimer(ms, resolve);
    });

  return async (request) => {
    const config = AgentProcessConfigSchema.parse(request.config);
    const definition = Object.hasOwn(config.agents, request.agentName) ? config.agents[request.agentName] : undefined;
    if (definition === undefined) throw new Error(`agent ${request.agentName} is not a definition of ${config.processId}`);
    const form = deps.forms.get(definition.result);
    if (form === undefined) throw new Error(`result form ${definition.result} is not in the registry`);
    if (!detachable(definition, form)) return { outcome: 'rejected', code: 'agent_not_detachable' };
    const model = deps.models.get(definition.model);
    if (model === undefined) {
      deps.logger.warn('assess agent model is not allowed', { model: definition.model, outcome: 'model_unavailable' });
      return { outcome: 'rejected', code: 'model_unavailable' };
    }
    const tools = agentToolsOf(definition.tools, { registry: deps.tools, resultSchema: form.resultSchema });
    const bindings = calibratingBindings(form, {
      calibrating: {
        agentFingerprint: agentFingerprint({ definition, tools, form }),
        definitionMemoryFingerprint: definitionMemoryFingerprint(
          request.deploymentEntries.map((entry) => ({ ...entry, scope: 'deployment' })),
        ),
      },
    });

    // The prologue (DC-19, DC-26): the same limits and decisions as in an investigation, without `collect`.
    if (!prologueInputFits(request.prologueInput)) return { outcome: 'failed', code: 'prologue_oversize', usage: NO_USAGE };
    let opening: SessionOpening;
    if (form.prologue === undefined) {
      opening = { kind: 'assignment', text: String(request.prologueInput) };
    } else {
      const built = form.prologue.build(request.prologueInput, bindings);
      if (built.kind === 'end') {
        const decided = evaluate(form, built.result, request.prologueInput, bindings);
        return decided.kind === 'accept'
          ? { outcome: 'ended', result: decided.result, usage: NO_USAGE }
          : { outcome: 'failed', code: 'prologue_refused', usage: NO_USAGE };
      }
      if (!firstMessageFits(built.firstMessage, form.prologue.firstMessageMaxBytes)) {
        return { outcome: 'failed', code: 'prologue_oversize', usage: NO_USAGE };
      }
      opening = { kind: 'prologue', text: built.firstMessage };
    }

    const prompt = renderPromptTemplate(definition.prompt, {
      goal: config.goal,
      query: typeof request.prologueInput === 'string' ? request.prologueInput : '',
      sourceMode: OUTSIDE_SOURCE_MODE,
      answerSections: config.answer.sections.join(', '),
    });
    const messages: SessionMessage[] = [];
    let seq = 0;
    let heldStage: WindowStage = 0;
    let spent = NO_USAGE;

    /** One turn request with the gateway's provider retries, a transcript per attempt; null when the model is unavailable. */
    const turnOnce = async (view: ReturnType<typeof buildSessionView>, last: boolean): Promise<AgentTurnGeneration | null> => {
      const chosen = toolsOfTurn(tools, last);
      for (let retries = 0; ; retries += 1) {
        const callId = await deps.transcripts.open({
          role: 'agent',
          model: definition.model,
          binding: request.binding,
          agentName: request.agentName,
          opening: {
            promptVersion: promptVersion(definition.prompt),
            input: { instructions: view.instructions, messages: view.messages },
          },
        });
        try {
          const generation = await client.generateTurn(
            {
              agentName: request.agentName,
              model,
              instructions: view.instructions,
              messages: view.messages,
              tools: chosen.tools,
              toolChoice: chosen.toolChoice,
              effort: definition.effort,
              maxOutputTokens: definition.limits.maxOutputTokens,
            },
            neverAborted,
          );
          const usage = completeUsage(generation.usage);
          const entry = deps.catalog[definition.model];
          if (entry === undefined) throw new Error(`${definition.model} is not in the model catalog`);
          const costUsd = usage === null ? 0 : callCostUsd(entry, usage);
          spent = addUsage(spent, usage, costUsd);
          await deps.transcripts.close(callId, {
            transcript: {
              outcome: 'answered',
              response: {
                object: { toolCalls: generation.toolCalls },
                finishReason: generation.finishReason ?? null,
                ...(generation.text === '' ? {} : { text: generation.text }),
              },
            },
            usage,
            costUsd,
          });
          return generation;
        } catch (error) {
          const providerError = classifyRejection(error);
          if (providerError === null) throw error;
          deps.logger.warn('assess agent turn failed', { model: definition.model, statusCode: providerError.statusCode, outcome: 'provider_error' });
          await deps.transcripts.close(callId, { transcript: { outcome: 'provider_error', response: null }, usage: null, costUsd: 0 });
          if (!providerError.retryable || retries === PROVIDER_RETRIES) return null;
          await delay(providerRetryDelayMs(retries + 1));
        }
      }
    };

    /** The calls of an answer: a lone `finish` the closure accepts ends the runs; anything else is refused back. */
    const verdictOf = (generation: AgentTurnGeneration): TurnVerdict => {
      const calls = generation.toolCalls;
      if (calls.length === 0) return { kind: 'next', results: [], notice: NOTICES.no_tool_call };
      if (calls.length > 1 || calls[0]?.toolName !== FINISH) {
        const reason = (call: AgentToolCall) => (call.toolName !== FINISH ? 'tool_not_in_definition' : 'finish_not_alone');
        return { kind: 'next', results: calls.map((call) => ({ call, reason: reason(call) })), notice: null };
      }
      const call = calls[0];
      const parsed = form.resultSchema.safeParse(call.args);
      const decided = parsed.success ? evaluate(form, parsed.data, request.prologueInput, bindings) : null;
      if (decided?.kind === 'accept') return { kind: 'accepted', result: decided.result };
      const reason = decided?.kind === 'refuse' ? decided.reason : 'invalid_result';
      return { kind: 'next', results: [{ call, reason: `invalid_result: ${reason}` }], notice: null };
    };

    for (let turn = 1; turn <= definition.limits.maxTurns; turn += 1) {
      if (deps.clock.now() >= request.notAfter) return { outcome: 'failed', code: 'not_after', usage: spent };
      const last = turn === definition.limits.maxTurns;
      if (last) messages.push({ seq: seq++, kind: 'notice', turn: turn - 1, text: NOTICES.last_turn });
      const view = buildSessionView({
        prompt,
        deploymentEntries: request.deploymentEntries,
        userEntries: [],
        tools,
        opening,
        messages,
        windowTokens: definition.limits.windowTokens,
        marginTokens: definition.limits.marginTokens,
        heldStage,
      });
      heldStage = view.stage;
      // DC-30: a view that does not fit the window at stage 4 is never sent; the estimate is the only check here.
      if (decideView(view).kind === 'fail') return { outcome: 'failed', code: 'context_overflow', usage: spent };
      const generation = await turnOnce(view, last);
      if (generation === null) return { outcome: 'failed', code: 'model_unavailable', usage: spent };
      messages.push({ seq: seq++, kind: 'answer', turn, text: generation.text, toolCalls: generation.toolCalls });
      const verdict = verdictOf(generation);
      if (verdict.kind === 'accepted') return { outcome: 'finished', result: verdict.result, usage: spent };
      for (const { call, reason } of verdict.results) {
        messages.push({
          seq: seq++,
          kind: 'result',
          turn,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { outcome: 'rejected', reason },
          author: 'engine',
        });
      }
      if (verdict.notice !== null) messages.push({ seq: seq++, kind: 'notice', turn, text: verdict.notice });
    }
    return { outcome: 'invalid_result', usage: spent };
  };
}
