/** SQLSTATE unique_violation. */
const UNIQUE_VIOLATION = '23505';
const TAKEN_BY_INDEX: Record<string, 'login' | 'email' | 'roleName'> = {
  identity_users_login_idx: 'login',
  identity_users_email_idx: 'email',
  identity_roles_name_idx: 'roleName',
};

/** Which unique field of `identity_users` or `identity_roles` the error violated, if it is such a violation (drizzle wraps the driver's error). */
export function takenField(
  error: unknown,
): 'login' | 'email' | 'roleName' | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code, constraint } = current as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === UNIQUE_VIOLATION && typeof constraint === 'string')
      return TAKEN_BY_INDEX[constraint];
  }
  return undefined;
}
