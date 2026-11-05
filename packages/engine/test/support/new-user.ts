import { randomUUID } from 'node:crypto';

/** A fresh, test-unique resource id: rows of one test never meet another test's (rule 9 of the plan). */
export function newUser(): string {
  return `e2e-${randomUUID()}`;
}

/** A fresh, test-unique launch key. */
export function newLaunchKey(): string {
  return `launch-${randomUUID()}`;
}
