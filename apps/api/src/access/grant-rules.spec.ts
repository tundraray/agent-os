import type { GrantTargetBody } from '@agent-os/contracts';
import {
  grantRules,
  type GrantRuleInput,
  type GrantRuleResult,
} from './grant-rules.js';

const ROLE_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const modelTarget: GrantTargetBody = { kind: 'model', model: 'anthropic/a' };
const serverTarget: GrantTargetBody = { kind: 'server', server: 's' };
const toolTarget: GrantTargetBody = { kind: 'tool', server: 's', tool: 't' };

const modelAllow = (quotaUsd: number | null): GrantRuleInput => ({
  roleId: ROLE_ID,
  effect: 'allow',
  target: modelTarget,
  quotaUsd,
});
const ok: GrantRuleResult = { kind: 'ok' };
const invalid = (
  reason: 'deny_for_role' | 'quota_not_on_model_allow' | 'quota_out_of_range',
): GrantRuleResult => ({
  kind: 'invalid',
  reason,
});

type Row = { name: string; input: GrantRuleInput; expected: GrantRuleResult };

// DC-2 (GRANT_INVALID), design-access.md «Grant»: quotaUsd 0.01…1 000 000 in cents, only on a model allow.
describe('a grant is invalid when a role gets a deny or a quota is not on a model allow or outside 0.01…1 000 000 in cents', () => {
  it.each<Row>([
    {
      name: 'a deny for a role',
      input: { roleId: ROLE_ID, effect: 'deny', target: serverTarget },
      expected: invalid('deny_for_role'),
    },
    {
      name: 'a personal deny',
      input: { userId: USER_ID, effect: 'deny', target: toolTarget },
      expected: ok,
    },
    {
      name: 'a quota on a server right',
      input: {
        roleId: ROLE_ID,
        effect: 'allow',
        target: serverTarget,
        quotaUsd: 10,
      },
      expected: invalid('quota_not_on_model_allow'),
    },
    {
      name: 'a quota on a tool right',
      input: {
        userId: USER_ID,
        effect: 'allow',
        target: toolTarget,
        quotaUsd: 10,
      },
      expected: invalid('quota_not_on_model_allow'),
    },
    {
      name: 'a quota on a model deny',
      input: {
        userId: USER_ID,
        effect: 'deny',
        target: modelTarget,
        quotaUsd: 10,
      },
      expected: invalid('quota_not_on_model_allow'),
    },
    {
      name: 'a model allow without a quota',
      input: modelAllow(null),
      expected: ok,
    },
    {
      name: 'quota 0',
      input: modelAllow(0),
      expected: invalid('quota_out_of_range'),
    },
    {
      name: 'quota 0.001',
      input: modelAllow(0.001),
      expected: invalid('quota_out_of_range'),
    },
    { name: 'quota 0.01', input: modelAllow(0.01), expected: ok },
    {
      name: 'quota 0.29 (not exact in binary)',
      input: modelAllow(0.29),
      expected: ok,
    },
    { name: 'quota 1 000 000', input: modelAllow(1_000_000), expected: ok },
    {
      name: 'quota 1 000 000.01',
      input: modelAllow(1_000_000.01),
      expected: invalid('quota_out_of_range'),
    },
    {
      name: 'quota 12.345',
      input: modelAllow(12.345),
      expected: invalid('quota_out_of_range'),
    },
  ])('$name', ({ input, expected }) => {
    expect(grantRules(input)).toEqual(expected);
  });
});
