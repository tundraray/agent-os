import * as Sentry from '@sentry/nestjs';
import {
  consoleSink,
  createLogger,
  rememberSecret,
  sentrySink,
  type LogLevel,
  type Logger,
} from '@agent-os/common';

/** Nest token of the application logger (`Logger` from `@agent-os/common`). */
export const APP_LOGGER = Symbol('APP_LOGGER');

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Builds the one application logger: console and Sentry sinks, the settings' secrets redacted
 * (design-runtime.md, KD-6, Security «Sensitive Data Handling»). Model provider keys live in the
 * database; the process's secret memory redacts them (model-providers KD-7). An invalid `LOG_LEVEL`
 * stops the start.
 */
export function createAppLogger(env: NodeJS.ProcessEnv): Logger {
  const secrets = collectSecrets(env);
  // One masker list: the extraction's mask (`createSecretMasker([])`) hides what this logger hides.
  for (const secret of secrets) rememberSecret(secret);
  return createLogger({
    sinks: [consoleSink(), sentrySink(Sentry)],
    secrets,
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

function collectSecrets(env: NodeJS.ProcessEnv): string[] {
  const secrets = [env.SENTRY_DSN, ...databasePassword(env.DATABASE_URL)];
  return [...new Set(secrets.filter((secret): secret is string => !!secret))];
}

/** The password of the connection string, as written and decoded; nothing when the URL has none. */
function databasePassword(databaseUrl: string | undefined): string[] {
  if (!databaseUrl || !URL.canParse(databaseUrl)) return [];
  const { password } = new URL(databaseUrl);
  if (!password) return [];
  return [password, decodeURIComponent(password)];
}
