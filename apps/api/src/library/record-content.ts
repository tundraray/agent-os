import type { RecordBody } from '@agent-os/contracts';

/**
 * One holder of a model and servers: the agent or the deep agent itself (`subagent` `null`), or a
 * subagent. A `null` model is the default chat model, resolved at the start (KD-5).
 */
export interface ContentPart {
  readonly subagent: string | null;
  /** Where the part lives in the content: `''` for the record itself, `subagents.N` for a subagent. */
  readonly path: string;
  readonly servers: readonly string[];
  readonly model: string | null;
}

/** The path of a field of a part, as a refusal names it (deep-agents KD-4): `servers`, `subagents.1.model`. */
export function fieldPath(
  part: ContentPart,
  field: 'servers' | 'model',
): string {
  return part.path === '' ? field : `${part.path}.${field}`;
}

/** Every model of the content with its servers: an agent's one, a deep agent's own and its subagents'. */
export function contentParts(body: RecordBody): ContentPart[] {
  const { servers, model } = body.content;
  const own: ContentPart = { subagent: null, path: '', servers, model };
  if (body.kind === 'agent') return [own];
  return [
    own,
    ...body.content.subagents.map((subagent, index) => ({
      subagent: subagent.name,
      path: `subagents.${index}`,
      servers: subagent.servers,
      model: subagent.model,
    })),
  ];
}

/** Names are unique without regard to case, as the unique indexes compare `lower(name)` (DC-8). */
export function isNameTaken(
  name: string,
  takenNames: readonly string[],
): boolean {
  const key = name.toLowerCase();
  return takenNames.some((taken) => taken.toLowerCase() === key);
}
