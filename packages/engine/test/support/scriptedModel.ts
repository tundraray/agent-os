import type { ResolveModel, RoleModel } from '@agent-os/engine';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

/**
 * The model double of the integration file (design-engine.md, Test Strategy): a `MockLanguageModelV4` per model id that
 * the test `resolveModel` returns. It implements `doGenerate` — the role agent's call is one non-streaming request with
 * the native `json_schema` output (KD-7) — and answers from a script per role, recording every call. Step 1 of task-09
 * showed the real `Agent` over it behaves as over the provider: one `doGenerate` per `generate`, also when it throws.
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
  readonly role: ScriptedRole | 'unknown';
  readonly modelId: string;
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
  /** Empties the calls and every role's script: each test starts from a clean double. */
  reset(): void;
  /** Steps of each role's script not consumed yet: a test that left steps scripted more than happened. */
  pending(): Record<ScriptedRole, number>;
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

/** The input of a verifier call as `buildClaimCheck` lays it out: the claim text, then each given record with its number. */
export interface VerifierPacket {
  readonly claimText: string;
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
 * Reads a verifier packet by its structure only: the claim JSON in `<claim>` and, in `<data>`, the JSON lines of the
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
  return { claimText: (JSON.parse(claim) as { text: string }).text, records };
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

  async function answer(modelId: string, options: GenerateOptions): Promise<GenerateResult> {
    const role = roleOf(options);
    const call: RecordedModelCall = {
      role,
      modelId,
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
    const step = scripts[role].shift() ?? modelOptions.fallback?.(call) ?? (role === 'plan' ? { output: DEFAULT_PLAN } : undefined);
    if (step === undefined) {
      throw new Error(`scripted model ${modelId}: no ${role} step left`);
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
    return {
      content: [{ type: 'text', text: JSON.stringify(asSent(role, typeof step.output === 'function' ? step.output(call) : step.output)) }],
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage: usageOf(typeof step.usage === 'function' ? step.usage(call) : (step.usage ?? DEFAULT_USAGE)),
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
    reset: () => {
      calls.length = 0;
      scripts.plan.length = 0;
      scripts.controller.length = 0;
      scripts.worker.length = 0;
      scripts.verifier.length = 0;
      scripts.synthesis.length = 0;
    },
    pending: () => ({
      plan: scripts.plan.length,
      controller: scripts.controller.length,
      worker: scripts.worker.length,
      verifier: scripts.verifier.length,
      synthesis: scripts.synthesis.length,
    }),
  };
}
