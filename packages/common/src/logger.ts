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

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

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
]);

/** Whether a field of this name holds a secret (case-insensitive); the logger and the audit log redact it. */
export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD_NAMES.has(name.toLowerCase());
}

/**
 * The logger's redaction by value outside the log: replaces every occurrence of a secret at least
 * `MIN_SECRET_VALUE_LENGTH` long with `[redacted]`. Does not truncate.
 */
export function createSecretMasker(secrets: readonly string[]): (text: string) => string {
  const kept = secrets.filter((secret) => secret.length >= MIN_SECRET_VALUE_LENGTH);
  return (text) => {
    let masked = text;
    for (const secret of kept) masked = masked.replaceAll(secret, REDACTED);
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

/** Expands any thrown value into `{ name, message, stack, cause }`, following the cause chain. */
function expandError(value: unknown, seen: Set<unknown>): LogFields {
  if (!(value instanceof Error)) return { message: String(value) };
  seen.add(value);
  const expanded: LogFields = { name: value.name, message: value.message, stack: value.stack };
  if (value.cause !== undefined && !seen.has(value.cause)) {
    expanded.cause = expandError(value.cause, seen);
  }
  return expanded;
}

function cleanFields(fields: LogFields, mask: Mask): LogFields {
  return cleanValue(fields, mask, new WeakSet()) as LogFields;
}

function cleanValue(value: unknown, mask: Mask, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return cleanString(value, mask);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => cleanValue(item, mask, seen));
  const cleaned: LogFields = {};
  for (const [key, item] of Object.entries(value)) {
    cleaned[key] = isSecretFieldName(key) ? REDACTED : cleanValue(item, mask, seen);
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
  const kept = new TextDecoder().decode(bytes.subarray(0, MAX_STRING_BYTES), { stream: true });
  const keptBytes = new TextEncoder().encode(kept).length;
  return `${kept}…[truncated ${bytes.length - keptBytes} bytes]`;
}
