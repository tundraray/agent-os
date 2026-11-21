import { BUILTIN_NAMES } from '@agent-os/contracts';
import type { Messages } from './messages';
import type { Locale } from './pick-locale';

/** A key the server sent names an entry only when the table holds it (design-web.md, KD-6). */
const holds = <T extends object>(table: T, key: string): key is Extract<keyof T, string> => Object.hasOwn(table, key);

/**
 * The name of a library record, or of a role, in the page's language (design-web.md, KD-6; UXRD MC-7): a
 * built-in one still named as it was seeded shows its name in `locale`; a name an administrator gave shows
 * as it is. A role has no `builtinKey` and passes `BUILTIN_ROLE_KEY`: it is known by its name alone.
 */
export function builtinName(named: { builtinKey: string | null; name: string }, locale: Locale): string {
  const { builtinKey, name } = named;
  if (builtinKey === null || !holds(BUILTIN_NAMES, builtinKey)) return name;
  const names = BUILTIN_NAMES[builtinKey];
  return name === names.ru ? names[locale] : name;
}

/** How a tool call reads for the employee: the tool's title and its arguments' labels by key. */
type ToolLabels = { title: string; args: Readonly<Record<string, string>> };

/**
 * The labels of a built-in tool from the catalogue by its name (UXRD MC-9); `null` for a tool the catalogue
 * does not hold, which then reads by its name. `tools` is the page's catalogue (`useMessages().tools`). Only
 * a call with `server === null` is a built-in tool's.
 */
export function builtinToolLabels(tools: Messages['tools'], tool: string): ToolLabels | null {
  return holds(tools, tool) ? tools[tool] : null;
}
