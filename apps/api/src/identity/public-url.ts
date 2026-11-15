import type { IncomingHttpHeaders } from 'node:http';

/** The part of a request the public address is taken from (Express `Request` fits). */
export interface AddressedRequest {
  /** `http` or `https`, as Express reports it. */
  protocol: string;
  headers: IncomingHttpHeaders;
}

/**
 * The public address of Agent OS (AC-03.4): the saved one, otherwise the scheme and host the
 * browser used to reach the API — never a path, so neither `/api` nor the route gets in.
 */
export function choosePublicUrl(
  saved: string | null,
  request: AddressedRequest,
): string {
  if (saved !== null) return saved;
  const host = request.headers.host;
  if (host === undefined || host === '')
    throw new Error('request has no Host header');
  return `${request.protocol}://${host}`;
}
