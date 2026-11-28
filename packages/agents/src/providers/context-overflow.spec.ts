// design-steps.md KD-4, «Как адаптер узнаёт переполнение»; AC-02.5, AC-02.4 (rule). Pure rule: one recorded body per provider row of the table and one other 400 per adapter kind.
// The adapters and `classifyRejection` are real; no network. The wiring (model step, compaction) is INT-3 of packages/agents/test/runtime-fixes-steps.int.e2e-spec.ts, which uses ONE overflow body, not these variants.
// Catches: a recognised status alone (any 400 starting a compaction); the rule reading fields in the wrong place (`error` vs the body root); a provider's text change that goes unseen; the overflow
//   rule placed after the tools rule, which takes the body first.
// @category: edge-case  @dependency: none  @complexity: low
import type { ModelProviderKind } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';

import {
  type ProviderRejectionReason,
  classifyRejection,
} from '../model/provider-rejection';
import { providerAdapter } from './adapters';

interface Row {
  readonly name: string;
  readonly kind: ModelProviderKind;
  readonly status: number;
  readonly body: string;
  readonly reason: ProviderRejectionReason;
}

const ANTHROPIC_OVERFLOW = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'prompt is too long: 213462 tokens > 200000 maximum',
  },
});

const OPENAI_OVERFLOW = JSON.stringify({
  error: {
    message:
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.",
    type: 'invalid_request_error',
    param: 'messages',
    code: 'context_length_exceeded',
  },
});

const ROWS: readonly Row[] = [
  {
    name: 'Anthropic overflow',
    kind: 'anthropic',
    status: 400,
    body: ANTHROPIC_OVERFLOW,
    reason: 'context_overflow',
  },
  {
    name: 'Anthropic other invalid request',
    kind: 'anthropic',
    status: 400,
    body: JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'max_tokens: Field required',
      },
    }),
    reason: 'provider_error',
  },
  {
    name: 'OpenAI overflow by code',
    kind: 'openai_compatible',
    status: 400,
    body: OPENAI_OVERFLOW,
    reason: 'context_overflow',
  },
  {
    name: 'Groq overflow by code',
    kind: 'openai_compatible',
    status: 400,
    body: JSON.stringify({
      error: {
        message: 'Please reduce the length of the messages or completion.',
        type: 'invalid_request_error',
        param: 'messages',
        code: 'context_length_exceeded',
      },
    }),
    reason: 'context_overflow',
  },
  {
    name: 'OpenRouter overflow by metadata.error_type',
    kind: 'openai_compatible',
    status: 400,
    body: JSON.stringify({
      error: {
        code: 400,
        message: 'Input is too long for the requested model.',
        metadata: { error_type: 'context_length_exceeded' },
      },
    }),
    reason: 'context_overflow',
  },
  {
    name: 'Mistral overflow by type at the body root',
    kind: 'openai_compatible',
    status: 400,
    body: JSON.stringify({
      object: 'error',
      message: 'Prompt contains 140000 tokens, too large for model.',
      type: 'invalid_request_prompt_too_long',
      param: null,
      code: '3051',
    }),
    reason: 'context_overflow',
  },
  {
    name: 'llama.cpp overflow by type',
    kind: 'openai_compatible',
    status: 400,
    body: JSON.stringify({
      error: {
        code: 400,
        message:
          'the request exceeds the available context size, try increasing it',
        type: 'exceed_context_size_error',
        n_prompt_tokens: 9000,
        n_ctx: 8192,
      },
    }),
    reason: 'context_overflow',
  },
  {
    name: 'vLLM overflow by text at the body root',
    kind: 'openai_compatible',
    status: 400,
    body: JSON.stringify({
      object: 'error',
      message:
        "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens.",
      type: 'BadRequestError',
      param: null,
      code: 400,
    }),
    reason: 'context_overflow',
  },
  {
    name: 'OpenAI code-less overflow by text',
    kind: 'openai_compatible',
    status: 400,
    body: JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 8192 tokens, however you requested 9000 tokens.",
        type: 'invalid_request_error',
      },
    }),
    reason: 'context_overflow',
  },
  {
    name: 'OpenAI-compatible bad max_tokens',
    kind: 'openai_compatible',
    status: 400,
    body: JSON.stringify({
      error: {
        message: 'max_tokens must be at least 1, got -1.',
        type: 'invalid_request_error',
        param: 'max_tokens',
        code: 'invalid_value',
      },
    }),
    reason: 'provider_error',
  },
  {
    name: 'OpenAI-compatible tools body stays the tools rejection',
    kind: 'openai_compatible',
    status: 400,
    body: JSON.stringify({
      error: {
        message: "Invalid schema for function 'search'.",
        type: 'invalid_request_error',
        param: 'tools[0].function.parameters',
        code: 'invalid_function_parameters',
      },
    }),
    reason: 'provider_tools_rejected',
  },
  {
    name: 'Gemini tools body',
    kind: 'gemini',
    status: 400,
    body: JSON.stringify({
      error: {
        code: 400,
        message: 'Invalid JSON payload: function_declarations[0].parameters',
        status: 'INVALID_ARGUMENT',
      },
    }),
    reason: 'provider_tools_rejected',
  },
  {
    name: 'Gemini invalid argument',
    kind: 'gemini',
    status: 400,
    body: JSON.stringify({
      error: {
        code: 400,
        message:
          'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
        status: 'INVALID_ARGUMENT',
      },
    }),
    reason: 'provider_error',
  },
  {
    name: 'a body that is not JSON',
    kind: 'openai_compatible',
    status: 400,
    body: "This model's maximum context length is 4096 tokens",
    reason: 'provider_error',
  },
  {
    name: 'status 500 with an overflow body',
    kind: 'openai_compatible',
    status: 500,
    body: OPENAI_OVERFLOW,
    reason: 'provider_unavailable',
  },
  {
    name: 'status 429 with an overflow body',
    kind: 'anthropic',
    status: 429,
    body: ANTHROPIC_OVERFLOW,
    reason: 'provider_unavailable',
  },
  {
    name: 'status 422 with an overflow body',
    kind: 'openai_compatible',
    status: 422,
    body: OPENAI_OVERFLOW,
    reason: 'provider_error',
  },
];

/** The rejection the provider client gives: `classifyRejection` reads it by `name`, `statusCode` and `responseBody`. */
function apiCallError(statusCode: number, responseBody: string): Error {
  return Object.assign(new Error('provider rejected the request'), {
    name: 'AI_APICallError',
    statusCode,
    responseBody,
  });
}

describe('a provider adapter recognises a context overflow by the body of a 400', () => {
  it.each(ROWS)('$name -> $reason', (row) => {
    const rejection = classifyRejection(
      apiCallError(row.status, row.body),
      providerAdapter(row.kind),
    );

    expect(rejection?.reason).toBe(row.reason);
  });
});
