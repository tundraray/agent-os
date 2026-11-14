import deepResearch from './templates/deep-research.json' with { type: 'json' };

/**
 * The templates shipped as data files of the package (design-workflows.md, KD-5). They are raw data:
 * the assembly point passes them through the same `parseTemplates` as any other template.
 */
export const SHIPPED_TEMPLATES: unknown[] = [deepResearch];
