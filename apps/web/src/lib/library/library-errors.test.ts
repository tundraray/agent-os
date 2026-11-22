import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@/lib/api/api-request';
import { testTranslator } from '@/test/intl';
import { render } from '@/test/render';
import {
  describeLibraryError,
  describeRefusal,
  isKnowledgeHidden,
  type LibraryErrorContext,
  type LibraryErrorText,
  type RefusalText,
} from './library-errors';

const t = testTranslator('errors');

/** A refusal as `apiRequest` builds it from the error body. */
const refusal = (
  status: number,
  code: string,
  reason?: string,
  message?: string,
): ApiRequestError =>
  new ApiRequestError({
    kind: status === 404 ? 'not_found' : 'http',
    method: 'PUT',
    path: '/api/library/r1',
    status,
    code,
    reason,
    bodyMessage: message,
  });

/** 409 `START_REFUSED` as `apiRequest` builds it, with the body's refused model. */
const startRefused = (reason: string, model: string | null): ApiRequestError =>
  new ApiRequestError({
    kind: 'http',
    method: 'POST',
    path: '/api/agents/a1/restart',
    status: 409,
    code: 'START_REFUSED',
    reason,
    bodyMessage: 'Start refused',
    model,
  });

const network = new ApiRequestError({
  kind: 'network',
  method: 'POST',
  path: '/api/threads/t1/messages',
});

const NOT_FOUND =
  'Такого агента или глубокого агента нет: его удалили, закрыли для вас или ссылка неверна.';

/** A library error as the page shows it: its text as markup, so the server text's language mark is seen. */
type Shown = Omit<LibraryErrorText, 'text'> & { text: string };

type Outcome = Shown | RefusalText | string | boolean | null;

const markup = (text: ReactNode): string => render(text).container.innerHTML;

const libraryError = (
  error: unknown,
  context: LibraryErrorContext,
): Shown | null => {
  const described = describeLibraryError(t, error, context);
  return described === null
    ? null
    : { ...described, text: markup(described.text) };
};

// Catches: the same code in another place reads the same line; the model of a refusal taken from the call's arguments;
// «Не найдено» on any 403, or an error instead of «Не найдено» on the knowledge 403 (self-learning AC-11.3, DC-2).
describe('describeLibraryError, describeRefusal and isKnowledgeHidden (design-web.md, «Ошибки и их место»; DC-10, DC-11, Flow 2)', () => {
  it.each<[string, () => Outcome, Outcome]>([
    // 404 RECORD_NOT_FOUND: the record page gives way to RV-02; a message with a chip names the record unavailable
    [
      '404 on the record page → RV-02',
      () =>
        libraryError(refusal(404, 'RECORD_NOT_FOUND'), {
          where: 'record_page',
        }),
      { place: { at: 'screen' }, text: NOT_FOUND, open: false },
    ],
    [
      '404 on a message with a deep agent chip → MC-16 under the field',
      () =>
        libraryError(refusal(404, 'RECORD_NOT_FOUND'), {
          where: 'message',
          kind: 'deep_agent',
        }),
      {
        place: { at: 'composer' },
        text: 'Глубокий агент недоступен: его удалили или закрыли для вас',
        open: false,
      },
    ],
    // 409 RECORD_VERSION_CONFLICT: MC-10, employee and administrator wording
    [
      '409 conflict in the employee editor → MC-10 with the changed fields',
      () =>
        libraryError(refusal(409, 'RECORD_VERSION_CONFLICT'), {
          where: 'editor',
          changedFields: ['Инструкция', 'Модель'],
        }),
      {
        place: { at: 'conflict' },
        text: 'Вы уже сохранили изменения в другом окне или в чате. Там изменились: Инструкция, Модель.',
        open: false,
      },
    ],
    [
      '409 conflict in the panel without fields → MC-10 of the administrator',
      () =>
        libraryError(refusal(409, 'RECORD_VERSION_CONFLICT'), {
          where: 'panel',
          admin: true,
        }),
      {
        place: { at: 'conflict' },
        text: 'Изменения уже сохранили в другом окне.',
        open: false,
      },
    ],
    // 409 RECORD_NAME_TAKEN → the field «Имя»
    [
      'name taken, own',
      () =>
        libraryError(refusal(409, 'RECORD_NAME_TAKEN', 'own'), {
          where: 'editor',
          kind: 'agent',
          name: 'Сводка',
        }),
      {
        place: { at: 'field', field: 'name' },
        text: 'У вас уже есть агент «Сводка»',
        open: false,
      },
    ],
    [
      'name taken, system',
      () =>
        libraryError(refusal(409, 'RECORD_NAME_TAKEN', 'system'), {
          where: 'editor',
          kind: 'agent',
          name: 'Чат',
        }),
      {
        place: { at: 'field', field: 'name' },
        text: 'Так называется агент от компании — выберите другое имя',
        open: false,
      },
    ],
    // 422 RECORD_REJECTED by reason
    [
      '422 server_not_allowed → the field «Системы»',
      () =>
        libraryError(refusal(422, 'RECORD_REJECTED', 'server_not_allowed'), {
          where: 'editor',
          server: 'sentry',
        }),
      {
        place: { at: 'field', field: 'servers' },
        text: 'Нет доступа к системе sentry — уберите её',
        open: false,
      },
    ],
    [
      '422 all_servers_not_allowed → the field «Системы»',
      () =>
        libraryError(
          refusal(
            422,
            'RECORD_REJECTED',
            'all_servers_not_allowed',
            'Record is rejected',
          ),
          {
            where: 'editor',
          },
        ),
      {
        place: { at: 'field', field: 'servers' },
        text: 'Не удалось сохранить: <span lang="en">Record is rejected</span>',
        open: false,
      },
    ],
    [
      '422 model_not_allowed → the field «Модель»',
      () =>
        libraryError(refusal(422, 'RECORD_REJECTED', 'model_not_allowed'), {
          where: 'editor',
          model: 'anthropic/claude-opus-5-5',
        }),
      {
        place: { at: 'field', field: 'model' },
        text: 'Модель Opus вам недоступна — выберите другую',
        open: false,
      },
    ],
    [
      '422 agent_not_visible → the field «Может запускать»',
      () =>
        libraryError(
          refusal(
            422,
            'RECORD_REJECTED',
            'agent_not_visible',
            'Record is rejected',
          ),
          {
            where: 'editor',
          },
        ),
      {
        place: { at: 'field', field: 'agents' },
        text: 'Не удалось сохранить: <span lang="en">Record is rejected</span>',
        open: false,
      },
    ],
    [
      '422 role_not_member → the form of «Поделиться»',
      () =>
        libraryError(refusal(422, 'RECORD_REJECTED', 'role_not_member'), {
          where: 'share',
          role: 'Поддержка',
        }),
      {
        place: { at: 'form' },
        text: 'Не удалось сохранить: вы не состоите в роли Поддержка',
        open: false,
      },
    ],
    [
      '422 sharing_banned → the form of «Поделиться»',
      () =>
        libraryError(refusal(422, 'RECORD_REJECTED', 'sharing_banned'), {
          where: 'share',
        }),
      {
        place: { at: 'form' },
        text: 'Не удалось сохранить: доступ закрыл администратор',
        open: false,
      },
    ],
    [
      '422 audience_fixed (and holder_not_found, builtin) → the panel form',
      () =>
        libraryError(
          refusal(
            422,
            'RECORD_REJECTED',
            'audience_fixed',
            'Record is rejected',
          ),
          { where: 'panel' },
        ),
      {
        place: { at: 'form' },
        text: 'Не удалось сохранить: <span lang="en">Record is rejected</span>',
        open: false,
      },
    ],
    // 409 START_REFUSED at «Запустить с нуля» and on a new conversation's first message
    [
      'START_REFUSED by model at «Запустить с нуля», own agent',
      () =>
        libraryError(
          startRefused('model_not_allowed', 'anthropic/claude-sonnet-5-5'),
          {
            where: 'restart',
            kind: 'agent',
            own: true,
          },
        ),
      {
        place: { at: 'notice' },
        text: 'Модель Sonnet вам недоступна — агент не запустился. Откройте его и выберите другую модель',
        open: true,
      },
    ],
    [
      'START_REFUSED by model at «Запустить с нуля», a colleague’s deep agent',
      () =>
        libraryError(
          startRefused('model_not_allowed', 'anthropic/claude-sonnet-5-5'),
          {
            where: 'restart',
            kind: 'deep_agent',
            own: false,
          },
        ),
      {
        place: { at: 'notice' },
        text: 'Модель Sonnet вам недоступна — глубокий агент не запустился. Скопируйте его себе — копия получит вашу модель',
        open: true,
      },
    ],
    [
      'START_REFUSED record_unavailable at «Запустить с нуля»',
      () =>
        libraryError(startRefused('record_unavailable', null), {
          where: 'restart',
          kind: 'agent',
          own: true,
        }),
      {
        place: { at: 'notice' },
        text: 'Агент недоступен: его удалили или закрыли для вас',
        open: false,
      },
    ],
    [
      'START_REFUSED on the first message with the model → «чат», no «Открыть»',
      () =>
        libraryError(
          startRefused('model_not_allowed', 'anthropic/claude-haiku-5-5'),
          { where: 'first_message' },
        ),
      {
        place: { at: 'composer' },
        text: 'Модель Haiku вам недоступна — чат не запустился',
        open: false,
      },
    ],
    [
      'START_REFUSED on the first message without the model → MC-27',
      () =>
        libraryError(startRefused('model_not_allowed', null), {
          where: 'first_message',
        }),
      null,
    ],
    // model-providers DC-5, MP-09: a provider or default-model refusal names its reason (MC-11, MC-12)
    [
      'START_REFUSED model_not_configured on the first message → MC-11 under the field',
      () =>
        libraryError(startRefused('model_not_configured', null), {
          where: 'first_message',
        }),
      {
        place: { at: 'composer' },
        text: 'Модель для чата не настроена. Обратитесь к администратору Agent OS.',
        open: false,
      },
    ],
    [
      'START_REFUSED provider_disabled on the first message → MC-11 with the model',
      () =>
        libraryError(
          startRefused('provider_disabled', 'anthropic/claude-haiku-5-5'),
          { where: 'first_message' },
        ),
      {
        place: { at: 'composer' },
        text: 'Провайдер модели Haiku выключен. Обратитесь к администратору Agent OS.',
        open: false,
      },
    ],
    [
      'START_REFUSED provider_key_missing at «Запустить с нуля» → MC-12 with «Открыть»',
      () =>
        libraryError(
          startRefused('provider_key_missing', 'anthropic/claude-sonnet-5-5'),
          {
            where: 'restart',
            kind: 'deep_agent',
            own: false,
          },
        ),
      {
        place: { at: 'notice' },
        text: 'У провайдера модели Sonnet нет ключа — глубокий агент не запустился',
        open: true,
      },
    ],
    // unknown code and network
    [
      // UC-5 (AC-05.1, AC-05.2, DC-6): never the key, never the server text without its language mark.
      'an unmapped refusal shows the server text inside lang="en" within the Russian phrase',
      () =>
        libraryError(
          refusal(409, 'SOMETHING_NEW', undefined, 'Something odd'),
          { where: 'editor' },
        ),
      {
        place: { at: 'form' },
        text: 'Не удалось сохранить: <span lang="en">Something odd</span>',
        open: false,
      },
    ],
    [
      'network in a form or at «Запустить с нуля»',
      () => libraryError(network, { where: 'share' }),
      {
        place: { at: 'form' },
        text: 'Не удалось сохранить: нет связи с сервером',
        open: false,
      },
    ],
    [
      'network on a message → MC-27',
      () => libraryError(network, { where: 'message', kind: 'agent' }),
      null,
    ],
    [
      '5xx on a message → MC-27',
      () => libraryError(refusal(500, 'INTERNAL'), { where: 'message' }),
      null,
    ],
    // tool refusals: the model comes from `refusalDetail`
    [
      'refusal record_unavailable',
      () =>
        describeRefusal(t, 'record_unavailable', {
          tool: 'start_agent',
          kind: 'agent',
          model: null,
          recordId: 'r1',
          own: true,
        }),
      {
        text: 'Агент недоступен: его удалили или закрыли для вас',
        action: null,
      },
    ],
    [
      'refusal model_not_allowed of an own agent',
      () =>
        describeRefusal(t, 'model_not_allowed', {
          tool: 'start_agent',
          kind: 'agent',
          model: 'anthropic/claude-opus-5-5',
          recordId: 'r1',
          own: true,
        }),
      {
        text: 'Модель Opus вам недоступна — агент не запустился. Откройте его и выберите другую модель',
        action: { label: 'Открыть', recordId: 'r1' },
      },
    ],
    [
      'refusal model_not_allowed of a colleague’s deep agent',
      () =>
        describeRefusal(t, 'model_not_allowed', {
          tool: 'start_deep_agent',
          kind: 'deep_agent',
          model: 'anthropic/claude-sonnet-5-5',
          recordId: 'w1',
          own: false,
        }),
      {
        text: 'Модель Sonnet вам недоступна — глубокий агент не запустился. Скопируйте его себе — копия получит вашу модель',
        action: { label: 'Открыть', recordId: 'w1' },
      },
    ],
    [
      'refusal run_limit',
      () =>
        describeRefusal(t, 'run_limit', {
          tool: 'start_agent',
          kind: 'agent',
          model: null,
          recordId: null,
          own: true,
        }),
      { text: 'Предел вызовов исчерпан', action: null },
    ],
    [
      'refusal provider_missing → MC-12 with «Открыть»',
      () =>
        describeRefusal(t, 'provider_missing', {
          tool: 'start_agent',
          kind: 'agent',
          model: 'anthropic/claude-opus-5-5',
          recordId: 'r1',
          own: true,
        }),
      {
        text: 'Провайдер модели Opus не настроен — агент не запустился',
        action: { label: 'Открыть', recordId: 'r1' },
      },
    ],
    [
      'refusal model_not_configured → MC-12 without a model',
      () =>
        describeRefusal(t, 'model_not_configured', {
          tool: 'start_deep_agent',
          kind: 'deep_agent',
          model: null,
          recordId: 'w1',
          own: false,
        }),
      {
        text: 'Модель не настроена — глубокий агент не запустился',
        action: { label: 'Открыть', recordId: 'w1' },
      },
    ],
    [
      'refusal invalid_arguments of start_deep_agent → the platform text',
      () =>
        describeRefusal(t, 'invalid_arguments', {
          tool: 'start_deep_agent',
          kind: 'deep_agent',
          model: null,
          recordId: null,
          own: true,
        }),
      null,
    ],
    // Knowledge screen «Не найдено» (self-learning design-web.md, «Клиент API»)
    [
      'knowledge hidden: 404',
      () => isKnowledgeHidden(refusal(404, 'RECORD_NOT_FOUND')),
      true,
    ],
    [
      'knowledge hidden: 403 KNOWLEDGE_FORBIDDEN',
      () => isKnowledgeHidden(refusal(403, 'KNOWLEDGE_FORBIDDEN')),
      true,
    ],
    [
      'knowledge not hidden: 403 ADMIN_REQUIRED',
      () => isKnowledgeHidden(refusal(403, 'ADMIN_REQUIRED')),
      false,
    ],
    [
      'knowledge not hidden: 500',
      () => isKnowledgeHidden(refusal(500, 'INTERNAL')),
      false,
    ],
  ])('%s', (_, run, expected) => {
    expect(run()).toEqual(expected);
  });
});
