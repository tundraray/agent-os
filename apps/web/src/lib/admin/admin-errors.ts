import {
  AccessErrorCode,
  GrantInvalidReasonSchema,
  IdentityErrorCode,
  IdentityValidationReason,
  McpCheckFailureReasonSchema,
  McpErrorCode,
  ProviderCheckFailure,
  type GrantEffect,
} from '@agent-os/contracts';
import { isApiRequestError } from '@/lib/api/api-request';
import { ADMIN_TEXT, GRANT_EXISTS_TEXT, MCP_CHECK_REASON, providerCheckFailed, saveFailed } from './admin-texts';

/** Where a panel form shows an error: under one of its fields or in the form's error block. */
export type AdminErrorTarget = 'form' | 'login' | 'email' | 'password' | 'name' | 'id' | 'quota';

export type AdminErrorText = { target: AdminErrorTarget; text: string };

/** What the form knows about the request that the error alone does not say. */
export type AdminErrorContext = {
  /** The effect of the grant being added: `GRANT_EXISTS` reads «право» or «запрет» by it. */
  grantEffect?: GrantEffect;
  /** The form's text around a failed server check (MC-29): «Не удалось зарегистрировать» or «Не удалось сохранить». */
  checkFailed?: (reason: string) => string;
};

const VALIDATION_FAILED = 'VALIDATION_FAILED';

const PROVIDER_CHECK_FAILURES: ReadonlySet<string> = new Set(Object.values(ProviderCheckFailure));

const isProviderCheckFailure = (reason: string | undefined): reason is ProviderCheckFailure =>
  reason !== undefined && PROVIDER_CHECK_FAILURES.has(reason);

const form = (text: string): AdminErrorText => ({ target: 'form', text });

/**
 * design-admin.md, C3 · web and Error handling: a refused panel request as the UXRD text at its field or
 * form. `null` for `ADMIN_REQUIRED` — the shared 403 handler takes the screen away, the form shows nothing.
 * A code or reason without a UXRD text reads the server's own `message` (`PUBLIC_URL_REQUIRED` and
 * `invalid_cursor` have texts of their own, plan Notes 6).
 */
export function describeAdminError(error: unknown, context: AdminErrorContext = {}): AdminErrorText | null {
  if (!isApiRequestError(error)) return form(saveFailed(error instanceof Error ? error.message : String(error)));
  if (error.kind === 'network') return form(ADMIN_TEXT.noConnection);
  const { code, reason } = error;

  switch (code) {
    case IdentityErrorCode.ADMIN_REQUIRED:
      return null;
    case IdentityErrorCode.LOGIN_TAKEN:
      return { target: 'login', text: ADMIN_TEXT.loginTaken };
    case IdentityErrorCode.EMAIL_TAKEN:
      return { target: 'email', text: ADMIN_TEXT.emailTaken };
    case IdentityErrorCode.ROLE_NAME_TAKEN:
      return { target: 'name', text: ADMIN_TEXT.roleNameTaken };
    case McpErrorCode.MCP_SERVER_NAME_TAKEN:
      return { target: 'name', text: ADMIN_TEXT.serverNameTaken };
    case AccessErrorCode.MODEL_ID_TAKEN:
      return { target: 'id', text: ADMIN_TEXT.modelIdTaken };
    case VALIDATION_FAILED:
      if (reason === IdentityValidationReason.WEAK_PASSWORD) return { target: 'password', text: ADMIN_TEXT.passwordLength };
      if (reason === IdentityValidationReason.INVALID_CURSOR) return form(ADMIN_TEXT.listChanged);
      break;
    case AccessErrorCode.GRANT_EXISTS:
      if (context.grantEffect !== undefined) return form(GRANT_EXISTS_TEXT[context.grantEffect]);
      break;
    case AccessErrorCode.GRANT_TARGET_UNKNOWN:
      return form(ADMIN_TEXT.grantTargetUnknown);
    case AccessErrorCode.GRANT_INVALID: {
      const invalid = GrantInvalidReasonSchema.safeParse(reason);
      if (!invalid.success) break;
      return invalid.data === 'quota_out_of_range'
        ? { target: 'quota', text: ADMIN_TEXT.quotaRange }
        : form(ADMIN_TEXT.grantInvalid);
    }
    case IdentityErrorCode.PROVIDER_CHECK_FAILED:
      if (isProviderCheckFailure(reason)) return form(providerCheckFailed(reason));
      break;
    case McpErrorCode.MCP_SERVER_CHECK_FAILED: {
      const check = McpCheckFailureReasonSchema.safeParse(reason);
      if (check.success) {
        const text = MCP_CHECK_REASON[check.data];
        return form(context.checkFailed?.(text) ?? text);
      }
      break;
    }
    case IdentityErrorCode.PROVIDER_INCOMPLETE:
      return form(ADMIN_TEXT.providerIncomplete);
    case McpErrorCode.MCP_SERVER_INCOMPLETE:
      return form(ADMIN_TEXT.serverIncomplete);
    case IdentityErrorCode.PUBLIC_URL_REQUIRED:
      return form(ADMIN_TEXT.publicUrlRequired);
  }
  return form(saveFailed(error.message));
}
