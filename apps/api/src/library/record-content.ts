import type { RecordBody } from '@agent-os/contracts';

/** One holder of a model and servers: the agent itself or the coordinator (`executor` `null`), or an executor. */
export interface ContentPart {
  readonly executor: string | null;
  readonly servers: readonly string[];
  readonly model: string;
}

/** Every model of the content with its servers: an agent's one, a workflow's coordinator and executors. */
export function contentParts(body: RecordBody): ContentPart[] {
  if (body.kind === 'agent') {
    return [
      {
        executor: null,
        servers: body.content.servers,
        model: body.content.model,
      },
    ];
  }
  const { coordinator, executors } = body.content;
  return [
    { executor: null, servers: [], model: coordinator.model },
    ...executors.map((executor) => ({
      executor: executor.name,
      servers: executor.servers,
      model: executor.model,
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
