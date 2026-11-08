import { randomUUID } from 'node:crypto';
import type { ResolveModel, RoleModel } from '@agent-os/engine';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

/**
 * The model double of the integration file (design-engine.md, Test Strategy): a `MockLanguageModelV4` per model id that
 * the test `resolveModel` returns. It implements `doGenerate` — the role agent's call is one non-streaming request with
 * the native `json_schema` output (KD-7) — and answers from a script per role, recording every call. Step 1 of task-09
 * showed the real `Agent` over it behaves as over the provider: one `doGenerate` per `generate`, also when it throws.
 *
 * An agent turn (design-agent-core.md, Test Strategy) has no output schema: the double tells it by the marker
 * {@link agentMarker} in the call's system prompt, keeps a script per agent name and answers with tool calls or a text.
 * The roles of v2 are still told apart by their output schema, which an agent turn never has.
 */

type GenerateOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

/** Roles the double tells apart by the output schema of the call. */
export type ScriptedRole = 'plan' | 'controller' | 'worker' | 'verifier' | 'synthesis';

/**
 * A property only the output schema of that role has, looked up in this order: the synthesis output also has
 * `claims`, so its `summaryClaimIds` is checked before the worker's marker.
 */
const ROLE_MARKERS: Readonly<Record<ScriptedRole, string>> = {
  synthesis: 'summaryClaimIds',
  plan: 'readinessCriteria',
  controller: 'kind',
  worker: 'claims',
  verifier: 'records',
};

/**
 * The marker an agent definition's prompt carries (test-configs.ts): the double finds the agent of a turn by it, as it
 * finds a role by its output schema. It recognises its own script; it reads no text of the investigation.
 */
export const agentMarker = (agentName: string): string => `[probe-agent:${agentName}]`;
const AGENT_MARKER = /\[probe-agent:([A-Za-z0-9_-]+)\]/;

/** One tool call of a scripted agent answer: the tool name and its arguments (an object, or a test's own text). */
export interface ScriptedToolCall {
  readonly tool: string;
  readonly args: unknown;
}

/** Token usage the double reports for a call; `inputTokens` is the whole input, the cached parts included. */
export interface ScriptedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** One answer of the script. */
export type ScriptedStep =
  /**
   * A structured output (any JSON value: a test may script one the schema refuses). With `holdUntil` the call is
   * recorded at once and answers when that promise settles. A function is called with the call when it answers, for an
   * output that names ids the test learns only while the investigation runs or that follows the packet. `usage` may be
   * a function of the call, for a usage that follows the packet (the actual input next to the counted one, DC-13).
   */
  | {
      readonly output: unknown;
      readonly usage?: ScriptedUsage | ((call: RecordedModelCall) => ScriptedUsage);
      readonly holdUntil?: Promise<void>;
    }
  /**
   * An agent answer with tool calls (`tool-call` content parts, finish reason `tool-calls`), each with a fresh call id. A
   * function is called with the call when it answers, for arguments the test learns while the investigation runs.
   */
  | {
      readonly toolCalls: readonly ScriptedToolCall[] | ((call: RecordedModelCall) => readonly ScriptedToolCall[]);
      readonly usage?: ScriptedUsage | ((call: RecordedModelCall) => ScriptedUsage);
      readonly holdUntil?: Promise<void>;
    }
  /** An agent answer with a text and no tool call (DC-2). */
  | {
      readonly text: string;
      readonly usage?: ScriptedUsage | ((call: RecordedModelCall) => ScriptedUsage);
      readonly holdUntil?: Promise<void>;
    }
  /** A provider error, thrown as `AI_APICallError`; without `statusCode` a network error. */
  | { readonly providerError: { readonly statusCode?: number } }
  /** A refusal: `finishReason` `content-filter`, no output. */
  | { readonly refusal: true }
  /**
   * A call held until its `abortSignal` fires (a cancel or `notAfter`); the agent then resolves it with `finishReason`
   * `aborted`. Step 1 showed that a result merely labelled aborted, without the signal, is rejected by Mastra.
   */
  | { readonly hangUntilAborted: true };

/** One call the double received. */
export interface RecordedModelCall {
  readonly role: ScriptedRole | 'agent' | 'unknown';
  /** The agent of a turn, by the marker of its system prompt; null for a role call. */
  readonly agent: string | null;
  readonly modelId: string;
  /** The names of the tools the call offered, in order; empty for a role call. */
  readonly tools: readonly string[];
  /** The `toolChoice` of the call as the provider gets it; undefined for a role call. */
  readonly toolChoice: unknown;
  /** The whole prompt as sent: the system block and the messages with their content parts and provider options. */
  readonly prompt: GenerateOptions['prompt'];
  /** The `tool` messages of the prompt: the step of an agent's program after a restart (E2E-1). */
  readonly toolResults: number;
  /** The call's abort signal: fired when a cancel or `notAfter` ended the call. */
  readonly abortSignal: AbortSignal | undefined;
  /** The `system` text — the rendered role prompt. */
  readonly system: string;
  /** The user text of the packet. */
  readonly user: string;
  /**
   * The characters of the system and user texts as sent, with no separator between messages: what the harness counter
   * counts (one token per character), also for the controller's two user messages (KD-6).
   */
  readonly inputChars: number;
  /** The provider options of the request itself (KD-6: never a cache mark). */
  readonly providerOptions: unknown;
  /** The provider options of each prompt message, in prompt order, `undefined` where it has none: where the cache mark is. */
  readonly messageOptions: readonly { readonly role: string; readonly providerOptions: unknown }[];
}

export interface ScriptedModel {
  readonly resolveModel: ResolveModel;
  /** Every call in arrival order; a test may empty it. */
  readonly calls: RecordedModelCall[];
  /** Appends steps to the role's script; a role without a step left fails its call loudly. */
  script(role: ScriptedRole, ...steps: ScriptedStep[]): void;
  /** Calls of one role. */
  callsOf(role: ScriptedRole): RecordedModelCall[];
  /** Appends steps to the agent's script; an agent without a step left goes to the `fallback`, then fails loudly. */
  scriptAgent(agentName: string, ...steps: ScriptedStep[]): void;
  /** Turns of one agent, in arrival order. */
  callsOfAgent(agentName: string): RecordedModelCall[];
  /** Empties the calls and every role's and agent's script: each test starts from a clean double. */
  reset(): void;
  /** Steps of each role's script not consumed yet: a test that left steps scripted more than happened. */
  pending(): Record<ScriptedRole, number>;
  /** Steps of each agent's script not consumed yet, by agent name (only agents that were scripted). */
  pendingAgents(): Record<string, number>;
}

const DEFAULT_USAGE: ScriptedUsage = { inputTokens: 100, outputTokens: 20 };
/** The `plan` role answers this when a test scripts no plan: most rows do not care about the plan. */
const DEFAULT_PLAN = { readinessCriteria: ['the question is answered'], branches: [] };

function usageOf(usage: ScriptedUsage): GenerateResult['usage'] {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return {
    inputTokens: { total: usage.inputTokens, noCache: usage.inputTokens - cacheRead - cacheWrite, cacheRead, cacheWrite },
    outputTokens: { total: usage.outputTokens, text: usage.outputTokens, reasoning: 0 },
  };
}

function roleOf(options: GenerateOptions): ScriptedRole | 'unknown' {
  const format = options.responseFormat;
  const schema = format?.type === 'json' ? format.schema : undefined;
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const role = (Object.keys(ROLE_MARKERS) as ScriptedRole[]).find((candidate) => ROLE_MARKERS[candidate] in properties);
  return role ?? 'unknown';
}

/** The agent of a call without a role schema, by the marker of its system prompt; null for any other call. */
function agentOf(options: GenerateOptions): string | null {
  const match = AGENT_MARKER.exec(textOf(options, 'system'));
  return match?.[1] ?? null;
}

/** The answer content of scripted tool calls: `tool-call` parts with fresh ids and the arguments as JSON text. */
function toolCallParts(toolCalls: readonly ScriptedToolCall[]): GenerateResult['content'] {
  return toolCalls.map(({ tool, args }) => ({
    type: 'tool-call' as const,
    toolCallId: `call_${randomUUID()}`,
    toolName: tool,
    input: typeof args === 'string' ? args : JSON.stringify(args),
  }));
}

function textsOf(options: GenerateOptions, role: 'system' | 'user'): string[] {
  return options.prompt.flatMap((message) => {
    if (message.role !== role) return [];
    if (typeof message.content === 'string') return [message.content];
    return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  });
}

function textOf(options: GenerateOptions, role: 'system' | 'user'): string {
  return textsOf(options, role).join('\n');
}

/** An `args` object written as the JSON text the model returns; text (a test's own, maybe broken) stays as it is. */
function argsAsText<T>(item: T): T {
  if (typeof item !== 'object' || item === null || !('args' in item)) return item;
  const { args } = item as { args: unknown };
  return typeof args === 'object' && args !== null ? { ...item, args: JSON.stringify(args) } : item;
}

/**
 * The output as the provider sends it: the controller's tool `args` are JSON text in its output schema
 * (`ModelArgsSchema`), so a script may write them as objects and the double writes the text.
 */
function asSent(role: ScriptedRole, output: unknown): unknown {
  if (role !== 'controller' || typeof output !== 'object' || output === null) return output;
  const withArgs = argsAsText(output);
  const { subquestions } = withArgs as { subquestions?: unknown };
  return Array.isArray(subquestions) ? { ...withArgs, subquestions: subquestions.map(argsAsText) } : withArgs;
}

/** The closed form the `verifier` answers (Contract «Вывод `verifier` — `ClaimAssessment`»); a test may pass values off it. */
export interface ScriptedAssessment {
  readonly support: string;
  readonly claimType: string;
  readonly records: readonly { readonly record: number; readonly relation: string }[];
}

/** A verifier answer in the closed form, field by field as the test gives it. */
export function assessment({ support, claimType, records }: ScriptedAssessment): ScriptedAssessment {
  return { support, claimType, records: records.map(({ record, relation }) => ({ record, relation })) };
}

/**
 * The input of a verifier call as `buildClaimCheck` lays it out: the claim text and its atoms with the atom check, then
 * each given record with its number.
 */
export interface VerifierPacket {
  readonly claimText: string;
  readonly atoms: readonly { readonly kind: string; readonly value: string; readonly verdict: string; readonly records: readonly number[] }[];
  readonly records: readonly { readonly number: number; readonly record: unknown }[];
}

/** The content of the `<tag>` section of a packet, or undefined when it has none. */
function sectionOf(user: string, tag: string): string | undefined {
  const open = `<${tag}>\n`;
  const start = user.indexOf(open);
  if (start < 0) return undefined;
  const end = user.indexOf(`\n</${tag}>`, start + open.length);
  return end < 0 ? undefined : user.slice(start + open.length, end);
}

/**
 * Reads a verifier packet by its structure only: the claim JSON in `<claim>` (text and atoms) and, in `<data>`, the JSON lines of the
 * records (each with its `number`; the page lines carry none). A double that tells claims apart compares the text with
 * the exact text the test wrote — it recognises its own script, it does not interpret text.
 */
export function verifierPacketOf(call: RecordedModelCall): VerifierPacket {
  const claim = sectionOf(call.user, 'claim');
  const data = sectionOf(call.user, 'data');
  if (claim === undefined || data === undefined) throw new Error('scripted model: the call is no claim check');
  const records = data
    .split('\n')
    .map((line) => JSON.parse(line) as { number?: number; record?: unknown })
    .flatMap((line) => (line.number === undefined ? [] : [{ number: line.number, record: line.record }]));
  const { text, atoms } = JSON.parse(claim) as { text: string; atoms: VerifierPacket['atoms'] };
  return { claimText: text, atoms, records };
}

/** The pages of a worker packet: the evidence id of each and its records, numbered from 0 (`role-packets.ts`, KD-1). */
export function workerPagesOf(call: RecordedModelCall): { readonly pageId: string; readonly records: readonly unknown[] }[] {
  const pattern = /<evidence id="([^"]+)">\n([\s\S]*?)\n<\/evidence>/g;
  const record = /<record number="\d+">(.*)<\/record>/g;
  return [...call.user.matchAll(pattern)].map((match) => ({
    pageId: match[1]!,
    records: [...match[2]!.matchAll(record)].map((line) => JSON.parse(line[1]!) as unknown),
  }));
}

/** A held call that no abort ends fails the test instead of hanging the suite. */
const HANG_LIMIT_MS = 30_000;

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return Promise.reject(new Error('hangUntilAborted needs an abortSignal'));
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      reject(new Error(`hangUntilAborted: no abort within ${HANG_LIMIT_MS} ms`));
    }, HANG_LIMIT_MS);
    const aborted = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', aborted, { once: true });
  });
}

export interface ScriptedModelOptions {
  /**
   * Answers a call whose role has no scripted step left, from the call itself: a program instead of a queue, for a
   * process that restarts in the middle of an investigation and cannot know which steps the dead one consumed.
   * `undefined` falls through to the default plan or to the loud failure.
   */
  readonly fallback?: (call: RecordedModelCall) => ScriptedStep | undefined;
}

export function createScriptedModel(modelOptions: ScriptedModelOptions = {}): ScriptedModel {
  const calls: RecordedModelCall[] = [];
  const scripts: Record<ScriptedRole, ScriptedStep[]> = { plan: [], controller: [], worker: [], verifier: [], synthesis: [] };
  const agentScripts = new Map<string, ScriptedStep[]>();

  /** The next step of the call: its role's or agent's script, then the `fallback` program, then the default plan. */
  function nextStep(call: RecordedModelCall): ScriptedStep | undefined {
    if (call.role === 'agent') {
      return agentScripts.get(call.agent ?? '')?.shift() ?? modelOptions.fallback?.(call);
    }
    if (call.role === 'unknown') return undefined;
    return scripts[call.role].shift() ?? modelOptions.fallback?.(call) ?? (call.role === 'plan' ? { output: DEFAULT_PLAN } : undefined);
  }

  async function answer(modelId: string, options: GenerateOptions): Promise<GenerateResult> {
    const schemaRole = roleOf(options);
    const agent = schemaRole === 'unknown' ? agentOf(options) : null;
    const role = agent === null ? schemaRole : 'agent';
    const call: RecordedModelCall = {
      role,
      agent,
      modelId,
      tools: (options.tools ?? []).map((tool) => tool.name),
      toolChoice: options.toolChoice,
      prompt: options.prompt,
      toolResults: options.prompt.filter((message) => message.role === 'tool').length,
      abortSignal: options.abortSignal,
      system: textOf(options, 'system'),
      user: textOf(options, 'user'),
      inputChars: textsOf(options, 'system').concat(textsOf(options, 'user')).reduce((sum, text) => sum + text.length, 0),
      providerOptions: options.providerOptions,
      messageOptions: options.prompt.map((message) => ({ role: message.role, providerOptions: message.providerOptions })),
    };
    calls.push(call);
    if (role === 'unknown') {
      throw new Error(`scripted model ${modelId}: a call of an unscripted role`);
    }
    const step = nextStep(call);
    if (step === undefined) {
      throw new Error(`scripted model ${modelId}: no ${agent ?? role} step left`);
    }
    if ('providerError' in step) {
      throw new APICallError({
        message: 'scripted provider error',
        url: 'http://scripted-model/v1/messages',
        requestBodyValues: {},
        statusCode: step.providerError.statusCode,
        isRetryable: true,
      });
    }
    if ('hangUntilAborted' in step) {
      await waitForAbort(options.abortSignal);
      return { content: [], finishReason: { unified: 'other', raw: 'aborted' }, usage: usageOf(DEFAULT_USAGE), warnings: [] };
    }
    if ('refusal' in step) {
      return { content: [], finishReason: { unified: 'content-filter', raw: 'refusal' }, usage: usageOf(DEFAULT_USAGE), warnings: [] };
    }
    await step.holdUntil;
    const usage = usageOf(typeof step.usage === 'function' ? step.usage(call) : (step.usage ?? DEFAULT_USAGE));
    if ('toolCalls' in step) {
      const toolCalls = typeof step.toolCalls === 'function' ? step.toolCalls(call) : step.toolCalls;
      return { content: toolCallParts(toolCalls), finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage, warnings: [] };
    }
    if ('text' in step) {
      return { content: [{ type: 'text', text: step.text }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] };
    }
    if (role === 'agent') {
      throw new Error(`scripted model ${modelId}: agent ${agent} got a structured-output step`);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(asSent(role, typeof step.output === 'function' ? step.output(call) : step.output)) }],
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage,
      warnings: [],
    };
  }

  const models = new Map<string, RoleModel>();
  return {
    calls,
    resolveModel: (modelId) => {
      const existing = models.get(modelId);
      if (existing !== undefined) return existing;
      const model = new MockLanguageModelV4({ provider: 'scripted', modelId, doGenerate: (options) => answer(modelId, options) });
      models.set(modelId, model);
      return model;
    },
    script: (role, ...steps) => {
      scripts[role].push(...steps);
    },
    callsOf: (role) => calls.filter((call) => call.role === role),
    scriptAgent: (agentName, ...steps) => {
      const script = agentScripts.get(agentName) ?? [];
      script.push(...steps);
      agentScripts.set(agentName, script);
    },
    callsOfAgent: (agentName) => calls.filter((call) => call.agent === agentName),
    reset: () => {
      calls.length = 0;
      scripts.plan.length = 0;
      scripts.controller.length = 0;
      scripts.worker.length = 0;
      scripts.verifier.length = 0;
      scripts.synthesis.length = 0;
      agentScripts.clear();
    },
    pendingAgents: () =>
      Object.fromEntries([...agentScripts].map(([agentName, script]) => [agentName, script.length])),
    pending: () => ({
      plan: scripts.plan.length,
      controller: scripts.controller.length,
      worker: scripts.worker.length,
      verifier: scripts.verifier.length,
      synthesis: scripts.synthesis.length,
    }),
  };
}
