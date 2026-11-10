import type { SourceSchema } from '@agent-os/sources';
import { z } from 'zod';
import { NO_SOURCES_TEXT, type SourcesFieldInput } from '../config/prompt-template.js';
import { SOURCE_FETCH_WORKFLOW } from './gather-key.js';

/** A tool the run may fetch from, as the model sees it: the pair and the JSON schema of its arguments. */
interface FetchToolLine {
  readonly sourceId: string;
  readonly toolName: string;
  readonly argsSchema: Readonly<Record<string, unknown>>;
}

/**
 * The argument schema as JSON schema, in its input form (defaults optional). A descriptor schema that is not a zod schema
 * cannot be described to the model: that is an assembly defect, so it throws naming the pair.
 */
function argsJsonSchema(schema: SourceSchema, pair: { sourceId: string; toolName: string }): Record<string, unknown> {
  if (!(schema instanceof z.ZodType)) {
    throw new Error(`the argument schema of ${pair.sourceId}/${pair.toolName} is not a zod schema: it cannot be described to the model`);
  }
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { io: 'input' });
  return json;
}

/** UTF-8 bytes order as code points do, whatever the locale of the machine; a compare of JS strings goes by UTF-16 units. */
const byCodePoints = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));

/**
 * The value of `{{sources}}` (KD-9, DC-32): one JSON line per tool of this run — a pair the configuration lists, of a
 * source of the run, that the registry resolves for `source.fetch`, the same pairs `gather` admits — by `sourceId`, then
 * `toolName`, in code-point order; the text of a run without sources when there is none. The value is never cut: the
 * load proves it fits (DC-31). A pair whose argument schema is not a zod schema throws, naming the pair.
 */
export function buildSourcesField({ configSources, runSources, resolveTool }: SourcesFieldInput): string {
  const lines: FetchToolLine[] = configSources.flatMap(({ sourceId, toolName }) => {
    if (!runSources.includes(sourceId)) return [];
    const resolved = resolveTool({ workflowType: SOURCE_FETCH_WORKFLOW, sourceId, toolName });
    return resolved === null ? [] : [{ sourceId, toolName, argsSchema: argsJsonSchema(resolved.tool.argsSchema, { sourceId, toolName }) }];
  });
  if (lines.length === 0) return NO_SOURCES_TEXT;
  return lines
    .sort((left, right) => byCodePoints(left.sourceId, right.sourceId) || byCodePoints(left.toolName, right.toolName))
    .map((line) => JSON.stringify(line))
    .join('\n');
}
