/** The workflow type whose allowlist the declaration is: `source.fetch` may call every declared tool. */
export const SOURCE_FETCH_WORKFLOW = 'source.fetch';

/** Upper bound of a source description, in characters (design-catalog-planning.md, Объявление). */
export const SOURCE_DESCRIPTION_MAX_CHARS = 600;
/** Upper bound of a tool description, in characters. */
export const TOOL_DESCRIPTION_MAX_CHARS = 300;

export interface DeclaredTool {
  readonly name: string;
  /** What the tool returns and how to ask it; 1–300 characters. The server's own text is never read. */
  readonly description: string;
}

export interface DeclaredSource {
  readonly sourceId: string;
  /** What the source holds, which questions it answers, its limits; 1–600 characters. */
  readonly description: string;
  readonly tools: readonly DeclaredTool[];
}

/**
 * The project's declaration of its sources (KD-2): the single place their descriptions live. Its tools are the
 * `source.fetch` allowlist; `createSources` checks it against the adapters at startup.
 */
export type SourceDeclaration = readonly DeclaredSource[];
