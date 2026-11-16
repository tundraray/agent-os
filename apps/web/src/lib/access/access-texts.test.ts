import { describe, expect, it } from 'vitest';
import type { MyModel, MyModels } from '@agent-os/contracts';
import { failureReasonText } from '@/lib/agents/format';
import { chatFailureText, quotaFailureText, quotaRowOf, refusalText } from './access-texts';

const SONNET: MyModel = {
  model: 'anthropic/claude-sonnet-5-5',
  name: 'Sonnet',
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
    { where: 'event line / report', text: failureReasonText('quota_exhausted').text, expected: 'квота исчерпана' },
    { where: 'event line / report', text: failureReasonText('model_not_allowed').text, expected: 'модель не разрешена' },
    { where: 'event line / report', text: failureReasonText('model_not_connected').text, expected: 'модель не подключена' },
    { where: 'event line / report', text: failureReasonText('no_models_allowed').text, expected: 'не разрешена ни одна модель' },
    { where: 'event line / report', text: failureReasonText('owner_disabled').text, expected: 'сотрудник отключён' },
    {
      where: 'quota failure line',
      text: quotaFailureText(SONNET, '2026-11'),
      expected: 'Сбой: квота Sonnet исчерпана — 100,40 $ из 100 $ за ноябрь',
    },
    { where: 'quota failure line without the row', text: quotaFailureText(null, '2026-11'), expected: 'Сбой: квота исчерпана' },
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
