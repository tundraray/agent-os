import { storedMcpTools } from './mcp-tool';
import { mcpToolDescription, TOOL_SHAPE_LIMIT } from './tool-shape';

// tool-output-shapes design-core.md UC-1, UC-2: AC-02.1, AC-02.2, AC-03.1 (the rule), AC-03.2 (before the
// refresh), DC-1 (the server's description unchanged, an empty line, the block), DC-2 (the same schema gives
// the same text), DC-3 (the block within the limit, cut at the end of a field).

const SERVER_DESCRIPTION = 'Searches tickets.';
const HEADER = 'Result structure (structuredContent):';
const TRUNCATED = '(result structure truncated)';

/** An item of a stored tool list, as `storedMcpTools` reads it from `mcp_servers.tools`. */
function stored(outputSchema?: Record<string, unknown>): unknown {
  return {
    name: 'mcp__tracker__search_tickets',
    server: 'tracker',
    tool: 'search_tickets',
    description: SERVER_DESCRIPTION,
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    display: {},
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

function descriptionOf(item: unknown): string {
  const [tool] = storedMcpTools([item]) ?? [];
  if (tool === undefined) throw new Error('the stored list is empty');
  return mcpToolDescription(tool);
}

function withShape(text: string): string {
  return `${SERVER_DESCRIPTION}\n\n${HEADER}\n${text}`;
}

/** An object with `count` required fields `fieldNNN: string`. */
function wideObject(count: number): Record<string, unknown> {
  const names = Array.from(
    { length: count },
    (_, i) => `field${String(i).padStart(3, '0')}`,
  );
  return {
    type: 'object',
    properties: Object.fromEntries(
      names.map((name) => [name, { type: 'string' }]),
    ),
    required: names,
  };
}

/** The first `count` fields of `wideObject`, as the text writes them. */
function wideFields(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `field${String(i).padStart(3, '0')}: string`,
  ).join(', ');
}

/** 200 fields of 15 characters each: far over the limit. */
const LONG_SCHEMA = wideObject(200);
/**
 * The header (37), a new line, the text cut after the end of field 79 (`{ ` and 79 fields: 1 422), a new
 * line, the mark (28): 1 489 ≤ 1 500; field 80 would leave no room for the mark.
 */
const LONG_TEXT = `{ ${wideFields(79)}\n${TRUNCATED}`;

const RECURSIVE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { root: { $ref: '#/$defs/Node' } },
  required: ['root'],
  $defs: {
    Node: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        children: { type: 'array', items: { $ref: '#/$defs/Node' } },
      },
      required: ['name', 'children'],
    },
    Unused: { type: 'string' },
  },
};

describe('builds the model description of an MCP tool from its stored shape (AC-02.1, AC-02.2, AC-03.1, AC-03.2, DC-1..3)', () => {
  it.each([
    [
      'a nested object with an array of objects and a nullable field',
      stored({
        type: 'object',
        properties: {
          order: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  payments: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        amount: { type: 'number' },
                        failureReason: {
                          anyOf: [{ type: 'string' }, { type: 'null' }],
                        },
                      },
                      required: ['amount', 'failureReason'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['id', 'payments'],
                additionalProperties: false,
              },
              { type: 'null' },
            ],
          },
          snapshot: { type: 'string' },
        },
        required: ['order', 'snapshot'],
      }),
      withShape(
        '{ order: { id: string, payments: { amount: number, failureReason: string | null }[] } | null, snapshot: string }',
      ),
    ],
    [
      'an optional field, an enum, a type list and a map',
      stored({
        type: 'object',
        properties: {
          status: { enum: ['open', 'closed'] },
          total: { type: 'integer' },
          closedAt: { type: ['string', 'null'] },
          tags: { type: 'object', additionalProperties: { type: 'boolean' } },
          relation: { const: 'eq' },
        },
        required: ['status', 'closedAt', 'tags', 'relation'],
      }),
      withShape(
        '{ status: "open" | "closed", total?: integer, closedAt: string | null, tags: Record<string, boolean>, relation: "eq" }',
      ),
    ],
    [
      'a root that is an array',
      stored({
        type: 'array',
        items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      }),
      withShape('(string | number)[]'),
    ],
    [
      'a recursive $ref through $defs',
      stored(RECURSIVE),
      withShape('{ root: Node }; Node = { name: string, children: Node[] }'),
    ],
    [
      'an unknown keyword and service keys',
      stored({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'Answer',
        description: 'The answer.',
        type: 'object',
        properties: {
          when: { type: 'string', format: 'date-time', description: 'When.' },
          odd: { not: { type: 'string' } },
          bag: { type: 'object' },
          list: { type: 'array' },
        },
        required: ['when', 'odd', 'bag', 'list'],
        additionalProperties: false,
      }),
      withShape('{ when: string, odd: unknown, bag: object, list: unknown[] }'),
    ],
    [
      'a shape longer than the limit',
      stored(LONG_SCHEMA),
      withShape(LONG_TEXT),
    ],
    ['a short shape', stored(wideObject(3)), withShape(`{ ${wideFields(3)} }`)],
    ['an item of a list stored before shapes', stored(), SERVER_DESCRIPTION],
  ])('%s', (_case, item, expected) => {
    const description = descriptionOf(item);
    expect(description).toBe(expected);
    // DC-2: the same stored schema gives the same text on every read.
    expect(descriptionOf(item)).toBe(description);
    // DC-3: the block — everything after the server's description — stays within the limit.
    expect(description.length - SERVER_DESCRIPTION.length).toBeLessThanOrEqual(
      TOOL_SHAPE_LIMIT + 2,
    );
  });
});
