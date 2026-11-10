import type { ToolAccessDecision, ToolAccessPolicy, ToolAccessRequest } from '../../src/agents/tool-access-policy.js';

/**
 * The rights-port double of the catalog-planning files (design-catalog-planning.md, Test Strategy): a table «owner → the
 * sources they may read» that a test changes between calls, and the record of every question the engine asked — the
 * independent counter of "the port was not asked". It answers by the rule of the api's `SourceAccessTable`: a request
 * without a source is allowed; one with a source only when the source is in the owner's row; an owner without a row has
 * no rights.
 */
export interface AccessDouble extends ToolAccessPolicy {
  /** Sets the owner's row to exactly these sources, replacing what it held. */
  allow(resourceId: string, sourceIds: readonly string[]): void;
  /** Removes the owner's row: the owner is not in the table and may read no source. */
  remove(resourceId: string): void;
  /** Every question asked, in order, with the answer given; a test may empty it. */
  readonly questions: AccessQuestion[];
  /** The questions about one owner, optionally only those about one source, in order. */
  questionsOf(resourceId: string, sourceId?: string): readonly AccessQuestion[];
}

/** One question of the engine and the double's answer. */
export interface AccessQuestion extends ToolAccessRequest {
  readonly decision: ToolAccessDecision;
}

/** A double with the given rows («owner → sources»); an owner not named has no row. */
export function createAccessDouble(rows: Readonly<Record<string, readonly string[]>> = {}): AccessDouble {
  const table = new Map<string, ReadonlySet<string>>(Object.entries(rows).map(([owner, sources]) => [owner, new Set(sources)]));
  const questions: AccessQuestion[] = [];
  return {
    decide(request) {
      const decision: ToolAccessDecision =
        request.sourceId === null || table.get(request.resourceId)?.has(request.sourceId) === true ? 'allowed' : 'access_denied';
      questions.push({ resourceId: request.resourceId, toolName: request.toolName, sourceId: request.sourceId, decision });
      return decision;
    },
    allow: (resourceId, sourceIds) => {
      table.set(resourceId, new Set(sourceIds));
    },
    remove: (resourceId) => {
      table.delete(resourceId);
    },
    questions,
    questionsOf: (resourceId, sourceId) =>
      questions.filter((question) => question.resourceId === resourceId && (sourceId === undefined || question.sourceId === sourceId)),
  };
}
