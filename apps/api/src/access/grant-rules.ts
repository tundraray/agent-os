import type {
  CreateGrantBody,
  GrantInvalidReason,
  ModelPurpose,
} from '@agent-os/contracts';

const MIN_QUOTA_USD = 0.01;
const MAX_QUOTA_USD = 1_000_000;
/** Tolerance for `quota * 100` of a cent value that is not exact in binary (0.29 * 100). */
const CENT_EPSILON = 1e-6;

/** A grant body (POST) or a stored grant with its new quota (PATCH). */
export type GrantRuleInput = Pick<
  CreateGrantBody,
  'roleId' | 'userId' | 'effect' | 'quotaUsd'
> & {
  /** The catalogue purpose of the model; `null` for a model outside the catalogue. */
  readonly modelPurpose: ModelPurpose | null;
};

export type GrantRuleResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'invalid'; readonly reason: GrantInvalidReason };

/**
 * The rules of a grant over the data already read (DC-2, GRANT_INVALID): no grant on an embedding model
 * (model-providers DC-5), a deny only for an employee, a quota only on an allow, from 0.01 to
 * 1 000 000 in whole cents. An unknown target and duplicates are checked by the service.
 */
export function grantRules(input: GrantRuleInput): GrantRuleResult {
  if (input.modelPurpose === 'embedding') {
    return { kind: 'invalid', reason: 'embedding_model' };
  }
  if (input.effect === 'deny' && input.roleId !== undefined) {
    return { kind: 'invalid', reason: 'deny_for_role' };
  }
  const quota = input.quotaUsd ?? null;
  if (quota === null) return { kind: 'ok' };
  if (input.effect !== 'allow') {
    return { kind: 'invalid', reason: 'quota_not_on_model_allow' };
  }
  if (quota < MIN_QUOTA_USD || quota > MAX_QUOTA_USD || !wholeCents(quota)) {
    return { kind: 'invalid', reason: 'quota_out_of_range' };
  }
  return { kind: 'ok' };
}

function wholeCents(usd: number): boolean {
  const cents = usd * 100;
  return Math.abs(cents - Math.round(cents)) < CENT_EPSILON;
}
