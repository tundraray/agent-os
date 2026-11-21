import { BUILTIN_ROLE_KEY, builtinNameIn } from '@agent-os/contracts';
import { hasMessage, type Messages } from './messages';
import type { Locale } from './pick-locale';

/**
 * The name of a library record, or of a role, in the page's language (design-web.md, KD-6; UXRD MC-7): a
 * built-in one still named as it was seeded shows its name in `locale`; a name an administrator gave shows
 * as it is.
 */
export function builtinName(named: { builtinKey: string | null; name: string }, locale: Locale): string {
  return builtinNameIn(named, locale);
}

/** The name of a role in the page's language: a role has no `builtinKey`, it is known by its name alone. */
export function builtinRoleName(name: string, locale: Locale): string {
  return builtinNameIn({ builtinKey: BUILTIN_ROLE_KEY, name }, locale);
}

/** How a tool call reads for the employee: the tool's title and its arguments' labels by key. */
type ToolLabels = { title: string; args: Readonly<Record<string, string>> };

/**
 * The labels of a built-in tool from the catalogue by its name (UXRD MC-9); `null` for a tool the catalogue
 * does not hold, which then reads by its name. `tools` is the page's catalogue (`useMessages().tools`). Only
 * a call with `server === null` is a built-in tool's.
 */
export function builtinToolLabels(tools: Messages['tools'], tool: string): ToolLabels | null {
  return hasMessage(tools, tool) ? tools[tool] : null;
}

/** A tool call as its block knows it: an MCP call carries its server's title and labels. */
type ToolCall = {
  tool: string;
  server: string | null;
  toolTitle?: string | null;
  argLabels?: Readonly<Record<string, string>>;
};

/**
 * The title and argument labels a tool-call block shows (UXRD MC-9): a built-in tool's from the catalogue,
 * an MCP tool's from its server, sent with the call; without either, the title is the tool's name.
 */
export function toolCallLabels(
  tools: Messages['tools'],
  { tool, server, toolTitle, argLabels }: ToolCall,
): { title: string; args: Readonly<Record<string, string>> | undefined } {
  const builtin = server === null ? builtinToolLabels(tools, tool) : null;
  const mcpTitle = server === null ? null : (toolTitle ?? null);
  return { title: builtin?.title ?? mcpTitle ?? tool, args: builtin?.args ?? argLabels };
}
