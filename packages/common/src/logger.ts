export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

/** A record after expansion, redaction and truncation; the only thing a sink sees. */
export interface LogRecord {
  time: string;
  level: LogLevel;
  message: string;
  fields: LogFields;
}

export interface LogSink {
  write(record: LogRecord): void;
}

/** Injection token of the application `Logger`: a plain symbol, bound by the composition root. */
export const LOGGER = Symbol('LOGGER');

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  sinks: LogSink[];
  /** Secret values from settings; every occurrence of one at least `MIN_SECRET_VALUE_LENGTH` long is redacted. */
  secrets: string[];
  minLevel: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const REDACTED = '[redacted]';
const MAX_STRING_BYTES = 16 * 1024;
// Shorter values collide with ordinary words (`agent`); such secrets are still redacted by field name.
const MIN_SECRET_VALUE_LENGTH = 8;
const SECRET_FIELD_NAMES = new Set([
  'password',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'authorization',
  'cookie',
  'dsn',
  'clientsecret',
  'idtoken',
  'codeverifier',
  'sessiontoken',
  'currentpassword',
  'newpassword',
  'sharedtoken',
  'tokens',
]);

/** Whether a field of this name holds a secret (case-insensitive); the logger and the audit log redact it. */
export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD_NAMES.has(name.toLowerCase());
}

// The process's secret memory: only grows, so a replaced key stays redacted (design-core.md, KD-7).
const rememberedSecrets = new Set<string>();

/**
 * Adds a secret read or accepted while the process runs (a provider key) to the process's memory;
 * every masker from `createSecretMasker` redacts it from now on. A value shorter than
 * `MIN_SECRET_VALUE_LENGTH` is not kept.
 */
export function rememberSecret(value: string): void {
  if (value.length >= MIN_SECRET_VALUE_LENGTH) rememberedSecrets.add(value);
}

/**
 * The logger's redaction by value outside the log: replaces every occurrence of a secret at least
 * `MIN_SECRET_VALUE_LENGTH` long — of its own list and of the process's memory at the time of the
 * call — with `[redacted]`. Does not truncate.
 */
export function createSecretMasker(
  secrets: readonly string[],
): (text: string) => string {
  const kept = secrets.filter(
    (secret) => secret.length >= MIN_SECRET_VALUE_LENGTH,
  );
  return (text) => {
    let masked = text;
    for (const secret of kept) masked = masked.replaceAll(secret, REDACTED);
    for (const secret of rememberedSecrets)
      masked = masked.replaceAll(secret, REDACTED);
    return masked;
  };
}

type Mask = (text: string) => string;

export function createLogger(options: LoggerOptions): Logger {
  const mask = createSecretMasker(options.secrets);
  const minOrder = LEVEL_ORDER[options.minLevel];

  function emit(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < minOrder) return;
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      message: cleanString(message, mask),
      fields: cleanFields(expandErrorField(fields), mask),
    };
    for (const sink of options.sinks) sink.write(record);
  }

  function build(bound: LogFields): Logger {
    const at =
      (level: LogLevel) =>
      (message: string, fields?: LogFields): void =>
        emit(level, message, { ...bound, ...fields });
    return {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: (fields) => build({ ...bound, ...fields }),
    };
  }

  return build({});
}

function expandErrorField(fields: LogFields): LogFields {
  if (!('error' in fields)) return fields;
  return { ...fields, error: expandError(fields.error, new Set()) };
}

/** How the message of Drizzle's `DrizzleQueryError` starts. */
const FAILED_QUERY = 'Failed query: ';

/**
 * A failed database query (Drizzle's `DrizzleQueryError`: `query`, `params` and the message
 * `Failed query: …\nparams: …`) carries the bound values — password and token hashes, client secrets.
 * Returns an error with the query text only, the same stack frames and the same cause (the driver
 * error); any other value as it is. Every logged error passes here.
 */
export function withoutQueryParams<T>(error: T): T | Error {
  if (!(error instanceof Error) || !('params' in error) || !('query' in error))
    return error;
  const header = `${error.name}: ${error.message}`;
  const frames = error.stack?.startsWith(header)
    ? error.stack.slice(header.length)
    : '';
  const safe = new Error(`${FAILED_QUERY}${String(error.query)}`, {
    cause: error.cause,
  });
  safe.name = error.name;
  safe.stack = `${safe.name}: ${safe.message}${frames}`;
  return safe;
}

/**
 * An error's text safe to keep outside the log — a task's failure, a tool error the model reads, a
 * history entry: for a failed database query the database's own message (its cause), never the
 * query or its params; any other error's message; any other thrown value as text. Not masked.
 */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if ('params' in error && 'query' in error)
    return error.cause instanceof Error ? error.cause.message : 'Failed query';
  return error.message;
}

/**
 * The same for a message that is already text (a Sentry event of an error the SDK captured by itself):
 * a failed query's message without its `\nparams: …` tail; any other text as it is.
 */
export function withoutQueryParamsText(message: string): string {
  if (!message.startsWith(FAILED_QUERY)) return message;
  return message.split('\nparams: ', 1)[0] ?? message;
}

/** Expands any thrown value into `{ name, message, stack, cause }`, following the cause chain. */
function expandError(thrown: unknown, seen: Set<unknown>): LogFields {
  const value = withoutQueryParams(thrown);
  if (!(value instanceof Error)) return { message: String(value) };
  seen.add(thrown).add(value);
  const expanded: LogFields = {
    name: value.name,
    message: value.message,
    stack: value.stack,
  };
  if (value.cause !== undefined && !seen.has(value.cause)) {
    expanded.cause = expandError(value.cause, seen);
  }
  return expanded;
}

function cleanFields(fields: LogFields, mask: Mask): LogFields {
  return cleanValue(fields, mask, new WeakSet()) as LogFields;
}

function cleanValue(
  value: unknown,
  mask: Mask,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return cleanString(value, mask);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => cleanValue(item, mask, seen));
  const cleaned: LogFields = {};
  for (const [key, item] of Object.entries(value)) {
    cleaned[key] = isSecretFieldName(key)
      ? REDACTED
      : cleanValue(item, mask, seen);
  }
  return cleaned;
}

function cleanString(text: string, mask: Mask): string {
  return truncate(mask(text));
}

function truncate(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_STRING_BYTES) return text;
  // stream: true holds back a code point split at the cut, so only whole characters are kept.
  const kept = new TextDecoder().decode(bytes.subarray(0, MAX_STRING_BYTES), {
    stream: true,
  });
  const keptBytes = new TextEncoder().encode(kept).length;
  return `${kept}…[truncated ${bytes.length - keptBytes} bytes]`;
}
