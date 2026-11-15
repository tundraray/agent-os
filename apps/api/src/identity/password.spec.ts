import { HttpException } from '@nestjs/common';
import { checkNewPassword, hashPassword, verifyPassword } from './password.js';

/** The `reason` of the 400 a password check threw, or `accepted` when it did not throw. */
function policyAnswer(password: string): string {
  try {
    checkNewPassword(password);
    return 'accepted';
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return (error.getResponse() as { reason: string }).reason;
  }
}

// KD-5, NFR-01: a password is 12..256 characters and is stored only as an argon2id hash.
describe('password policy and argon2id round trip', () => {
  it.each([
    ['11 characters', 'a'.repeat(11), 'weak_password'],
    ['12 characters', 'a'.repeat(12), 'accepted'],
    ['256 characters', 'a'.repeat(256), 'accepted'],
    ['257 characters', 'a'.repeat(257), 'weak_password'],
  ])('%s -> %s', (_, password, expected) => {
    expect(policyAnswer(password)).toBe(expected);
  });

  it('verifies only the hashed password; the hash is an argon2id string with its parameters', async () => {
    const hash = await hashPassword('correct horse battery');

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]+$/);
    expect(hash).not.toContain('correct horse battery');
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterz', hash)).resolves.toBe(false);
    await expect(verifyPassword('correct horse battery', null)).resolves.toBe(false);
  });
});
