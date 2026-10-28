import type { Request } from 'express';

export interface AuthUser {
  id: string;
  roles: string[];
}

export type AuthedRequest = Request & { user: AuthUser };
