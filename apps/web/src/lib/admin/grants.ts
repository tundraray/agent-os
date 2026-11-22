import type { Grant, GrantTarget } from '@agent-os/contracts';

type Named = { name: string };

/**
 * DC-13: ids of the grants whose server is gone from the registry, or whose tool is gone from the `tools`
 * of its server's record. A tool grant whose server record is not read yet is not judged; a model grant
 * is never an orphan (the catalogue removes its grants with the model).
 */
export function orphanGrantIds(
  grants: readonly Grant[],
  servers: readonly Named[],
  toolsByServer: ReadonlyMap<string, readonly Named[]>,
): ReadonlySet<string> {
  const registered = new Set(servers.map((server) => server.name));
  const orphans = new Set<string>();
  for (const { id, target } of grants) {
    if (target.kind === 'model') continue;
    if (!registered.has(target.server)) {
      orphans.add(id);
      continue;
    }
    const tools = toolsByServer.get(target.server);
    if (
      target.kind === 'tool' &&
      tools !== undefined &&
      !tools.some((tool) => tool.name === target.tool)
    ) {
      orphans.add(id);
    }
  }
  return orphans;
}

/** Names of the registry servers that tool grants point at: the screen reads these records for their `tools`. */
export function serversToRead(
  grants: readonly Grant[],
  servers: readonly Named[],
): string[] {
  const registered = new Set(servers.map((server) => server.name));
  const names = new Set<string>();
  for (const { target } of grants) {
    if (target.kind === 'tool' && registered.has(target.server))
      names.add(target.server);
  }
  return [...names];
}

/** The grant's target as the rights table reads it: «{сервер}», «{сервер} → {инструмент}» or the model's name. */
export function grantTargetText(target: GrantTarget): string {
  switch (target.kind) {
    case 'server':
      return target.server;
    case 'tool':
      return `${target.server} → ${target.tool}`;
    case 'model':
      return target.modelName;
  }
}
