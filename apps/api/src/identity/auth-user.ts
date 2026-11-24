import type { Language } from '@agent-os/contracts';
import type { Request } from 'express';

/** The employee of a request with a live session, put into `req.user` by `SessionGuard` (KD-3). */
export interface AuthUser {
  /** `identity_users.id`, a server-issued UUID; the owner columns hold the same value. */
  id: string;
  email: string;
  /** Empty string when there is no name. */
  name: string;
  /** The personal mark or a role with the admin right, as of this request. */
  isAdmin: boolean;
  /** A role with the right to train own agents, as of this request (KD-8). */
  trainOwn: boolean;
  /** A role with the right to train any agent, as of this request (KD-8). */
  trainAny: boolean;
  /** A local account: it has a password (`CurrentUser.hasPassword`). */
  hasPassword: boolean;
  /** The chosen interface language, or null while there is no choice (`CurrentUser.language`). */
  language: Language | null;
  sessionId: string;
}

export type AuthedRequest = Request & { user: AuthUser };
