import type { McpTool } from './mcp-tool';

/**
 * The longest shape block in characters — header, text and truncation mark — appended to an MCP tool's
 * description for the model (tool-output-shapes KD-3). A code constant: no setting, no environment variable.
 */
export const TOOL_SHAPE_LIMIT = 1_500;

const SHAPE_HEADER = 'Result structure (structuredContent):';
const SHAPE_TRUNCATED = '(result structure truncated)';

/** Nesting deeper than this is written `unknown`, so a hostile schema cannot exhaust the stack. */
const MAX_SCHEMA_DEPTH = 32;

/** The longest shape text that fits the block whole, and the longest that still leaves room for the mark. */
const TEXT_LIMIT = TOOL_SHAPE_LIMIT - SHAPE_HEADER.length - 1;
const TRUNCATED_TEXT_LIMIT = TEXT_LIMIT - 1 - SHAPE_TRUNCATED.length;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const LOCAL_DEFINITION = /^#\/(?:\$defs|definitions)\/([^/]+)$/;
const TYPE_NAMES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'null']);
const COMBINATIONS = [
  ['anyOf', ' | '],
  ['oneOf', ' | '],
  ['allOf', ' & '],
] as const;

/** The shape block of a tool and whether its text was cut at the limit. */
export interface ShapeBlock {
  readonly block: string;
  readonly truncated: boolean;
}

type Schema = Readonly<Record<string, unknown>>;

/** Thrown by the writer when the next part does not fit: the text stops being read there. */
const OVERFLOW = Symbol('shape text overflow');

/** The text being written, with the length after each whole field — the only places it may be cut. */
class ShapeWriter {
  text = '';
  readonly fieldEnds: number[] = [];

  write(part: string): void {
    if (this.text.length + part.length > TEXT_LIMIT) throw OVERFLOW;
    this.text += part;
  }

  fieldEnd(): void {
    this.fieldEnds.push(this.text.length);
  }
}

/** The root's definitions and the names referenced so far, in the order of their first reference. */
interface Definitions {
  readonly byName: Readonly<Record<string, Schema>>;
  readonly referenced: string[];
}

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function membersOf(schema: Schema, key: string): readonly unknown[] | undefined {
  const members = schema[key];
  return Array.isArray(members) && members.length > 0 ? members : undefined;
}

/** How a schema's text combines its parts, so an array or an intersection knows to parenthesize it. */
function compoundOf(schema: unknown): 'union' | 'intersection' | null {
  if (!isSchema(schema) || typeof schema['$ref'] === 'string' || 'const' in schema) return null;
  const several = (key: string) => (membersOf(schema, key)?.length ?? 0) > 1;
  if (membersOf(schema, 'enum') !== undefined) return several('enum') ? 'union' : null;
  if (membersOf(schema, 'anyOf') !== undefined) return several('anyOf') ? 'union' : null;
  if (membersOf(schema, 'oneOf') !== undefined) return several('oneOf') ? 'union' : null;
  if (membersOf(schema, 'allOf') !== undefined) return several('allOf') ? 'intersection' : null;
  return several('type') ? 'union' : null;
}

/** Writes the shape text of a stored schema by the rules of design-core.md, «Текст формы». */
class ShapeText {
  constructor(
    private readonly writer: ShapeWriter,
    private readonly definitions: Definitions,
  ) {}

  schema(node: unknown, depth: number): void {
    if (!isSchema(node) || depth > MAX_SCHEMA_DEPTH) return this.writer.write('unknown');
    if (typeof node['$ref'] === 'string') return this.ref(node['$ref']);
    if ('const' in node) return this.writer.write(JSON.stringify(node['const']) ?? 'unknown');
    const values = membersOf(node, 'enum');
    if (values !== undefined) return this.writer.write(values.map((value) => JSON.stringify(value)).join(' | '));
    for (const [key, separator] of COMBINATIONS) {
      const members = membersOf(node, key);
      if (members !== undefined) return this.joined(members, separator, depth);
    }
    const types = membersOf(node, 'type');
    if (types === undefined) return this.typed(node, node['type'], depth);
    types.forEach((type, index) => {
      if (index > 0) this.writer.write(' | ');
      this.typed(node, type, depth);
    });
  }

  /** Definitions referenced from the root, then from those definitions, each written once after the root. */
  definitionsAfterRoot(): void {
    const { referenced } = this.definitions;
    for (let index = 0; index < referenced.length; index += 1) {
      const name = referenced[index] ?? '';
      this.writer.write(`; ${name} = `);
      this.schema(this.definitionOf(name), 1);
      this.writer.fieldEnd();
    }
  }

  private typed(schema: Schema, type: unknown, depth: number): void {
    if (type === 'object' || (type === undefined && isSchema(schema['properties']))) {
      return this.object(schema, depth);
    }
    if (type === 'array' || (type === undefined && 'items' in schema)) return this.array(schema, depth);
    this.writer.write(typeof type === 'string' && TYPE_NAMES.has(type) ? type : 'unknown');
  }

  private object(schema: Schema, depth: number): void {
    const properties = isSchema(schema['properties']) ? Object.entries(schema['properties']) : [];
    if (properties.length === 0) {
      const additional = schema['additionalProperties'];
      if (!isSchema(additional)) return this.writer.write('object');
      this.writer.write('Record<string, ');
      this.schema(additional, depth + 1);
      return this.writer.write('>');
    }
    const required = new Set((membersOf(schema, 'required') ?? []).filter((key) => typeof key === 'string'));
    this.writer.write('{ ');
    properties.forEach(([name, property], index) => {
      if (index > 0) this.writer.write(', ');
      const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
      this.writer.write(`${key}${required.has(name) ? '' : '?'}: `);
      this.schema(property, depth + 1);
      this.writer.fieldEnd();
    });
    this.writer.write(' }');
  }

  private array(schema: Schema, depth: number): void {
    if (!('items' in schema)) return this.writer.write('unknown[]');
    const items = schema['items'];
    const parenthesized = compoundOf(items) !== null;
    if (parenthesized) this.writer.write('(');
    this.schema(items, depth + 1);
    this.writer.write(parenthesized ? ')[]' : '[]');
  }

  private joined(members: readonly unknown[], separator: ' | ' | ' & ', depth: number): void {
    members.forEach((member, index) => {
      if (index > 0) this.writer.write(separator);
      const parenthesized = separator === ' & ' && compoundOf(member) === 'union';
      if (parenthesized) this.writer.write('(');
      this.schema(member, depth + 1);
      if (parenthesized) this.writer.write(')');
    });
  }

  /** A reference by the last part of its address; a root definition is queued to be written after the root. */
  private ref(address: string): void {
    const local = LOCAL_DEFINITION.exec(address);
    if (local !== null) {
      const name = local[1] ?? '';
      if (this.definitionOf(name) !== undefined && !this.definitions.referenced.includes(name)) {
        this.definitions.referenced.push(name);
      }
      return this.writer.write(name);
    }
    const name = address.slice(address.lastIndexOf('/') + 1);
    this.writer.write(name === '' || name === '#' ? 'unknown' : name);
  }

  private definitionOf(name: string): Schema | undefined {
    return this.definitions.byName[name];
  }
}

/** The schemas of the root's `definitions` and `$defs` by name; `$defs` wins a name both hold. */
function definitionsOf(root: Schema): Definitions {
  const entries = ['definitions', '$defs'].flatMap((container) => {
    const definitions = root[container];
    return isSchema(definitions) ? Object.entries(definitions) : [];
  });
  const byName = Object.fromEntries(entries.filter((entry): entry is [string, Schema] => isSchema(entry[1])));
  return { byName, referenced: [] };
}

/**
 * The shape block of a declared `outputSchema` (design-core.md, «Описание инструмента для модели», «Текст
 * формы»): the header, the TypeScript-style text and, when the text reached the limit, the mark. The text stops
 * being read at the limit and is cut at the end of the last whole field (DC-3).
 */
export function shapeBlockOf(outputSchema: Readonly<Record<string, unknown>>): ShapeBlock {
  const writer = new ShapeWriter();
  const text = new ShapeText(writer, definitionsOf(outputSchema));
  try {
    text.schema(outputSchema, 0);
    writer.fieldEnd();
    text.definitionsAfterRoot();
    return { block: `${SHAPE_HEADER}\n${writer.text}`, truncated: false };
  } catch (error) {
    if (error !== OVERFLOW) throw error;
    const cut = writer.fieldEnds.filter((end) => end <= TRUNCATED_TEXT_LIMIT).at(-1) ?? 0;
    return { block: `${SHAPE_HEADER}\n${writer.text.slice(0, cut)}\n${SHAPE_TRUNCATED}`, truncated: true };
  }
}

/**
 * The description the model sees (DC-1): the server's description as it is, or — for a tool with a declared
 * shape — the server's description whole, an empty line and the shape block.
 */
export function mcpToolDescription(tool: McpTool): string {
  if (tool.outputSchema === undefined) return tool.description;
  const { block } = shapeBlockOf(tool.outputSchema);
  return tool.description === '' ? block : `${tool.description}\n\n${block}`;
}
