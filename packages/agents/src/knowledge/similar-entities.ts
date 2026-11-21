import { envelope } from '../model/provider-messages';
import { knowledgeKey, knowledgeLineWithKey } from './knowledge-text';
import {
  type ChooseEntitiesArgs,
  KNOWLEDGE_OPERATIONS_MAX,
  KnowledgeOperationSchema,
} from './operations';
import type { GraphItem } from './select-knowledge';
import type { KnowledgeCloseness } from './vector-store';

/**
 * Similar entities at extraction (self-learning design-core.md, KD-4, FR-20, AC-20.1, DC-17). Code only
 * finds candidates and checks the model's choice; it never merges entities by itself.
 */

/** The least closeness (cosine) of a candidate; tuned on the first real extractions (Risks). */
const SIMILAR_ENTITY_MIN_SCORE = 0.8;
/** At most this many candidates per new entity; also the `limit` of the store's query. */
export const SIMILAR_ENTITY_LIMIT = 3;

/** A new entity of the model's answer, as its `add_entity` gives it. */
export interface ProposedEntity {
  readonly ref: string;
  readonly name: string;
  readonly description: string;
}

type GraphEntityItem = Extract<GraphItem, { type: 'entity' }>;

/** An existing entity of the graph shown to the model under its id `e…`. */
export interface EntityCandidate {
  readonly id: string;
  readonly closeness: number;
  readonly entity: GraphEntityItem;
}

/** A new entity that has candidates, closest first. */
export interface SimilarEntity extends ProposedEntity {
  readonly candidates: readonly EntityCandidate[];
}

/** A choice of the model: the new entity's `ref` and the chosen id `e…`. */
export interface EntityChoice {
  readonly ref: string;
  readonly id: string;
}

export interface AppliedChoices {
  /** The answer's operations with the accepted choices applied, for `checkOperations`. */
  readonly operations: unknown[];
  readonly accepted: EntityChoice[];
  /** Choices whose id was not offered for that `ref`: the entity stays new. */
  readonly rejected: EntityChoice[];
}

/**
 * The new entities of an answer: each well-formed `add_entity` among the operations `checkOperations`
 * would look at, the first one per `ref`. Their texts are what the caller masks and embeds.
 */
export function proposedEntities(operations: readonly unknown[]): ProposedEntity[] {
  const byRef = new Map<string, ProposedEntity>();
  for (const raw of operations.slice(0, KNOWLEDGE_OPERATIONS_MAX)) {
    const parsed = KnowledgeOperationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.op !== 'add_entity') continue;
    const { ref, name, description } = parsed.data;
    if (!byRef.has(ref)) byRef.set(ref, { ref, name, description });
  }
  return [...byRef.values()];
}

/**
 * The candidates of each new entity: keys of graph entities with closeness at least
 * `SIMILAR_ENTITY_MIN_SCORE`, at most `SIMILAR_ENTITY_LIMIT`, closest first. A key that is not an entity
 * of `graph` (a relation, a deleted record) is never a candidate. Only entities with candidates are
 * returned; an empty result means no `choose_entities` call.
 */
export function similarCandidates(
  newEntities: readonly ProposedEntity[],
  pairsByRef: ReadonlyMap<string, readonly KnowledgeCloseness[]>,
  graph: readonly GraphItem[],
): SimilarEntity[] {
  const entitiesByKey = new Map<string, GraphEntityItem>();
  for (const item of graph) if (item.type === 'entity') entitiesByKey.set(knowledgeKey(item), item);

  return newEntities.flatMap((proposed) => {
    const candidates = (pairsByRef.get(proposed.ref) ?? [])
      .filter(({ closeness }) => closeness >= SIMILAR_ENTITY_MIN_SCORE)
      .flatMap(({ key, closeness }) => {
        const entity = entitiesByKey.get(key);
        return entity ? [{ id: key, closeness, entity }] : [];
      })
      .sort((a, b) => b.closeness - a.closeness)
      .slice(0, SIMILAR_ENTITY_LIMIT);
    return candidates.length > 0 ? [{ ...proposed, candidates }] : [];
  });
}

/** The rule of the `choose_entities` call, outside the envelope. */
const CHOOSE_ENTITIES_RULE =
  'Some entities you proposed look like entities the knowledge graph already has. For each new entity ' +
  'below, call choose_entities with its ref and the id e… of the candidate that is the same thing, or null ' +
  'if none is: then it stays a new entity. Choose only among the candidates listed for that entity.';

/** Who the enveloped candidates come from: the workflow's graph and the model's own proposal. */
const SIMILAR_ENTITIES_AUTHOR = 'knowledge graph of this workflow';

/**
 * What the model sees in the `choose_entities` call: each new entity with its ref, name and description,
 * then its candidates by id with their names and descriptions — nothing else of the graph.
 */
export function similarEntitiesText(similar: readonly SimilarEntity[]): string {
  const blocks = similar.map((entity) =>
    [
      `new entity ref=${entity.ref}: ${entity.name}: ${entity.description}`,
      ...entity.candidates.map((candidate) => `  candidate ${knowledgeLineWithKey(candidate.entity)}`),
    ].join('\n'),
  );
  return `${CHOOSE_ENTITIES_RULE}\n${envelope('similar entities', SIMILAR_ENTITIES_AUTHOR, blocks.join('\n\n'))}`;
}

/**
 * Applies the model's choices before `checkOperations`: for an accepted choice the entity's `add_entity`
 * becomes `confirm` of the chosen id with the same evidence, and its `ref` in every `from` / `to` becomes
 * that id. A choice whose id was not offered for that `ref` (or a second choice for a `ref`) is rejected
 * and the entity stays new; `null` keeps it new. Operations are otherwise passed as they are.
 */
export function applyChoices(
  operations: readonly unknown[],
  similar: readonly SimilarEntity[],
  choices: ChooseEntitiesArgs['choices'],
): AppliedChoices {
  const offered = new Map(similar.map((entity) => [entity.ref, entity.candidates.map(({ id }) => id)]));
  const chosen = new Map<string, string>();
  const accepted: EntityChoice[] = [];
  const rejected: EntityChoice[] = [];
  for (const { ref, id } of choices) {
    if (id === null) continue;
    const choice = { ref, id };
    if (!chosen.has(ref) && offered.get(ref)?.includes(id)) {
      chosen.set(ref, id);
      accepted.push(choice);
    } else {
      rejected.push(choice);
    }
  }
  if (chosen.size === 0) return { operations: [...operations], accepted, rejected };
  return { operations: operations.map((op) => withChoices(op, chosen)), accepted, rejected };
}

function withChoices(op: unknown, chosen: ReadonlyMap<string, string>): unknown {
  if (typeof op !== 'object' || op === null) return op;
  const fields = op as Record<string, unknown>;
  const chosenId = (value: unknown) => (typeof value === 'string' ? chosen.get(value.trim()) : undefined);

  if (fields.op === 'add_entity') {
    const id = chosenId(fields.ref);
    return id ? { op: 'confirm', id, evidence: fields.evidence } : op;
  }
  if (fields.op === 'add_relation' && fields.kind === 'fact') {
    return {
      ...fields,
      from: chosenId(fields.from) ?? fields.from,
      to: chosenId(fields.to) ?? fields.to,
    };
  }
  return op;
}
