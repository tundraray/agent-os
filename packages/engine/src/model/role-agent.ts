import { Agent } from '@mastra/core/agent';
import { noopLogger } from '@mastra/core/logger';
import type { z } from 'zod';
import type { RoleModel } from '../ports.js';
import type { RoleEffort, RoleMessage } from './token-counter.js';

/** What one role call sends through its agent. */
export interface RoleCall<T> {
  readonly role: string;
  readonly model: RoleModel;
  readonly instructions: string;
  readonly messages: readonly RoleMessage[];
  readonly outputSchema: z.ZodType<T>;
  readonly effort: RoleEffort;
  readonly maxOutputTokens: number;
}

/** Usage fields of a result as Mastra reports them; a field the provider did not report is null. */
export interface ReportedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
}

/** A resolved `generate`: its finish reason, structured output (not yet checked) and usage. */
export interface RoleGeneration {
  readonly finishReason: string | undefined;
  readonly object: unknown;
  readonly usage: ReportedUsage;
}

/**
 * The model client of `ModelGateway`: one `generate` of a role agent. A provider error rejects
 * (`AI_APICallError`); an aborted call or a refusal resolves (design-engine.md, Error handling).
 */
export interface RoleModelClient {
  generate<T>(call: RoleCall<T>, signal: AbortSignal): Promise<RoleGeneration>;
}

/**
 * The agent of one role call (KD-7): a plain Mastra `Agent` without a `Mastra` instance or memory,
 * on the model instance from `resolveModel`. `errorProcessorDefaults: false` drops Mastra's default
 * error processors, which retry a provider error on their own past any reservation — so one
 * `generate` is one request and only `ModelGateway` retries. `noopLogger` silences Mastra's console
 * line on a provider error, which carries the request body with the prompt.
 */
function createRoleAgent<T>(call: RoleCall<T>): Agent {
  const agent = new Agent({
    id: `research-${call.role}`,
    name: `Research ${call.role}`,
    instructions: call.instructions,
    model: call.model,
    errorProcessorDefaults: false,
  });
  agent.__setLogger(noopLogger);
  return agent;
}

/** The production client: one role agent per call, structured output in the native JSON format. */
export const mastraRoleModelClient: RoleModelClient = {
  async generate(call, signal) {
    const messages = call.messages.map(({ role, content }) =>
      role === 'user'
        ? { role: 'user' as const, content }
        : { role: 'assistant' as const, content },
    );
    const result = await createRoleAgent(call).generate(messages, {
      // `warn` resolves an output the schema refuses instead of rejecting; ModelGateway checks it.
      structuredOutput: { schema: call.outputSchema, errorStrategy: 'warn' },
      modelSettings: { maxOutputTokens: call.maxOutputTokens },
      providerOptions: { anthropic: { effort: call.effort } },
      abortSignal: signal,
    });
    const { usage } = result;
    return {
      finishReason: result.finishReason,
      object: result.object,
      usage: {
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        cachedInputTokens: usage.cachedInputTokens ?? null,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? null,
      },
    };
  },
};
