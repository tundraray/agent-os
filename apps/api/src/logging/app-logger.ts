import * as Sentry from '@sentry/nestjs';
import {
  consoleSink,
  createLogger,
  sentrySink,
  type LogLevel,
  type Logger,
} from '@agent-os/common';

/** Nest token of the application logger (`Logger` from `@agent-os/common`). */
export const APP_LOGGER = Symbol('APP_LOGGER');

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Builds the one application logger: console and Sentry sinks, the settings' secrets redacted
 * (design-runtime.md, KD-6, Security «Sensitive Data Handling»), plus `extraSecrets` (design-agents.md:
 * the values of the MCP servers' environment). An invalid `LOG_LEVEL` stops the start.
 */
export function createAppLogger(
  env: NodeJS.ProcessEnv,
  extraSecrets: readonly string[] = [],
): Logger {
  return createLogger({
    sinks: [consoleSink(), sentrySink(Sentry)],
    secrets: collectSecrets(env, extraSecrets),
    minLevel: readLogLevel(env.LOG_LEVEL),
  });
}

function readLogLevel(value: string | undefined): LogLevel {
  if (!value) return 'debug';
  const level = LOG_LEVELS.find((candidate) => candidate === value);
  if (!level) {
    throw new Error(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${value}"`,
    );
  }
  return level;
}

function collectSecrets(
  env: NodeJS.ProcessEnv,
  extraSecrets: readonly string[],
): string[] {
  const secrets = [
    env.ANTHROPIC_API_KEY,
    env.SENTRY_DSN,
    ...databasePassword(env.DATABASE_URL),
    ...extraSecrets,
  ];
  return [...new Set(secrets.filter((secret): secret is string => !!secret))];
}

/** The password of the connection string, as written and decoded; nothing when the URL has none. */
function databasePassword(databaseUrl: string | undefined): string[] {
  if (!databaseUrl || !URL.canParse(databaseUrl)) return [];
  const { password } = new URL(databaseUrl);
  if (!password) return [];
  return [password, decodeURIComponent(password)];
}
