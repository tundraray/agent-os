import type { LibraryRejectReason } from '@agent-os/contracts';

type Refused<Reason extends LibraryRejectReason> = {
  readonly kind: 'refused';
  readonly reason: Reason;
};
type Allowed = { readonly kind: 'allowed' };

export interface EmployeeAudienceInput {
  /** Roles the record is open to now. */
  readonly currentRoleIds: readonly string[];
  /** Roles of the body. */
  readonly roleIds: readonly string[];
  /** Roles the owner is in now. */
  readonly ownerRoleIds: readonly string[];
  /** An admin closed sharing of the record. */
  readonly banned: boolean;
}

/**
 * Whether the owner may open their record to these roles (Flow 2; AC-04.1, DC-4): under a ban no role
 * at all; an added role must be the owner's — a role that does not exist is not, either. A role the
 * record is open to already stays even after the owner left it.
 */
export function decideEmployeeAudience(
  input: EmployeeAudienceInput,
): Allowed | Refused<'sharing_banned' | 'role_not_member'> {
  if (input.banned && input.roleIds.length > 0)
    return { kind: 'refused', reason: 'sharing_banned' };
  const current = new Set(input.currentRoleIds);
  const owner = new Set(input.ownerRoleIds);
  const notMember = input.roleIds.some(
    (roleId) => !current.has(roleId) && !owner.has(roleId),
  );
  return notMember
    ? { kind: 'refused', reason: 'role_not_member' }
    : { kind: 'allowed' };
}

export interface SystemAudienceInput {
  readonly builtinKey: string | null;
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
  /** Of the body's roles and users, those that exist. */
  readonly existingRoleIds: readonly string[];
  readonly existingUserIds: readonly string[];
  /** The built-in «Все сотрудники» role. */
  readonly everyoneRoleId: string;
}

/**
 * Whether the admin may set this audience of a system record: a default agent's audience is fixed
 * (data-model design-agents.md, KD-4), and every role and employee named must exist. «Все сотрудники» is no
 * holder: it has no membership rows, so a record shared with it would reach nobody — the audience's own
 * `everyone` is the way to share with all.
 */
export function decideSystemAudience(
  input: SystemAudienceInput,
): Allowed | Refused<'audience_fixed' | 'holder_not_found'> {
  if (input.builtinKey !== null)
    return { kind: 'refused', reason: 'audience_fixed' };
  const roles = new Set(input.existingRoleIds);
  const users = new Set(input.existingUserIds);
  const missing =
    input.roleIds.some(
      (roleId) => !roles.has(roleId) || roleId === input.everyoneRoleId,
    ) || input.userIds.some((userId) => !users.has(userId));
  return missing
    ? { kind: 'refused', reason: 'holder_not_found' }
    : { kind: 'allowed' };
}
