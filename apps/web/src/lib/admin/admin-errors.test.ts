import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@/lib/api/api-request';
import { describeAdminError, type AdminErrorContext, type AdminErrorText } from './admin-errors';

/** An API refusal as `apiRequest` builds it from the error body. */
const refusal = (status: number, code: string, reason?: string, message?: string) =>
  new ApiRequestError({
    kind: status === 404 ? 'not_found' : 'http',
    method: 'POST',
    path: '/api/admin/x',
    status,
    code,
    reason,
    bodyMessage: message,
  });

const form = (text: string): AdminErrorText => ({ target: 'form', text });

describe('describeAdminError (C3 · web, Error handling)', () => {
  it.each<[string, ApiRequestError, AdminErrorContext, AdminErrorText | null]>([
    ['ADMIN_REQUIRED shows nothing', refusal(403, 'ADMIN_REQUIRED', undefined, 'Admin required'), {}, null],
    ['LOGIN_TAKEN', refusal(409, 'LOGIN_TAKEN'), {}, { target: 'login', text: 'Такой логин уже есть' }],
    ['EMAIL_TAKEN', refusal(409, 'EMAIL_TAKEN'), {}, { target: 'email', text: 'Сотрудник с такой почтой уже есть' }],
    [
      'weak_password',
      refusal(400, 'VALIDATION_FAILED', 'weak_password'),
      {},
      { target: 'password', text: 'Пароль — от 12 до 256 знаков' },
    ],
    ['ROLE_NAME_TAKEN', refusal(409, 'ROLE_NAME_TAKEN'), {}, { target: 'name', text: 'Такая роль уже есть' }],
    [
      'MCP_SERVER_NAME_TAKEN',
      refusal(409, 'MCP_SERVER_NAME_TAKEN'),
      {},
      { target: 'name', text: 'Сервер с таким именем уже есть' },
    ],
    ['MODEL_ID_TAKEN', refusal(409, 'MODEL_ID_TAKEN'), {}, { target: 'id', text: 'Модель с таким ID уже есть в каталоге' }],
    [
      'quota_out_of_range',
      refusal(422, 'GRANT_INVALID', 'quota_out_of_range'),
      {},
      { target: 'quota', text: 'Квота — от 0,01 до 1 000 000 $, не больше двух знаков после запятой' },
    ],
    ['GRANT_EXISTS of an allow', refusal(409, 'GRANT_EXISTS'), { grantEffect: 'allow' }, form('Такое право уже есть')],
    ['GRANT_EXISTS of a deny', refusal(409, 'GRANT_EXISTS'), { grantEffect: 'deny' }, form('Такой запрет уже есть')],
    [
      'GRANT_TARGET_UNKNOWN',
      refusal(422, 'GRANT_TARGET_UNKNOWN', 'tool_unknown'),
      {},
      form('Этого сервера, инструмента или модели больше нет. Закройте окно и выберите цель снова.'),
    ],
    [
      'GRANT_INVALID with another reason',
      refusal(422, 'GRANT_INVALID', 'quota_not_on_model_allow'),
      {},
      form('Так нельзя: запрет даётся только лично, а квота — только у разрешения модели.'),
    ],
    [
      'PROVIDER_CHECK_FAILED invalid_document',
      refusal(422, 'PROVIDER_CHECK_FAILED', 'invalid_document'),
      {},
      form(
        'Не удалось проверить настройки провайдера: по этому адресу нет описания OIDC для этого Issuer. Настройки не сохранены.',
      ),
    ],
    ['MCP check unreachable', refusal(422, 'MCP_SERVER_CHECK_FAILED', 'unreachable'), {}, form('сервер не отвечает по этому адресу')],
    [
      'MCP check with the form text around it',
      refusal(422, 'MCP_SERVER_CHECK_FAILED', 'unauthorized'),
      { checkFailed: (reason) => `Не удалось зарегистрировать: ${reason}` },
      form('Не удалось зарегистрировать: сервер не принял токен доступа'),
    ],
    [
      'PROVIDER_INCOMPLETE',
      refusal(409, 'PROVIDER_INCOMPLETE'),
      {},
      form('Нельзя включить: сначала заполните настройки провайдера.'),
    ],
    [
      'MCP_SERVER_INCOMPLETE',
      refusal(409, 'MCP_SERVER_INCOMPLETE'),
      {},
      form('Нельзя включить: сначала подключите свой аккаунт и получите список инструментов.'),
    ],
    [
      'PUBLIC_URL_REQUIRED',
      refusal(409, 'PUBLIC_URL_REQUIRED', undefined, 'Public URL required'),
      {},
      form('Сначала сохраните публичный адрес Agent OS в настройках входа.'),
    ],
    [
      'invalid_cursor',
      refusal(400, 'VALIDATION_FAILED', 'invalid_cursor', 'Invalid cursor'),
      {},
      form('Список изменился. Откройте раздел заново.'),
    ],
    [
      'a code without a UXRD text reads the server message',
      refusal(409, 'BUILTIN_ROLE', undefined, 'Built-in role cannot be changed'),
      {},
      form('Не удалось сохранить: Built-in role cannot be changed'),
    ],
    [
      'another VALIDATION_FAILED reads the server message',
      refusal(400, 'VALIDATION_FAILED', 'unknown_type', 'Unknown provider type'),
      {},
      form('Не удалось сохранить: Unknown provider type'),
    ],
    [
      'no answer from the server',
      new ApiRequestError({ kind: 'network', method: 'PUT', path: '/api/admin/settings/sign-in' }),
      {},
      form('Не удалось сохранить: нет связи с сервером'),
    ],
  ])('%s', (_name, error, context, expected) => {
    expect(describeAdminError(error, context)).toEqual(expected);
  });
});
