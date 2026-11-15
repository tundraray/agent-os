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
  sessionId: string;
}

export type AuthedRequest = Request & { user: AuthUser };
