/** An `agents` message a row value reads as: the yes/no of a boolean, a code run's class in words. */
export type RowValueKey = "values.yes" | "values.no" | "runCode.class.read" | "runCode.class.write";

/**
 * A value as a row shows it: plain text, compact JSON in the monospace style on its own line, or a word of
 * the page's language that `ValueRows` translates.
 */
export type RowValue = { kind: "text" | "json"; text: string } | { kind: "message"; key: RowValueKey };

const EMPTY = "—";

/** One value of an arguments or result object, as the employee reads it. */
function formatValue(value: unknown): RowValue {
  if (value === null || value === undefined || value === "") return { kind: "text", text: EMPTY };
  if (typeof value === "boolean") return { kind: "message", key: value ? "values.yes" : "values.no" };
  if (typeof value === "object") return { kind: "json", text: JSON.stringify(value) };
  return { kind: "text", text: String(value) };
}

export type ValueRow = { key: string; label: string; value: RowValue };

/**
 * Rows «label — value» of an object, one per top-level key in the order sent; the label is the key's
 * entry in `labels`, or the key itself. An object without keys has no rows. Null when `value` is not
 * an object: it is then shown as it is.
 */
export function valueRows(value: unknown, labels: Readonly<Record<string, string>> = {}): ValueRow[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.entries(value).map(([key, item]) => ({ key, label: labels[key] ?? key, value: formatValue(item) }));
}

/** The rows of a flat object with keys — one whose values are not objects or arrays; null for anything else. */
export function flatRows(value: unknown): ValueRow[] | null {
  const rows = valueRows(value);
  return rows === null || rows.length === 0 || rows.some((row) => row.value.kind === "json") ? null : rows;
}
