import type {
  CreateGrantBody,
  GrantInvalidReason,
  GrantTargetBody,
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
  readonly target: Pick<GrantTargetBody, 'kind'>;
};

export type GrantRuleResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'invalid'; readonly reason: GrantInvalidReason };

/**
 * The rules of a grant that need no database (DC-2, GRANT_INVALID): a deny only for an employee, a
 * quota only on a model allow, from 0.01 to 1 000 000 in whole cents. The target and duplicates are
 * checked by the service.
 */
export function grantRules(input: GrantRuleInput): GrantRuleResult {
  if (input.effect === 'deny' && input.roleId !== undefined) {
    return { kind: 'invalid', reason: 'deny_for_role' };
  }
  const quota = input.quotaUsd ?? null;
  if (quota === null) return { kind: 'ok' };
  if (input.effect !== 'allow' || input.target.kind !== 'model') {
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
