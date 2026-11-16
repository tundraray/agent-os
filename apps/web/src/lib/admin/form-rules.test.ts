import { describe, expect, it } from 'vitest';
import {
  accountRules,
  hoursToMinutes,
  minutesToHours,
  modelRules,
  providerRules,
  quotaRules,
  quotaUsdOf,
  roleNameRules,
  serverRules,
  signInSettingsRules,
  type ModelValues,
} from './form-rules';

const account = { login: 'anna', name: 'Анна', email: 'anna@example.com' };
const settings = { publicUrl: 'https://agent-os.example', idleHours: '8', absoluteHours: '24' };
const oauthServer = { name: 'sentry-prod', url: 'https://mcp.sentry.dev/mcp', mode: 'oauth', sharedToken: '' } as const;
const prices = { inputUsdPerMTok: '1', outputUsdPerMTok: '5', cacheWriteUsdPerMTok: '1,25', cacheReadUsdPerMTok: '0,1' };
const model: ModelValues = { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', prices, longContext: null };
const withThreshold = (aboveInputTokens: string): ModelValues => ({ ...model, longContext: { aboveInputTokens, prices } });

const PASSWORD = 'Пароль — от 12 до 256 знаков';
const IDLE = 'Введите от 0,25 до 24 часов с шагом 0,25';
const QUOTA = 'Квота — от 0,01 до 1 000 000 $, не больше двух знаков после запятой';
const SERVER_NAME = 'Имя — от 1 до 32 знаков: строчные латинские буквы, цифры и дефис, например sentry-prod';
const SERVER_URL = 'Введите адрес, который начинается с https://';
const THRESHOLD = 'Порог — целое число больше нуля';

describe('panel form rules (DC-4, DC-7, DC-14, GR-01, AD-09, AD-11, AD-14, AD-16)', () => {
  it.each<[string, () => unknown, unknown]>([
    // DC-4, AD-16
    ['empty account fields', () => accountRules({ login: ' ', name: '', email: '', password: 'a'.repeat(12) }), {
      login: 'Введите логин',
      name: 'Введите имя',
      email: 'Введите почту',
    }],
    ['a password of 11 characters', () => accountRules({ ...account, password: 'a'.repeat(11) }), { password: PASSWORD }],
    ['a password of 12 characters', () => accountRules({ ...account, password: 'a'.repeat(12) }), {}],
    ['a password of 256 characters', () => accountRules({ ...account, password: 'a'.repeat(256) }), {}],
    ['a password of 257 characters', () => accountRules({ ...account, password: 'a'.repeat(257) }), { password: PASSWORD }],
    // DC-7, AD-14
    ['«0,25» hours as minutes', () => hoursToMinutes('0,25'), 15],
    ['480 minutes as hours', () => minutesToHours(480), '8'],
    ['15 minutes as hours', () => minutesToHours(15), '0,25'],
    ['idle «0,3» is off the step', () => signInSettingsRules({ ...settings, idleHours: '0,3' }), { idleHours: IDLE }],
    ['idle «0,25» under a total of «24» passes', () => signInSettingsRules({ ...settings, idleHours: '0,25' }), {}],
    ['idle «24,25» is above the bound', () => signInSettingsRules({ ...settings, idleHours: '24,25', absoluteHours: '720' }), {
      idleHours: IDLE,
    }],
    ['total «4» below idle «8»', () => signInSettingsRules({ ...settings, absoluteHours: '4' }), {
      absoluteHours: 'Общий срок не может быть меньше срока без активности',
    }],
    ['total «1,5» is not whole', () => signInSettingsRules({ ...settings, idleHours: '1', absoluteHours: '1,5' }), {
      absoluteHours: 'Введите целое число от 1 до 720',
    }],
    ['total «721» is above the bound', () => signInSettingsRules({ ...settings, absoluteHours: '721' }), {
      absoluteHours: 'Введите целое число от 1 до 720',
    }],
    ['a public address without a scheme', () => signInSettingsRules({ ...settings, publicUrl: 'agent-os.example' }), {
      publicUrl: 'Введите полный адрес, например https://agent-os.example',
    }],
    // DC-14, GR-01
    ['an empty quota is no quota', () => [quotaRules({ quota: '' }), quotaUsdOf('')], [{}, null]],
    ['quota «0,009»', () => quotaRules({ quota: '0,009' }), { quota: QUOTA }],
    ['quota «0,01»', () => [quotaRules({ quota: '0,01' }), quotaUsdOf('0,01')], [{}, 0.01]],
    ['quota «0,29»', () => [quotaRules({ quota: '0,29' }), quotaUsdOf('0,29')], [{}, 0.29]],
    ['quota «1 000 000»', () => [quotaRules({ quota: '1 000 000' }), quotaUsdOf('1 000 000')], [{}, 1_000_000]],
    ['quota «1000000,01»', () => quotaRules({ quota: '1000000,01' }), { quota: QUOTA }],
    ['quota «12,345»', () => quotaRules({ quota: '12,345' }), { quota: QUOTA }],
    // AD-09
    ['server name «Sentry»', () => serverRules({ ...oauthServer, name: 'Sentry' }), { name: SERVER_NAME }],
    ['server name «sentry-prod»', () => serverRules(oauthServer), {}],
    ['a server name of 33 characters', () => serverRules({ ...oauthServer, name: 'a'.repeat(33) }), { name: SERVER_NAME }],
    ['server address http://example.com', () => serverRules({ ...oauthServer, url: 'http://example.com' }), { url: SERVER_URL }],
    ['server address http://localhost:4100/x passes: plain http only for localhost', () => serverRules({ ...oauthServer, url: 'http://localhost:4100/x' }), {}],
    ['a shared server without a token', () => serverRules({ ...oauthServer, mode: 'shared', sharedToken: '' }), {
      sharedToken: 'Введите токен — до 4096 знаков',
    }],
    ['a shared token of 4097 characters', () => serverRules({ ...oauthServer, mode: 'shared', sharedToken: 't'.repeat(4097) }), {
      sharedToken: 'Введите токен — до 4096 знаков',
    }],
    // AD-11
    ['model id openai/x', () => modelRules({ ...model, id: 'openai/x' }), { id: 'ID — в виде anthropic/<имя>' }],
    ['model id anthropic/a/b', () => modelRules({ ...model, id: 'anthropic/a/b' }), { id: 'ID — в виде anthropic/<имя>' }],
    ['a model name of 81 characters', () => modelRules({ ...model, name: 'м'.repeat(81) }), {
      name: 'Название — от 1 до 80 знаков',
    }],
    ['price «-1»', () => modelRules({ ...model, prices: { ...prices, outputUsdPerMTok: '-1' } }), {
      outputUsdPerMTok: 'Введите цену — число от 0',
    }],
    ['price «0,5»', () => modelRules({ ...model, prices: { ...prices, outputUsdPerMTok: '0,5' } }), {}],
    ['threshold «0»', () => modelRules(withThreshold('0')), { aboveInputTokens: THRESHOLD }],
    ['threshold «1,5»', () => modelRules(withThreshold('1,5')), { aboveInputTokens: THRESHOLD }],
    ['threshold «200000»', () => modelRules(withThreshold('200000')), {}],
    // MC-26, MC-27
    ['an empty role name', () => roleNameRules({ name: '  ' }), { name: 'Введите название' }],
    ['a provider name of 61 characters', () => providerRules({ name: 'G'.repeat(61) }), {
      name: 'Название — от 1 до 60 знаков',
    }],
    ['an issuer over http', () => providerRules({ name: 'Okta', issuer: 'http://login.example.com' }), {
      issuer: 'Введите полный адрес, например https://agent-os.example',
    }],
  ])('%s', (_name, actual, expected) => {
    expect(actual()).toEqual(expected);
  });
});
