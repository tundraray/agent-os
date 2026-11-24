/** The application's single pool and its Drizzle client (`DatabaseConnection`). */
export const DATABASE_CONNECTION = Symbol('DATABASE_CONNECTION');
/** The Drizzle client of {@link DATABASE_CONNECTION} (`Database`). */
export const DATABASE = Symbol('DATABASE');
