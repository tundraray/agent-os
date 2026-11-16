/** Providers of `IdentityModule` other than its classes. */

/**
 * The issuer of the `google` provider type, fixed in code (KD-1); a test overrides this provider to
 * point `google` at its own issuer.
 */
export const GOOGLE_ISSUER_URL = Symbol('GOOGLE_ISSUER_URL');

export const DEFAULT_GOOGLE_ISSUER_URL = 'https://accounts.google.com';
