import type { ToolAccessPolicy } from '@agent-os/engine';

/**
 * Doubles of the rights port (`SOURCE_ACCESS_POLICY`, design-catalog-planning.md, KD-6) for test servers that run
 * investigations on connected sources and do not check rights themselves: the default `SourceAccessTable` is empty,
 * so without a double every source would be refused.
 */

/** Allows every request: every owner may read every source. */
export const ALLOW_ALL_ACCESS: ToolAccessPolicy = {
  decide: () => 'allowed',
};
