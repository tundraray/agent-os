import type { ResolvedSourceTool, SourceSchema } from '@agent-os/sources';
import { z } from 'zod';
import { NO_SOURCES_TEXT, type SourcesFieldInput } from '../config/prompt-template.js';
import { SOURCE_FETCH_WORKFLOW } from './gather-key.js';

/** A source of the run with the tools of it the configuration lists and the registry resolves for `source.fetch`. */
export interface RunSourceTools {
  readonly sourceId: string;
  readonly tools: readonly { readonly toolName: string; readonly resolved: ResolvedSourceTool }[];
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
 * The sources of the run that have a pair the configuration lists and the registry resolves for `source.fetch` — the same
 * pairs `gather` admits — with those tools; sources and tools in code-point order. A source without such a pair is not a
 * source of the fields: the registry does not describe it (design-catalog-planning.md, «Поля шаблона»).
 */
export function runSourceTools({ configSources, runSources, resolveTool }: SourcesFieldInput): readonly RunSourceTools[] {
  const bySource = new Map<string, { toolName: string; resolved: ResolvedSourceTool }[]>();
  for (const { sourceId, toolName } of configSources) {
    if (!runSources.includes(sourceId)) continue;
    const resolved = resolveTool({ workflowType: SOURCE_FETCH_WORKFLOW, sourceId, toolName });
    if (resolved === null) continue;
    bySource.set(sourceId, [...(bySource.get(sourceId) ?? []), { toolName, resolved }]);
  }
  return [...bySource.entries()]
    .sort(([left], [right]) => byCodePoints(left, right))
    .map(([sourceId, tools]) => ({ sourceId, tools: tools.sort((left, right) => byCodePoints(left.toolName, right.toolName)) }));
}

/**
 * The value of `{{sources}}` (design-catalog-planning.md, KD-3, «Поля шаблона»; DC-31, DC-32 of agent-core): one JSON line
 * per source of the run that has resolved pairs — its `sourceId`, its declared description and its tools, each with its
 * `toolName`, declared description and argument schema — sources and tools in code-point order; the text of a run without
 * sources when there is none. The value is never cut: the load proves it fits. A pair whose argument schema is not a zod
 * schema throws, naming the pair.
 */
export function buildSourcesField(input: SourcesFieldInput): string {
  const sources = runSourceTools(input);
  if (sources.length === 0) return NO_SOURCES_TEXT;
  return sources
    .map(({ sourceId, tools }) =>
      JSON.stringify({
        sourceId,
        description: input.describeSource(sourceId),
        tools: tools.map(({ toolName, resolved }) => ({
          toolName,
          description: resolved.description,
          argsSchema: argsJsonSchema(resolved.tool.argsSchema, { sourceId, toolName }),
        })),
      }),
    )
    .join('\n');
}
