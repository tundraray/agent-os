import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { IdentityValidationReason } from '@agent-os/contracts';
import { validationFailed } from './identity.errors.js';

/** Password length bounds in characters (KD-5); there is no other strength rule. */
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;

/** argon2id at the OWASP minimum (KD-5): 19 MiB of memory, 2 passes, 1 lane; 16-byte salt. */
const ARGON2 = { memoryKib: 19 * 1024, passes: 2, parallelism: 1 } as const;
const SALT_BYTES = 16;
const TAG_BYTES = 32;
/** Argon2 version 1.3 (0x13), the one `node:crypto` computes. */
const ARGON2_VERSION = 19;

/** PHC string: `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>`, base64 without padding. */
const HASH_FORMAT = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface Argon2Run {
  password: string;
  salt: Buffer;
  memoryKib: number;
  passes: number;
  parallelism: number;
  tagBytes: number;
}

function runArgon2(run: Argon2Run): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: run.password,
        nonce: run.salt,
        memory: run.memoryKib,
        passes: run.passes,
        parallelism: run.parallelism,
        tagLength: run.tagBytes,
      },
      (error, tag) => (error ? reject(error) : resolve(tag)),
    );
  });
}

const toBase64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');

/** Throws 400 VALIDATION_FAILED `weak_password` unless the new password is 12..256 characters. */
export function checkNewPassword(password: string): void {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw validationFailed(IdentityValidationReason.WEAK_PASSWORD);
  }
}

/** The argon2id hash of the password with a fresh random salt, parameters kept in the string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await runArgon2({ password, salt, ...ARGON2, tagBytes: TAG_BYTES });
  const { memoryKib, passes, parallelism } = ARGON2;
  return `$argon2id$v=${ARGON2_VERSION}$m=${memoryKib},t=${passes},p=${parallelism}$${toBase64(salt)}$${toBase64(tag)}`;
}

/** Hash of no account's password: checked against when the login is unknown, so the timing stays the same. */
let decoyHash: Promise<string> | undefined;

/**
 * Whether the password matches the stored hash, compared in constant time. With no stored hash (an
 * unknown login) a decoy hash is still computed and the answer is `false` (KD-5).
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (stored === null) {
    decoyHash ??= hashPassword(randomBytes(SALT_BYTES).toString('base64'));
    await verifyPassword(password, await decoyHash);
    return false;
  }
  const match = HASH_FORMAT.exec(stored);
  if (match === null) throw new Error('stored password hash is not an argon2id PHC string');
  const [memoryKib = '', passes = '', parallelism = '', salt = '', expected = ''] = match.slice(1);
  const expectedTag = Buffer.from(expected, 'base64');
  const tag = await runArgon2({
    password,
    salt: Buffer.from(salt, 'base64'),
    memoryKib: Number(memoryKib),
    passes: Number(passes),
    parallelism: Number(parallelism),
    tagBytes: expectedTag.length,
  });
  return timingSafeEqual(tag, expectedTag);
}
