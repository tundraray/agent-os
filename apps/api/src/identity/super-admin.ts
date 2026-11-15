import { UserStatusSchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { AuditLog } from '../audit/audit-log.js';
import { identityError } from './identity.errors.js';
import { normalizeIdentifier } from './identity-input.js';
import { checkNewPassword, hashPassword } from './password.js';
import {
  addRoleMember,
  builtinRoleId,
  findUserByLogin,
  insertLocalUser,
  setPasswordAndEnable,
  takenField,
} from './users.repository.js';
import { PASSWORD_SET, SYSTEM_ACTOR } from './users.service.js';

export interface SuperAdminInput {
  login: string;
  name: string;
  email: string;
  password: string;
}

export interface SeededSuperAdmin {
  userId: string;
  /** A new account, not one found by its login. */
  created: boolean;
}

/**
 * The operator command's work (KD-6, FR-32): finds the local account by login or creates it, sets the
 * password, turns it on, assigns the built-in role, and writes `admin_change` with actor `system` — all
 * in one transaction. Plain function over the database client: the command runs outside Nest.
 */
export async function seedSuperAdmin(
  db: Database,
  auditLog: AuditLog,
  input: SuperAdminInput,
): Promise<SeededSuperAdmin> {
  checkNewPassword(input.password);
  const passwordHash = await hashPassword(input.password);
  const login = normalizeIdentifier(input.login);
  return db
    .transaction(async (tx) => {
      const found = await findUserByLogin(tx, login);
      const user =
        found ??
        (await insertLocalUser(tx, {
          login,
          email: normalizeIdentifier(input.email),
          name: input.name,
          passwordHash,
        }));
      if (found !== undefined)
        await setPasswordAndEnable(tx, found.id, passwordHash);
      await addRoleMember(tx, await builtinRoleId(tx), user.id);
      await auditLog.record(tx, {
        kind: 'admin_change',
        actor: SYSTEM_ACTOR,
        objectType: 'user',
        objectId: user.id,
        before: found === undefined ? null : { status: found.status },
        after: {
          login,
          status: UserStatusSchema.enum.active,
          builtinRole: true,
          password: PASSWORD_SET,
        },
        outcome: 'ok',
      });
      return { userId: user.id, created: found === undefined };
    })
    .catch((error: unknown) => {
      if (takenField(error) === 'email') throw identityError('EMAIL_TAKEN');
      throw error;
    });
}
