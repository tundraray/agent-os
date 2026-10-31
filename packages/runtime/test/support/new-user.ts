import { randomUUID } from 'node:crypto';

/** A fresh, test-unique resource id: rows of one test never meet another test's. */
export function newUser(): string {
  return `e2e-${randomUUID()}`;
}
