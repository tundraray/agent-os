import { PROVIDER_KINDS } from '@agent-os/agents';
import type {
  CatalogModel,
  CreateCatalogModelBody,
  ModelDefaultInvalidReason,
  ModelProviderInvalidReason,
  ModelProviderKind,
  ModelPurpose,
  UpdateCatalogModelBody,
} from '@agent-os/contracts';

/** The fields of an update body that belong to each purpose (design-core.md, `PATCH /api/admin/models/:id`). */
const FIELDS_OF: Readonly<
  Record<ModelPurpose, readonly (keyof UpdateCatalogModelBody)[]>
> = {
  chat: ['name', 'prices', 'longContext'],
  embedding: ['name', 'inputUsdPerMTok'],
};

const UPDATE_FIELDS: readonly (keyof UpdateCatalogModelBody)[] = [
  'name',
  'prices',
  'longContext',
  'inputUsdPerMTok',
];

export type ModelAdditionResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'invalid'; readonly reason: ModelProviderInvalidReason };

/**
 * Whether a model may join the catalogue (design-core.md, «Правила каталога»): its provider is registered
 * (AC-05.3), and an embedding model's provider kind serves embeddings (AC-05.2). `providerKind` is the kind
 * of the provider named by the first part of the id, `null` when none is registered.
 */
export function modelAdditionRule(input: {
  readonly purpose: CreateCatalogModelBody['purpose'];
  readonly providerKind: ModelProviderKind | null;
}): ModelAdditionResult {
  if (input.providerKind === null)
    return { kind: 'invalid', reason: 'provider_unknown' };
  if (
    input.purpose === 'embedding' &&
    !PROVIDER_KINDS[input.providerKind].embeddings
  )
    return { kind: 'invalid', reason: 'embeddings_not_supported' };
  return { kind: 'ok' };
}

/** One value of PUT /api/admin/model-defaults: the purpose it is for, the id chosen and its catalogue row. */
export interface DefaultChoice {
  readonly purpose: ModelPurpose;
  readonly model: string;
  /** `undefined` — the id is not in the catalogue. */
  readonly catalogued: CatalogModel | undefined;
}

export type ModelDefaultsResult =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'invalid';
      readonly reason: ModelDefaultInvalidReason;
      /** The rejected id. */
      readonly model: string;
    };

/**
 * Whether the chosen default models may stand (AC-06.2, Invariants 3, 4): each is in the catalogue and of
 * its purpose. The first wrong choice is the answer; a `null` value is not a choice and is not passed.
 */
export function modelDefaultsRule(
  choices: readonly DefaultChoice[],
): ModelDefaultsResult {
  for (const { purpose, model, catalogued } of choices) {
    if (catalogued === undefined)
      return { kind: 'invalid', reason: 'model_unknown', model };
    if (catalogued.purpose !== purpose)
      return {
        kind: 'invalid',
        reason: purpose === 'chat' ? 'not_chat' : 'not_embedding',
        model,
      };
  }
  return { kind: 'ok' };
}

export type ModelUpdateResult =
  | { readonly kind: 'ok'; readonly after: CatalogModel }
  | {
      readonly kind: 'invalid';
      /** The body's fields that belong to the other purpose: 400 VALIDATION_FAILED. */
      readonly foreignFields: readonly string[];
    };

/**
 * The catalogue row after an update (PATCH /api/admin/models/:id): the purpose and id never change, a chat
 * model takes `name`, `prices` and `longContext`, an embedding model `name` and `inputUsdPerMTok`; a field
 * of the other purpose refuses the whole update.
 */
export function modelUpdateRule(
  before: CatalogModel,
  change: UpdateCatalogModelBody,
): ModelUpdateResult {
  const foreignFields = UPDATE_FIELDS.filter(
    (field) =>
      change[field] !== undefined && !FIELDS_OF[before.purpose].includes(field),
  );
  if (foreignFields.length > 0) return { kind: 'invalid', foreignFields };
  if (before.purpose === 'embedding')
    return {
      kind: 'ok',
      after: {
        ...before,
        name: change.name ?? before.name,
        inputUsdPerMTok: change.inputUsdPerMTok ?? before.inputUsdPerMTok,
      },
    };
  return {
    kind: 'ok',
    after: {
      ...before,
      name: change.name ?? before.name,
      prices: change.prices ?? before.prices,
      longContext:
        change.longContext === undefined
          ? before.longContext
          : change.longContext,
    },
  };
}
