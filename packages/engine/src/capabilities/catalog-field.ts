import { NO_SOURCES_TEXT, type SourcesFieldInput } from '../config/prompt-template.js';
import { runSourceTools } from './sources-field.js';

/**
 * The value of `{{catalog}}` (design-catalog-planning.md, KD-3, «Поля шаблона»): one JSON line per source of the run — its
 * `sourceId` and declared description, without tools — in code-point order; the text of a run without sources when there
 * is none. The sources are those of `{{sources}}`: of the run, with a pair the registry resolves. The value is never cut:
 * the load proves it fits `CATALOG_FIELD_MAX_BYTES` (DC-4).
 */
export function buildCatalogField(input: SourcesFieldInput): string {
  const sources = runSourceTools(input);
  if (sources.length === 0) return NO_SOURCES_TEXT;
  return sources
    .map(({ sourceId }) => JSON.stringify({ sourceId, description: input.describeSource(sourceId) }))
    .join('\n');
}
