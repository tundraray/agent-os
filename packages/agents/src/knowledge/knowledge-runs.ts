import type { OwnedKnowledgeRunRow } from '@agent-os/db';
import { z } from 'zod';

/** A run that learns, with the owner of its deep agent session — the starter. */
export interface KnowledgeRun extends Omit<OwnedKnowledgeRunRow, 'servers'> {
  /** Servers of the whole team (`*` kept as is). */
  readonly servers: string[];
}

const ServersSchema = z.array(z.string());

/** A run row read back as a run that learns; `undefined` stays `undefined`. */
export function knowledgeRunOf(
  row: OwnedKnowledgeRunRow | undefined,
): KnowledgeRun | undefined {
  return row === undefined
    ? undefined
    : { ...row, servers: ServersSchema.parse(row.servers) };
}
