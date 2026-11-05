/**
 * A log line of the package loggers over the Nest `Logger`: the fields follow the message as `key=value`, in the order
 * the package gave them; undefined fields are left out. The packages put only identifiers, counts and outcome classes
 * there, never task input, evidence content, tool arguments or prompts.
 */
export function withFields(message: string, fields?: object): string {
  if (!fields) return message;
  const pairs = Object.entries(fields)
    .filter(([, value]: [string, unknown]) => value !== undefined)
    .map(([key, value]: [string, unknown]) => `${key}=${String(value)}`);
  return pairs.length === 0 ? message : `${message} ${pairs.join(' ')}`;
}
