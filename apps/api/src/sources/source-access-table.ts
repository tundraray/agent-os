import type {
  ToolAccessDecision,
  ToolAccessPolicy,
  ToolAccessRequest,
} from '@agent-os/engine';
import type { SourceDeclaration } from '@agent-os/sources';

/** The setting the table is read from (design-catalog-planning.md, Runtime Settings). */
export const SOURCE_ACCESS_TABLE_VARIABLE = 'SOURCE_ACCESS_TABLE';

/**
 * The rights stub of `apps/api` (design-catalog-planning.md, KD-6, «Порт прав и заглушка»): a table «user id → the
 * `sourceId` they may read» from `SOURCE_ACCESS_TABLE`, read once at the server start. A request without a source is
 * allowed; one with a source is allowed only when the source is in the owner's row. Unset or empty means an empty
 * table: nobody has rights, and every investigation runs on model knowledge.
 *
 * An unparseable value or a source the declaration does not name stops the start, naming the user and the source
 * (DC-2).
 */
export class SourceAccessTable implements ToolAccessPolicy {
  private readonly rows: ReadonlyMap<string, ReadonlySet<string>>;

  constructor(value: string | undefined, declaration: SourceDeclaration) {
    this.rows = parseTable(value, declaration);
  }

  decide(request: ToolAccessRequest): ToolAccessDecision {
    if (request.sourceId === null) return 'allowed';
    const row = this.rows.get(request.resourceId);
    return row?.has(request.sourceId) ? 'allowed' : 'access_denied';
  }
}

function parseTable(
  value: string | undefined,
  declaration: SourceDeclaration,
): Map<string, Set<string>> {
  const rows = new Map<string, Set<string>>();
  if (value === undefined || value.trim() === '') return rows;
  const declared = new Set(declaration.map((source) => source.sourceId));
  for (const [userId, sources] of Object.entries(parseObject(value))) {
    rows.set(userId, parseRow(userId, sources, declared));
  }
  return rows;
}

function parseObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${SOURCE_ACCESS_TABLE_VARIABLE} is not valid JSON: expected {"<user id>": ["<sourceId>", …]}`,
      { cause: error },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${SOURCE_ACCESS_TABLE_VARIABLE} must be a JSON object {"<user id>": ["<sourceId>", …]}`,
    );
  }
  return parsed as Record<string, unknown>;
}

function parseRow(
  userId: string,
  sources: unknown,
  declared: ReadonlySet<string>,
): Set<string> {
  if (!isStringList(sources)) {
    throw new Error(
      `${SOURCE_ACCESS_TABLE_VARIABLE}: the row of user ${userId} must be a list of sourceId strings`,
    );
  }
  for (const sourceId of sources) {
    if (!declared.has(sourceId)) {
      throw new Error(
        `${SOURCE_ACCESS_TABLE_VARIABLE}: user ${userId} is given source ${sourceId}, which is not declared ` +
          `(declared: ${[...declared].join(', ')})`,
      );
    }
  }
  return new Set(sources);
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}
