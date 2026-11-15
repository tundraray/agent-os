import type { IncomingHttpHeaders } from 'node:http';
import { PublicUrlSchema } from '@agent-os/contracts';

/** The part of a request the public address is taken from (Express `Request` fits). */
export interface AddressedRequest {
  /** `http` or `https`, as Express reports it. */
  protocol: string;
  headers: IncomingHttpHeaders;
}

/**
 * The public address of Agent OS as the browser reached the API (AC-03.4): scheme and host, never a
 * path, so neither `/api` nor the route gets in. Undefined when that is no valid public address
 * (`PublicUrlSchema`): no Host, or `http` to a host other than `localhost`, as behind a TLS proxy.
 */
export function publicUrlOf(request: AddressedRequest): string | undefined {
  const host = request.headers.host;
  if (host === undefined || host === '') return undefined;
  const address = `${request.protocol}://${host}`;
  return PublicUrlSchema.safeParse(address).success ? address : undefined;
}
