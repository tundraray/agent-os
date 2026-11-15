const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one check of a row id from outside (a route, a cursor, a stored owner): anything that is not a
 * UUID can name no row, so callers treat it as missing instead of letting Postgres fail with 22P02.
 */
export function isUuid(id: string): boolean {
  return UUID.test(id);
}
