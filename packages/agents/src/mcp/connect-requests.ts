import { randomBytes, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

/** How long a connection request stays valid (design-mcp-connect.md, Runtime settings). */
const CONNECT_REQUEST_TTL_MS = 10 * 60 * 1000;
const STATE_BYTES = 32;

/** Whose account the connection makes: an employee's, or the admin's that enables the server (Flow 1). */
export type ConnectTarget = 'employee' | 'admin';

/** What a connection is begun with. */
export interface ConnectRequestInput {
  readonly ownerId: string;
  readonly server: string;
  readonly target: ConnectTarget;
  /** PKCE verifier; never logged. */
  readonly codeVerifier: string;
  readonly redirectUrl: string;
  /** Issuer of the authorization server, compared with `iss` of the return (RFC 9207). */
  readonly issuer: string;
}

/** A connection request between the redirect to the authorization server and the return. */
export interface ConnectRequest extends ConnectRequestInput {
  /** For the log; the `state` itself is never logged. */
  readonly id: string;
  readonly createdAt: Date;
}

/**
 * Connection requests in process memory (KD-6, ADR-0001: one API process; a restart loses begun
 * connections). A request is taken at most once, within 10 minutes and only by the employee who
 * began it (DC-5, Invariant 5).
 */
@Injectable()
export class ConnectRequests {
  private readonly byState = new Map<string, ConnectRequest>();

  /**
   * Stores a new request in place of the owner's earlier one for the server — a pair has at most one;
   * `state` is 32 random bytes in base64url.
   */
  open(input: ConnectRequestInput): { readonly id: string; readonly state: string } {
    const createdAt = new Date();
    this.dropExpired(createdAt);
    for (const [state, request] of this.byState) {
      if (request.ownerId === input.ownerId && request.server === input.server) this.byState.delete(state);
    }
    const id = randomUUID();
    const state = randomBytes(STATE_BYTES).toString('base64url');
    this.byState.set(state, { ...input, id, createdAt });
    return { id, state };
  }

  /**
   * Removes the request of a known `state` whoever presents it — so a foreign attempt with Anna's
   * `state` voids her request, and she begins again — then returns it only when it is still valid
   * and `ownerId` is its employee.
   */
  take(state: string, ownerId: string, now: Date): ConnectRequest | undefined {
    const request = this.byState.get(state);
    if (request === undefined) return undefined;
    this.byState.delete(state);
    if (!isValid(request, now) || request.ownerId !== ownerId) return undefined;
    return request;
  }

  /** Requests nobody returned for: the map does not grow with abandoned connections. */
  private dropExpired(now: Date): void {
    for (const [state, request] of this.byState) {
      if (!isValid(request, now)) this.byState.delete(state);
    }
  }
}

function isValid(request: ConnectRequest, now: Date): boolean {
  return now.getTime() - request.createdAt.getTime() <= CONNECT_REQUEST_TTL_MS;
}
