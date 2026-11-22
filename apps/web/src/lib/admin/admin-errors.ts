import type { ReactNode } from 'react';
import {
  AccessErrorCode,
  GrantInvalidReasonSchema,
  IdentityErrorCode,
  IdentityValidationReason,
  McpErrorCode,
  ModelDefaultInvalidReasonSchema,
  ModelProviderErrorCode,
  ModelProviderInvalidReasonSchema,
  type GrantEffect,
} from '@agent-os/contracts';
import { failedText } from '@/i18n/server-text';
import { formatModel } from '@/lib/agents/format';
import { isApiRequestError } from '@/lib/api/api-request';
import { fieldErrorText } from './form-rules';
import { CATALOGUE, hasMessage, type ErrorsTranslator } from '@/i18n/catalog';

/** A field of a panel form that a refusal can name. */
export type AdminFieldTarget =
  'login' | 'email' | 'password' | 'name' | 'modelName' | 'quota';

/** Where a panel form shows an error: under one of its fields or in the form's error block. */
export type AdminErrorTarget = 'form' | AdminFieldTarget;

/** A field shows a catalogue text; the form block may quote the server, so it gets a node with its language mark. */
export type AdminErrorText =
  | { target: 'form'; text: ReactNode }
  | { target: AdminFieldTarget; text: string };

/** What the form knows about the request that the error alone does not say. */
export type AdminErrorContext = {
  /** The effect of the grant being added: `GRANT_EXISTS` reads «право» or «запрет» by it. */
  grantEffect?: GrantEffect;
  /** The form's phrase around a failed server check (MC-29): «Не удалось зарегистрировать» or «Не удалось сохранить». */
  checkFailed?: 'register' | 'save';
  /** The model provider the form saves or adds a model of: «провайдера {имя} уже нет» names it. */
  providerName?: string;
};

const VALIDATION_FAILED = 'VALIDATION_FAILED';

/** A 404: the record the request names, or a part of it, is gone. */
export const isNotFound = (error: unknown): boolean =>
  isApiRequestError(error) && error.kind === 'not_found';

/**
 * Wraps a screen's changes: a 404 (and whatever `also` names) reads the screen's resource again, so the
 * screen shows what the server holds, and the refusal still reaches the control that sent the change.
 */
export const rereadOnNotFound =
  (reload: () => void, also: (error: unknown) => boolean = () => false) =>
  async <T>(request: () => Promise<T>): Promise<T> => {
    try {
      return await request();
    } catch (error) {
      if (isNotFound(error) || also(error)) reload();
      throw error;
    }
  };

/** «Показать ещё» with a cursor the server no longer accepts (plan Notes 6). */
export const isListChanged = (error: unknown): boolean =>
  isApiRequestError(error) &&
  error.code === VALIDATION_FAILED &&
  error.reason === IdentityValidationReason.INVALID_CURSOR;

/** The field a code's message belongs to; any other code with a message shows in the form's block. */
const FIELD_OF_CODE: Readonly<Partial<Record<string, AdminFieldTarget>>> = {
  [IdentityErrorCode.LOGIN_TAKEN]: 'login',
  [IdentityErrorCode.EMAIL_TAKEN]: 'email',
  [IdentityErrorCode.ROLE_NAME_TAKEN]: 'name',
  [McpErrorCode.MCP_SERVER_NAME_TAKEN]: 'name',
  [AccessErrorCode.MODEL_ID_TAKEN]: 'modelName',
  [ModelProviderErrorCode.MODEL_PROVIDER_NAME_TAKEN]: 'name',
};

const form = (text: ReactNode): AdminErrorText => ({ target: 'form', text });

/**
 * design-admin.md, C3 · web and Error handling: a refused panel request as the UXRD text at its field or
 * form, in the page's language. `null` for `ADMIN_REQUIRED` — the shared 403 handler takes the screen away,
 * the form shows nothing. A code or reason without a message reads «Не удалось сохранить: {причина}» with the
 * server's own text marked English.
 */
export function describeAdminError(
  t: ErrorsTranslator,
  error: unknown,
  context: AdminErrorContext = {},
): AdminErrorText | null {
  if (!isApiRequestError(error) || error.kind === 'network')
    return form(failedText(t, 'save', error));
  const { code, reason } = error;

  switch (code) {
    case IdentityErrorCode.ADMIN_REQUIRED:
      return null;
    case ModelProviderErrorCode.MODEL_PROVIDER_NOT_FOUND:
      if (context.providerName !== undefined)
        return form(
          t('admin.providerGone', { provider: context.providerName }),
        );
      break;
    case AccessErrorCode.MODEL_PROVIDER_INVALID: {
      const invalid = ModelProviderInvalidReasonSchema.safeParse(reason);
      if (!invalid.success) break;
      if (invalid.data === 'embeddings_not_supported')
        return form(t('admin.embeddingsNotSupported'));
      if (context.providerName !== undefined)
        return form(
          t('admin.providerUnknown', { provider: context.providerName }),
        );
      break;
    }
    case AccessErrorCode.MODEL_DEFAULT_INVALID: {
      const invalid = ModelDefaultInvalidReasonSchema.safeParse(reason);
      if (!invalid.success || typeof error.model !== 'string') break;
      const model = formatModel(error.model);
      return form(
        invalid.data === 'model_unknown'
          ? t('admin.defaultModel.model_unknown', { model })
          : t('admin.defaultModel.wrongPurpose', { model }),
      );
    }
    case VALIDATION_FAILED:
      if (reason === IdentityValidationReason.WEAK_PASSWORD) {
        return {
          target: 'password',
          text: fieldErrorText(t, 'passwordLength'),
        };
      }
      if (isListChanged(error)) return form(t('admin.listChanged'));
      break;
    case AccessErrorCode.GRANT_EXISTS:
      if (context.grantEffect !== undefined)
        return form(t('admin.grantExists', { effect: context.grantEffect }));
      break;
    case AccessErrorCode.GRANT_INVALID: {
      const invalid = GrantInvalidReasonSchema.safeParse(reason);
      if (!invalid.success) break;
      return invalid.data === 'quota_out_of_range'
        ? { target: 'quota', text: fieldErrorText(t, 'quotaRange') }
        : form(t('admin.grantInvalid'));
    }
    case IdentityErrorCode.PROVIDER_CHECK_FAILED:
      if (hasMessage(CATALOGUE.errors.admin.providerCheck, reason))
        return form(t(`admin.providerCheck.${reason}`));
      break;
    case McpErrorCode.MCP_SERVER_CHECK_FAILED:
      if (hasMessage(CATALOGUE.errors.admin.mcpCheck, reason)) {
        const text = t(`admin.mcpCheck.${reason}`);
        return form(
          context.checkFailed === undefined
            ? text
            : t(`admin.mcpCheckFailed.${context.checkFailed}`, {
                reason: text,
              }),
        );
      }
      break;
    default:
      if (hasMessage(CATALOGUE.errors.admin.code, code)) {
        const text = t(`admin.code.${code}`);
        const field = FIELD_OF_CODE[code];
        return field === undefined ? form(text) : { target: field, text };
      }
  }
  return form(failedText(t, 'save', error));
}
