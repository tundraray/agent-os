import {
  IdentityValidationReason,
  isHttpsOrLocalhost,
  ProviderCheckFailure,
  ProviderTypeSchema,
  type CreateProviderBody,
  type ProviderOptionsView,
  type ProviderType,
} from '@agent-os/contracts';
import { z } from 'zod';
import { identityError, validationFailed } from './identity.errors.js';

/**
 * Settings of a provider as `identity_providers.options` stores them, the client secret as is (KD-7);
 * the column accepts any JSON, so a row is read through this schema.
 */
export const ProviderOptionsSchema = z.object({
  issuer: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});
export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>;

/** Settings with the client of every type set: what `isComplete` guarantees to the sign-in. */
type CompleteOptions = ProviderOptions & {
  clientId: string;
  clientSecret: string;
};

/** Settings as an admin sends them: a field that is absent keeps its stored value. */
export type ProviderOptionsInput = NonNullable<CreateProviderBody['options']>;

/** Fetch of the issuer's discovery document; a parameter so the check runs without the network. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** How long the issuer may take to answer its discovery document. */
const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_PATH = '/.well-known/openid-configuration';

/** The settings the admin gives per type (KD-1); `google` uses the issuer fixed in code. */
const REQUIRED_FIELDS: Record<ProviderType, (keyof ProviderOptions)[]> = {
  google: ['clientId', 'clientSecret'],
  oidc: ['issuer', 'clientId', 'clientSecret'],
};

/** A type outside the list answers 400 VALIDATION_FAILED with reason `unknown_type` (AC-03.5). */
export function parseProviderType(type: string): ProviderType {
  const parsed = ProviderTypeSchema.safeParse(type);
  if (!parsed.success)
    throw validationFailed(IdentityValidationReason.UNKNOWN_TYPE);
  return parsed.data;
}

/** Whether every setting of the type is set (`ProviderView.complete`, DC-6). */
export function isComplete(
  type: ProviderType,
  options: ProviderOptions,
): options is CompleteOptions {
  return REQUIRED_FIELDS[type].every((field) => options[field] !== undefined);
}

/** The settings as the server shows them: never the secret value, only whether it is set. */
export function toOptionsView(
  type: ProviderType,
  options: ProviderOptions,
): ProviderOptionsView {
  const view: ProviderOptionsView = {
    clientId: options.clientId ?? null,
    clientSecretSet: options.clientSecret !== undefined,
  };
  return type === 'oidc' ? { ...view, issuer: options.issuer ?? null } : view;
}

/**
 * The settings to store after an admin change: only the fields of the type, each replaced only when
 * sent (so the secret stays unless a new one is passed). A newly sent `oidc` issuer is checked by
 * discovery first; a failed check throws 422 PROVIDER_CHECK_FAILED and nothing is to be stored (DC-6).
 */
export async function resolveProviderOptions(params: {
  type: ProviderType;
  stored: ProviderOptions;
  input: ProviderOptionsInput | undefined;
  fetch: FetchFn;
}): Promise<ProviderOptions> {
  const { type, stored, input = {}, fetch } = params;
  const merged: ProviderOptions = {};
  for (const field of REQUIRED_FIELDS[type]) {
    const value = input[field] ?? stored[field];
    if (value !== undefined) merged[field] = value;
  }
  if (type === 'oidc' && input.issuer !== undefined)
    await checkIssuer(input.issuer, fetch);
  return merged;
}

/** Discovery of the issuer: a secure address that answers with the OIDC document of this very issuer. */
async function checkIssuer(issuer: string, fetch: FetchFn): Promise<void> {
  if (!URL.canParse(issuer) || !isHttpsOrLocalhost(new URL(issuer)))
    throw checkFailed(ProviderCheckFailure.INSECURE_URL);
  let response: Response;
  try {
    response = await fetch(`${issuer.replace(/\/$/, '')}${DISCOVERY_PATH}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch {
    throw checkFailed(ProviderCheckFailure.UNREACHABLE);
  }
  if (!response.ok) throw checkFailed(ProviderCheckFailure.UNREACHABLE);
  const document: unknown = await response.json().catch(() => null);
  if (!isDiscoveryOf(issuer, document))
    throw checkFailed(ProviderCheckFailure.INVALID_DOCUMENT);
}

/** An OIDC discovery document names its issuer exactly and the endpoints the sign-in uses. */
function isDiscoveryOf(issuer: string, document: unknown): boolean {
  if (document === null || typeof document !== 'object') return false;
  const fields = document as Record<string, unknown>;
  return (
    fields.issuer === issuer &&
    ['authorization_endpoint', 'token_endpoint', 'jwks_uri'].every(
      (name) => typeof fields[name] === 'string',
    )
  );
}

function checkFailed(reason: ProviderCheckFailure): Error {
  return identityError('PROVIDER_CHECK_FAILED', reason);
}
