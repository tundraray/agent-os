/**
 * Settings of the research engine (design-engine.md, Runtime settings) the assembly point reads from its
 * environment: the package reads none (ADR-0004). One base serves both `resolveModel` and `AnthropicTokenCounter`,
 * so a role call and its count go to the same address.
 */
export interface EngineSettings {
  /** Unversioned provider base: the model client gets `<base>/v1`, the counter `<base>/v1/messages/count_tokens`. */
  readonly anthropicBaseUrl: string;
  /** `ANTHROPIC_API_KEY`; empty when unset — the provider then refuses the call, the start does not stop. */
  readonly anthropicApiKey: string;
}

const BASE_URL_VARIABLE = 'RESEARCH_ANTHROPIC_BASE_URL';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Parses the engine settings from `read` (the assembly point's environment). An empty or unset
 * `RESEARCH_ANTHROPIC_BASE_URL` takes the default; a value that is not an http(s) URL throws naming the variable.
 * The chat agent's base variable is never read: Mastra reads that one for its string models as a base with the version.
 */
export function parseEngineSettings(
  read: (name: string) => string | undefined,
): EngineSettings {
  return {
    anthropicBaseUrl: parseBaseUrl(read(BASE_URL_VARIABLE)),
    anthropicApiKey: read('ANTHROPIC_API_KEY') ?? '',
  };
}

function parseBaseUrl(value: string | undefined): string {
  if (value === undefined || value === '') return DEFAULT_ANTHROPIC_BASE_URL;
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error(
      `${BASE_URL_VARIABLE} must be an http(s) URL without the API version, got "${value}"`,
    );
  }
  return value;
}
