import { describe, expect, it } from 'vitest';
import type { MyModel, MyModels } from '@agent-os/contracts';
import { testFormatter } from '@/test/intl';

// Intl separates a Russian amount and its currency sign with U+00A0.
const NBSP = String.fromCharCode(0xa0);
import { chatFailureText, quotaFailureText, quotaRowOf, refusalText } from './access-texts';

const SONNET: MyModel = {
  model: 'anthropic/claude-sonnet-5-5',
  name: 'Sonnet',
  unavailableReason: null,
  spentUsd: 100.4,
  quotaUsd: 100,
  remainingUsd: 0,
  exhausted: true,
};

describe('access texts (MC-10, MC-11, MC-14, QS-01)', () => {
  // AC-20.2, AC-16.3, AC-22.1: a reason never falls through to «ошибка платформы»; the quota failure names model, spend, quota and month.
  it.each([
    { where: 'refusal', text: refusalText('no_access', null), expected: 'Нет доступа к инструменту' },
    {
      where: 'refusal',
      text: refusalText('model_not_allowed', 'anthropic/claude-sonnet-5-5'),
      expected: 'Модель не разрешена: Sonnet',
    },
    {
      where: 'refusal',
      text: refusalText('model_not_connected', 'anthropic/claude-opus-5-5'),
      expected: 'Модель не подключена: Opus',
    },
    { where: 'refusal without the model argument', text: refusalText('model_not_allowed', null), expected: 'Модель не разрешена' },
    { where: 'refusal outside MC-10', text: refusalText('depth_limit', null), expected: null },
    {
      where: 'chat reply error',
      text: chatFailureText('model_not_allowed', 'anthropic/claude-sonnet-5-5'),
      expected: 'Модель Sonnet вам не разрешена. Обратитесь к администратору Agent OS.',
    },
    {
      where: 'chat reply error',
      text: chatFailureText('model_not_connected', 'anthropic/claude-opus-5-5'),
      expected: 'Модель Opus не подключена. Обратитесь к администратору Agent OS.',
    },
    {
      where: 'chat reply error',
      text: chatFailureText('no_models_allowed', 'anthropic/claude-sonnet-5-5'),
      expected: 'Вам не разрешена ни одна модель. Обратитесь к администратору Agent OS.',
    },
    { where: 'chat reply error', text: chatFailureText('model_error', 'anthropic/claude-sonnet-5-5'), expected: 'Не удалось получить ответ.' },
    // model-providers AC-09.1–AC-09.5, AC-04.2, MC-11: each provider reason of the root is its own reply error.
    {
      where: 'chat reply error',
      text: chatFailureText('provider_missing', 'anthropic/claude-haiku-5-5'),
      expected: 'Провайдер модели Haiku не настроен. Обратитесь к администратору Agent OS.',
    },
    {
      where: 'chat reply error',
      text: chatFailureText('provider_disabled', 'anthropic/claude-haiku-5-5'),
      expected: 'Провайдер модели Haiku выключен. Обратитесь к администратору Agent OS.',
    },
    {
      where: 'chat reply error',
      text: chatFailureText('provider_key_missing', 'anthropic/claude-haiku-5-5'),
      expected: 'У провайдера модели Haiku нет ключа. Обратитесь к администратору Agent OS.',
    },
    {
      where: 'chat reply error',
      text: chatFailureText('provider_key_rejected', 'anthropic/claude-haiku-5-5'),
      expected: 'Провайдер модели Haiku отклонил ключ. Обратитесь к администратору Agent OS.',
    },
    {
      where: 'chat reply error',
      text: chatFailureText('provider_unavailable', 'anthropic/claude-haiku-5-5'),
      expected: 'Провайдер модели Haiku не отвечает. Попробуйте перегенерировать позже.',
    },
    {
      where: 'chat reply error',
      text: chatFailureText('provider_tools_rejected', 'anthropic/claude-haiku-5-5'),
      expected: 'Провайдер модели Haiku не принял описание инструментов. Обратитесь к администратору Agent OS.',
    },
    {
      where: 'quota failure line',
      text: quotaFailureText(testFormatter(), SONNET, '2026-11'),
      expected: `Сбой: квота Sonnet исчерпана — 100,40${NBSP}$ из 100${NBSP}$ за ноябрь`,
    },
    {
      where: 'quota failure line without the row',
      text: quotaFailureText(testFormatter(), null, '2026-11'),
      expected: 'Сбой: квота исчерпана',
    },
  ])('$where reads «$expected»', ({ text, expected }) => {
    expect(text).toBe(expected);
  });

  // QS-01: the amounts come from the row of the event's model only while it is the same month and the quota is still spent.
  it.each([
    { name: 'same model, month, exhausted', at: '2026-11-20T14:25:00.000Z', row: SONNET, expected: SONNET },
    { name: 'the event is from another month', at: '2026-10-31T23:59:00.000Z', row: SONNET, expected: null },
    { name: 'the quota was raised since', at: '2026-11-20T14:25:00.000Z', row: { ...SONNET, quotaUsd: 200, remainingUsd: 99.6, exhausted: false }, expected: null },
    { name: 'the model is no longer allowed', at: '2026-11-20T14:25:00.000Z', row: null, expected: null },
  ])('quotaRowOf: $name', ({ at, row, expected }) => {
    const models: MyModels = { month: '2026-11', models: row === null ? [] : [row] };
    expect(quotaRowOf(models, 'anthropic/claude-sonnet-5-5', at)).toEqual(expected);
  });
});
