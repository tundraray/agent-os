/**
 * A login or an email as stored and looked up: trimmed and in lower case (Security «Input
 * Validation»), so the plain unique indexes of `identity_users` ignore letter case.
 */
export function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}
