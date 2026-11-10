import { randomUUID } from 'node:crypto';
import type { ResolveModel, RoleModel } from '@agent-os/engine';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

/**
 * The model double of the integration files (design-agent-core.md, Test Strategy): a `MockLanguageModelV4` per model id
 * that the test `resolveModel` returns. It implements `doGenerate` — an agent turn is one non-streaming request (KD-1) —
 * and records every call. The real `Agent` over it behaves as over the provider: one `doGenerate` per `generate`, also
 * when it throws.
 *
 * The double tells the agent of a turn by the marker {@link agentMarker} in the call's system prompt, keeps a script per
 * agent name and answers with tool calls or a text. The shipped definitions carry no marker and may not get one: their
 * agent is found by the prompt they start the system block with ({@link ScriptedModel.recognizeAgents},
 * design-research-flow.md, Test Strategy).
 */

type GenerateOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

/**
 * The marker an agent definition's prompt carries (test-configs.ts): the double finds the agent of a turn by it. It recognises its own script; it reads no text of the investigation.
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

/** A gathered page as the session shows it to the agent (the result of `gather`). */
export interface ViewedPage {
  readonly page: string;
  readonly morePages?: readonly string[];
  readonly returned: number;
  readonly truncated: boolean;
  /** The same request answered before: the page is the stored one (DC-11). */
  readonly repeat?: true;
}

/** One ended `call_agent` of the session: whom it called and what came back. */
export interface ViewedChild {
  readonly agent: string;
  readonly assignment: string;
  readonly outcome: string;
  readonly result: unknown;
  readonly reason?: string;
}

/** One finished run as `investigation_read` (view `runs`) lists it: the run id `research_close` names. */
export interface ViewedRun {
  readonly run: string;
  readonly agent: string;
  readonly result?: unknown;
  readonly failure?: unknown;
}

/** One line of the `{{sources}}` field of the system block (UC-13). */
export interface ViewedSourceLine {
  readonly sourceId: string;
  readonly toolName: string;
  readonly argsSchema: unknown;
}

/** A tool result of the session: its name, and its body as the engine wrote it. */
export interface ViewedResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly outcome: string;
  readonly result?: unknown;
  readonly reason?: string;
  readonly detail?: unknown;
}

/**
 * A call with its session parsed: what a scripted step needs from the earlier results, because the ids it must send exist
 * only after them. Every field is read when asked for, so a result the window has stubbed fails only the step that needs it.
 */
export interface AgentCallView extends RecordedModelCall {
  /** The run's first message, out of its envelope: the assignment, or the first message of a prologue. */
  readonly assignment: string;
  /** The number of this turn: the model's answers in the prompt, plus one. */
  readonly turn: number;
  /** The results of one tool, in the order of the session. */
  resultsOf(toolName: string): readonly ViewedResult[];
  /** The pages of the `gather` calls that returned one. */
  readonly pages: readonly ViewedPage[];
  /** The claim ids `claims_write` returned, in the order of the calls. */
  readonly claimIds: readonly string[];
  /** The ended `call_agent` calls. */
  readonly children: readonly ViewedChild[];
  /** The finished runs of the investigation, as the session's `investigation_read` calls listed them. */
  readonly runs: readonly ViewedRun[];
  /** The revision the last `plan_write` wrote; null without one. */
  readonly planRevision: number | null;
  /** The lines of the `{{sources}}` field in the system block. */
  readonly sourceLines: readonly ViewedSourceLine[];
}

/**
 * One answer of the script. With `holdUntil` the call is recorded at once and answers when that promise settles; `usage`
 * may be a function of the call, for a usage that follows the packet (the actual input next to the counted one, DC-13).
 */
export type ScriptedStep =
  /**
   * An agent answer with tool calls (`tool-call` content parts, finish reason `tool-calls`), each with a fresh call id. A
   * function is called with the parsed call when it answers, for arguments the test learns while the investigation runs.
   */
  | {
      readonly toolCalls: readonly ScriptedToolCall[] | ((view: AgentCallView) => readonly ScriptedToolCall[]);
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
  /**
   * A call held until its `abortSignal` fires (a cancel or `notAfter`); the agent then resolves it with `finishReason`
   * `aborted`. Step 1 showed that a result merely labelled aborted, without the signal, is rejected by Mastra.
   */
  | { readonly hangUntilAborted: true };

/** One call the double received. */
export interface RecordedModelCall {
  readonly role: 'agent' | 'unknown';
  /** The agent of a turn, by the marker or the prompt its system block starts with; null for an unrecognised call. */
  readonly agent: string | null;
  readonly modelId: string;
  /** The names of the tools the call offered, in order. */
  readonly tools: readonly string[];
  /** The `toolChoice` of the call as the provider gets it. */
  readonly toolChoice: unknown;
  /** The whole prompt as sent: the system block and the messages with their content parts and provider options. */
  readonly prompt: GenerateOptions['prompt'];
  /** The `tool` messages of the prompt: the step of an agent's program after a restart (E2E-1). */
  readonly toolResults: number;
  /** The call's abort signal: fired when a cancel or `notAfter` ended the call. */
  readonly abortSignal: AbortSignal | undefined;
  /** The `system` text — the rendered agent prompt. */
  readonly system: string;
  /** The user text of the packet. */
  readonly user: string;
  /**
   * The characters of the system and user texts as sent, with no separator between messages.
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
  /** Appends steps to the agent's script; an agent without a step left goes to the `fallback`, then fails loudly. */
  scriptAgent(agentName: string, ...steps: ScriptedStep[]): void;
  /** Turns of one agent, in arrival order. */
  callsOfAgent(agentName: string): RecordedModelCall[];
  /**
   * Tells the double the prompts of definitions that carry no marker, replacing what it was told before. Two different
   * agents whose prompts cannot be told apart fail here, loudly: the scenarios would answer the wrong agent.
   */
  recognizeAgents(prompts: readonly AgentPrompt[]): void;
  /**
   * Holds the first turn of the next `runs` runs (of `agent` only, when named) until all of them have arrived; resolves then.
   * A turn is released early by its abort, and the wait fails the call after {@link HANG_LIMIT_MS}.
   */
  latch(runs: number, agent?: string): Promise<void>;
  /** Empties the calls and every agent's script: each test starts from a clean double. */
  reset(): void;
  /** Steps of each agent's script not consumed yet, by agent name (only agents that were scripted). */
  pendingAgents(): Record<string, number>;
}

/** A definition's name and its prompt template, from a loaded configuration. */
export interface AgentPrompt {
  readonly agent: string;
  readonly prompt: string;
}

const DEFAULT_USAGE: ScriptedUsage = { inputTokens: 100, outputTokens: 20 };

function usageOf(usage: ScriptedUsage): GenerateResult['usage'] {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return {
    inputTokens: { total: usage.inputTokens, noCache: usage.inputTokens - cacheRead - cacheWrite, cacheRead, cacheWrite },
    outputTokens: { total: usage.outputTokens, text: usage.outputTokens, reasoning: 0 },
  };
}

/** A template's text around its fields: what every rendering of it holds, whatever the values. */
const literalsOf = (template: string): readonly string[] => template.split(/\{\{[^{}]*\}\}/);

/** Whether `text` starts with a rendering of the template these literals come from. */
function startsWithTemplate(text: string, [first = '', ...rest]: readonly string[]): boolean {
  if (!text.startsWith(first)) return false;
  let from = first.length;
  for (const literal of rest) {
    const at = text.indexOf(literal, from);
    if (at < 0) return false;
    from = at + literal.length;
  }
  return true;
}

interface RecognizedPrompt {
  readonly agent: string;
  readonly literals: readonly string[];
}

/**
 * What the double knows a marker-less definition by: the literals of its whole template, not the text before its first
 * field, which `worker` and `subworker` share to the word. Two agents one template would match are refused.
 */
function recognizedPrompts(prompts: readonly AgentPrompt[]): readonly RecognizedPrompt[] {
  const recognized = prompts
    .filter(({ prompt }) => !AGENT_MARKER.test(prompt))
    .map(({ agent, prompt }) => ({ agent, literals: literalsOf(prompt) }));
  for (const one of recognized) {
    const twin = recognized.find((other) => other.agent !== one.agent && startsWithTemplate(one.literals.join(''), other.literals));
    if (twin !== undefined) {
      throw new Error(`scripted model: the prompts of agents ${one.agent} and ${twin.agent} start alike, the double cannot tell them apart`);
    }
  }
  return recognized;
}

/** The agent of a call, by its marker or by the prompt it starts with; null for any other call. */
function agentOf(system: string, prompts: readonly RecognizedPrompt[]): string | null {
  return AGENT_MARKER.exec(system)?.[1] ?? prompts.find(({ literals }) => startsWithTemplate(system, literals))?.agent ?? null;
}

const unescapeData = (text: string): string =>
  text.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');

/** The data of an envelope (`envelope` of session-window.ts); undefined for a text that is not one whole envelope. */
function dataOf(text: string): string | undefined {
  const close = '\n</data>';
  const bodyStart = text.indexOf('>\n');
  if (!text.startsWith('<data source=') || bodyStart < 0 || !text.endsWith(close)) return undefined;
  return unescapeData(text.slice(bodyStart + 2, -close.length));
}

function firstUserText(prompt: GenerateOptions['prompt']): string {
  const first = prompt.find((message) => message.role === 'user');
  if (first === undefined) return '';
  return first.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

interface PromptResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly text: string;
}

function promptResults(prompt: GenerateOptions['prompt']): readonly PromptResult[] {
  return prompt.flatMap((message) => {
    if (message.role !== 'tool') return [];
    return message.content.flatMap((part) => {
      if (part.type !== 'tool-result') return [];
      const value = 'value' in part.output ? part.output.value : undefined;
      return [{ toolCallId: part.toolCallId, toolName: part.toolName, text: typeof value === 'string' ? value : JSON.stringify(value) }];
    });
  });
}

function viewedResult({ toolCallId, toolName, text }: PromptResult): ViewedResult {
  const data = dataOf(text);
  if (data === undefined) throw new Error(`scripted model: the result of ${toolName} is not whole in this prompt: ${text.slice(0, 80)}`);
  return { toolCallId, toolName, ...(JSON.parse(data) as { outcome: string }) };
}

/** The arguments of each `call_agent` of the prompt, by its call id. */
function calledAgents(prompt: GenerateOptions['prompt']): ReadonlyMap<string, { readonly agent: string; readonly assignment: string }> {
  const called = prompt.flatMap((message) => {
    if (message.role !== 'assistant' || typeof message.content === 'string') return [];
    return message.content.flatMap((part) =>
      part.type === 'tool-call' && part.toolName === 'call_agent'
        ? [[part.toolCallId, (typeof part.input === 'string' ? JSON.parse(part.input) : part.input) as { agent: string; assignment: string }] as const]
        : [],
    );
  });
  return new Map(called);
}

/** The lines of the `{{sources}}` field: the JSON lines of the system block that name a source tool. */
function sourceLinesOf(system: string): readonly ViewedSourceLine[] {
  return system.split('\n').flatMap((line) => {
    if (!line.startsWith('{')) return [];
    const parsed = JSON.parse(line) as Partial<ViewedSourceLine>;
    return parsed.sourceId === undefined || parsed.toolName === undefined ? [] : [parsed as ViewedSourceLine];
  });
}

/** {@link AgentCallView} of a call. */
function viewOf(call: RecordedModelCall): AgentCallView {
  const resultsOf = (toolName: string): readonly ViewedResult[] =>
    promptResults(call.prompt)
      .filter((result) => result.toolName === toolName)
      .map(viewedResult);
  const resultBodies = <T>(toolName: string): T[] => resultsOf(toolName).map((result) => result.result as T);
  const opening = firstUserText(call.prompt);
  return {
    ...call,
    assignment: dataOf(opening) ?? opening,
    turn: call.prompt.filter((message) => message.role === 'assistant').length + 1,
    resultsOf,
    get pages() {
      return resultBodies<Partial<ViewedPage> | undefined>('gather').filter((body): body is ViewedPage => typeof body?.page === 'string');
    },
    get claimIds() {
      return resultBodies<{ claimIds?: string[] } | undefined>('claims_write').flatMap((body) => body?.claimIds ?? []);
    },
    get children() {
      const called = calledAgents(call.prompt);
      return resultsOf('call_agent').map(({ toolCallId, outcome, result, reason }) => {
        const callee = called.get(toolCallId);
        if (callee === undefined) throw new Error(`scripted model: call_agent result ${toolCallId} has no call in this prompt`);
        return { ...callee, outcome, result, ...(reason === undefined ? {} : { reason }) };
      });
    },
    get runs() {
      const listed = resultBodies<{ view?: string; items?: ViewedRun[] } | undefined>('investigation_read')
        .filter((body) => body?.view === 'runs')
        .flatMap((body) => body?.items ?? []);
      return [...new Map(listed.map((run) => [run.run, run])).values()];
    },
    get planRevision() {
      return resultBodies<{ revision?: number } | undefined>('plan_write').at(-1)?.revision ?? null;
    },
    get sourceLines() {
      return sourceLinesOf(call.system);
    },
  };
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
 * Reads a verifier packet (the prologue of the checker agent) by its structure only: the claim JSON in `<claim>` (text and atoms) and, in `<data>`, the JSON lines of the
 * records (each with its `number`; the page lines carry none). A double that tells claims apart compares the text with
 * the exact text the test wrote — it recognises its own script, it does not interpret text.
 */
export function verifierPacketOf(call: RecordedModelCall): VerifierPacket {
  const user = dataOf(firstUserText(call.prompt)) ?? call.user;
  const claim = sectionOf(user, 'claim');
  const data = sectionOf(user, 'data');
  if (claim === undefined || data === undefined) throw new Error('scripted model: the call is no claim check');
  const records = data
    .split('\n')
    .map((line) => JSON.parse(line) as { number?: number; record?: unknown })
    .flatMap((line) => (line.number === undefined ? [] : [{ number: line.number, record: line.record }]));
  const { text, atoms } = JSON.parse(claim) as { text: string; atoms: VerifierPacket['atoms'] };
  return { claimText: text, atoms, records };
}

/** `finish` of the form `text`: `refs` lead to this investigation's data or are empty, a foreign one is `foreign_ref` (DC-4). */
export function finishText(
  summary: string,
  refs: readonly { readonly type: 'note' | 'claim' | 'record' | 'run'; readonly id: string }[] = [],
): ScriptedToolCall {
  return { tool: 'finish', args: { summary, refs } };
}

/** A held call that no abort ends fails the test instead of hanging the suite. */
const HANG_LIMIT_MS = 30_000;

/** Waits for `opened`, or for the call's abort; a latch that never fills fails the call. */
function heldAtLatch(opened: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const released = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', released);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', released);
      reject(new Error(`scripted model: the latch did not fill within ${HANG_LIMIT_MS} ms`));
    }, HANG_LIMIT_MS);
    signal?.addEventListener('abort', released, { once: true });
    void opened.then(released);
  });
}

interface ActiveLatch {
  readonly agent: string | undefined;
  readonly opened: Promise<void>;
  readonly open: () => void;
  missing: number;
}

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
   * Answers a turn whose agent has no scripted step left, from the call itself: a program instead of a queue, for a
   * process that restarts in the middle of an investigation and cannot know which steps the dead one consumed.
   * `undefined` falls through to the loud failure.
   */
  readonly fallback?: (view: AgentCallView) => ScriptedStep | undefined;
}

export function createScriptedModel(modelOptions: ScriptedModelOptions = {}): ScriptedModel {
  const calls: RecordedModelCall[] = [];
  const agentScripts = new Map<string, ScriptedStep[]>();
  let prompts: readonly RecognizedPrompt[] = [];
  let activeLatch: ActiveLatch | undefined;

  /** Holds the first turn of a run the active latch waits for, until the latch is full. */
  async function passLatch(call: RecordedModelCall): Promise<void> {
    const latched = activeLatch;
    if (latched === undefined || call.role !== 'agent' || call.toolResults !== 0) return;
    if (latched.agent !== undefined && latched.agent !== call.agent) return;
    latched.missing -= 1;
    if (latched.missing === 0) {
      activeLatch = undefined;
      latched.open();
    }
    await heldAtLatch(latched.opened, call.abortSignal);
  }

  /** The next step of the turn: its agent's script, then the `fallback` program. */
  function nextStep(call: RecordedModelCall): ScriptedStep | undefined {
    return agentScripts.get(call.agent ?? '')?.shift() ?? modelOptions.fallback?.(viewOf(call));
  }

  async function answer(modelId: string, options: GenerateOptions): Promise<GenerateResult> {
    const agent = agentOf(textOf(options, 'system'), prompts);
    const role = agent === null ? 'unknown' : 'agent';
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
      throw new Error(`scripted model ${modelId}: a call of an unrecognised agent`);
    }
    await passLatch(call);
    const step = nextStep(call);
    if (step === undefined) {
      throw new Error(`scripted model ${modelId}: no ${agent} step left`);
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
    await step.holdUntil;
    const usage = usageOf(typeof step.usage === 'function' ? step.usage(call) : (step.usage ?? DEFAULT_USAGE));
    if ('toolCalls' in step) {
      const toolCalls = typeof step.toolCalls === 'function' ? step.toolCalls(viewOf(call)) : step.toolCalls;
      return { content: toolCallParts(toolCalls), finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage, warnings: [] };
    }
    return { content: [{ type: 'text', text: step.text }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] };
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
    scriptAgent: (agentName, ...steps) => {
      const script = agentScripts.get(agentName) ?? [];
      script.push(...steps);
      agentScripts.set(agentName, script);
    },
    callsOfAgent: (agentName) => calls.filter((call) => call.agent === agentName),
    recognizeAgents: (next) => {
      prompts = recognizedPrompts(next);
    },
    latch: (runs, agent) => {
      if (activeLatch !== undefined) throw new Error('scripted model: a latch is already waiting');
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      activeLatch = { agent, opened, open, missing: runs };
      return opened;
    },
    reset: () => {
      activeLatch = undefined;
      calls.length = 0;
      agentScripts.clear();
    },
    pendingAgents: () =>
      Object.fromEntries([...agentScripts].map(([agentName, script]) => [agentName, script.length])),
  };
}
