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
export type ScriptedRole = 'plan' | 'controller' | 'worker';

/** A property only the output schema of that role has. */
const ROLE_MARKERS: Readonly<Record<ScriptedRole, string>> = {
  plan: 'readinessCriteria',
  controller: 'kind',
  worker: 'claims',
};

/** Token usage the double reports for a call. */
export interface ScriptedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One answer of the script. */
export type ScriptedStep =
  /** A structured output (any JSON value: a test may script one the schema refuses). */
  | { readonly output: unknown; readonly usage?: ScriptedUsage }
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
  return {
    inputTokens: { total: usage.inputTokens, noCache: usage.inputTokens, cacheRead: 0, cacheWrite: 0 },
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

function textOf(options: GenerateOptions, role: 'system' | 'user'): string {
  return options.prompt
    .flatMap((message) => {
      if (message.role !== role) return [];
      if (typeof message.content === 'string') return [message.content];
      return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
    })
    .join('\n');
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

export function createScriptedModel(): ScriptedModel {
  const calls: RecordedModelCall[] = [];
  const scripts: Record<ScriptedRole, ScriptedStep[]> = { plan: [], controller: [], worker: [] };

  async function answer(modelId: string, options: GenerateOptions): Promise<GenerateResult> {
    const role = roleOf(options);
    calls.push({ role, modelId, system: textOf(options, 'system'), user: textOf(options, 'user') });
    if (role === 'unknown') {
      throw new Error(`scripted model ${modelId}: a call of an unscripted role`);
    }
    const step = scripts[role].shift() ?? (role === 'plan' ? { output: DEFAULT_PLAN } : undefined);
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
    return {
      content: [{ type: 'text', text: JSON.stringify(step.output) }],
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage: usageOf(step.usage ?? DEFAULT_USAGE),
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
    },
    pending: () => ({ plan: scripts.plan.length, controller: scripts.controller.length, worker: scripts.worker.length }),
  };
}
