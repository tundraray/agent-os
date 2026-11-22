import { UserStatusSchema } from '@agent-os/contracts';
import type {
  Db,
  IdentityRolesRepository,
  IdentitySessionsRepository,
  IdentityUsersRepository,
} from '@agent-os/db';
import {
  PASSWORD_SET,
  SYSTEM_ACTOR,
  type AuditLog,
} from '../audit/audit-log';
import { identityError } from './identity.errors';
import { normalizeIdentifier } from './identity-input';
import { checkNewPassword, hashPassword } from './password';
import { takenField } from './taken-field';

/** The repositories the command writes through; built with `new` outside Nest. */
export interface SuperAdminRepositories {
  users: IdentityUsersRepository;
  roles: IdentityRolesRepository;
  sessions: IdentitySessionsRepository;
}

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
 * password, turns it on, ends the sessions of a found account (as a password reset does), assigns the
 * built-in role, and writes `admin_change` with actor `system` — all in one transaction. Plain function over `Db`: the command runs outside Nest.
 */
export async function seedSuperAdmin(
  db: Db,
  { users, roles, sessions }: SuperAdminRepositories,
  auditLog: AuditLog,
  input: SuperAdminInput,
): Promise<SeededSuperAdmin> {
  checkNewPassword(input.password);
  const passwordHash = await hashPassword(input.password);
  const login = normalizeIdentifier(input.login);
  return db
    .transaction(async () => {
      const found = await users.findByLogin(login);
      const user =
        found ??
        (await users.insertLocal({
          login,
          email: normalizeIdentifier(input.email),
          name: input.name,
          passwordHash,
        }));
      if (found !== undefined) {
        await users.setPasswordAndEnable(found.id, passwordHash);
        await sessions.deleteOfUser(found.id);
      }
      await roles.addMember(await roles.builtinId(), user.id);
      await auditLog.record({
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
          ...(found === undefined ? {} : { sessionsEnded: true }),
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
