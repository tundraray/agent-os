import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentDefinition } from '../config/agent-config.schema.js';
import type { AgentToolDefinition } from '../model/role-agent.js';

/** Orders by code points, the same on every machine (no locale). */
const byCodePoint = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** 12 hex digits of the SHA-256 of a canonical JSON text. */
function shortSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

/** What an agent fingerprint is computed over, besides the definition: its tools as the model sees them and its form. */
export interface AgentFingerprintInput {
  readonly definition: Pick<AgentDefinition, 'model' | 'effort' | 'prompt'> & {
    readonly limits: Pick<AgentDefinition['limits'], 'maxOutputTokens'>;
  };
  /** The definition's tools with `finish`, as `agentToolsOf` gives them. */
  readonly tools: readonly AgentToolDefinition[];
  readonly form: { readonly name: string; readonly version: number };
}

/**
 * `agentFingerprint` (design-agent-core.md, Операции движка): 12 hex digits of SHA-256 over the model, effort, prompt
 * template, the names and schemas of the tools, the result form's name and `version`, and the output cap. Tools count
 * as a set: their order in the definition does not change it.
 */
export function agentFingerprint(input: AgentFingerprintInput): string {
  const tools = [...input.tools]
    .sort((left, right) => byCodePoint(left.name, right.name))
    .map((tool) => [tool.name, z.toJSONSchema(tool.inputSchema)]);
  return shortSha256({
    model: input.definition.model,
    effort: input.definition.effort,
    prompt: input.definition.prompt,
    tools,
    form: [input.form.name, input.form.version],
    maxOutputTokens: input.definition.limits.maxOutputTokens,
  });
}

/** An entry of a definition memory snapshot. */
export interface SnapshotEntry {
  readonly id: string;
  readonly scope: 'deployment' | 'user';
  readonly text: string;
}

/** A definition memory snapshot as an engine row stores it: the entries each agent sees, by agent name (DC-24). */
export const SnapshotSchema = z.record(
  z.string(),
  z.array(z.object({ id: z.string(), scope: z.enum(['deployment', 'user']), text: z.string() })),
);

/**
 * `definitionMemoryFingerprint` (design-agent-core.md, Операции движка): 12 hex digits of SHA-256 over the ids and
 * texts of the `deployment` entries of a snapshot in id order. `user` entries do not count; an empty snapshot has a
 * fingerprint too.
 */
export function definitionMemoryFingerprint(entries: readonly SnapshotEntry[]): string {
  const deployment = entries
    .filter((entry) => entry.scope === 'deployment')
    .sort((left, right) => byCodePoint(left.id, right.id))
    .map((entry) => [entry.id, entry.text]);
  return shortSha256(deployment);
}
