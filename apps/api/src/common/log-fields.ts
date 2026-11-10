/**
 * A log line of the package loggers over the Nest `Logger`: the fields follow the message as `key=value`, in the order
 * the package gave them; undefined fields are left out. The packages put only identifiers, counts and outcome classes
 * there, never task input, evidence content, tool arguments or prompts. A string value with whitespace or a control
 * character is written as a JSON string literal, so a value taken from a request (a `launchKey`, a `threadId`) cannot
 * forge another field or another line.
 */
export function withFields(message: string, fields?: object): string {
  if (!fields) return message;
  const pairs = Object.entries(fields)
    .filter(([, value]: [string, unknown]) => value !== undefined)
    .map(([key, value]: [string, unknown]) => `${key}=${formatValue(value)}`);
  return pairs.length === 0 ? message : `${message} ${pairs.join(' ')}`;
}

/** Whitespace or a control character (Unicode category Cc): the value is written as a JSON string literal. */
const NEEDS_QUOTING = /[\s\p{Cc}]/u;

function formatValue(value: unknown): string {
  if (typeof value === 'string' && NEEDS_QUOTING.test(value)) {
    return JSON.stringify(value);
  }
  return String(value);
}
