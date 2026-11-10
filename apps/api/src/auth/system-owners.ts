/**
 * Owners of this prefix are the system's own (design-self-check.md, KD-3): no sign-in issues them, so no request
 * header may claim one.
 */
export const RESERVED_USER_PREFIX = 'system:';

/**
 * The owner of every investigation of the self-check program; no sign-in issues it (design-self-check.md, KD-3). It
 * tells the program's investigations apart in the database it shares with the server: the program cancels and deletes
 * only these, and the server's transcript purge keeps them (AC-01.5).
 */
export const SELF_CHECK_OWNER = `${RESERVED_USER_PREFIX}self-check`;
