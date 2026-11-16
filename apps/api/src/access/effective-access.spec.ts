import type { GrantEffect, GrantTargetBody } from '@agent-os/contracts';
import {
  effectiveAccess,
  type EffectiveAccess,
  type GrantRow,
  type ModelAccess,
} from './effective-access.js';

const A = 'anthropic/a';
const B = 'anthropic/b';

let nextId = 0;
function grant(
  effect: GrantEffect,
  target: GrantTargetBody,
  quotaUsd: number | null = null,
): GrantRow {
  nextId += 1;
  return { id: `g${nextId}`, effect, target, quotaUsd };
}
const server = (name: string): GrantTargetBody => ({
  kind: 'server',
  server: name,
});
const tool = (serverName: string, toolName: string): GrantTargetBody => ({
  kind: 'tool',
  server: serverName,
  tool: toolName,
});
const model = (id: string): GrantTargetBody => ({ kind: 'model', model: id });

type Question =
  | { kind: 'tools'; server: string; registry: string[] }
  | { kind: 'model'; model: string }
  | { kind: 'allowedModels' };

function ask(answer: EffectiveAccess, question: Question): unknown {
  if (question.kind === 'tools')
    return question.registry.filter((t) => answer.tool(question.server, t));
  if (question.kind === 'model') return answer.model(question.model);
  return answer.allowedModels();
}

const roleQuota50 = grant('allow', model(A), 50);
const roleQuota20 = grant('allow', model(A), 20);
const personalQuota30 = grant('allow', model(A), 30);
const roleNoQuota = grant('allow', model(A));
const quotaParts = (...rows: GrantRow[]) =>
  rows.map((row) => ({ grantId: row.id, quotaUsd: row.quotaUsd }));

type Row = {
  name: string;
  grants: GrantRow[];
  question: Question;
  expected: unknown;
};

// KD-2, UC-4: AC-16.1, AC-16.2, AC-17.1, AC-17.2, AC-17.3, AC-21.1, AC-21.2, AC-21.5, DC-1, Invariant 2.
describe('effective rights: a server right covers its tools, a personal tool right gives that tool only, a deny wins over any allow, quotas add up and one grant without a quota lifts the limit', () => {
  it.each<Row>([
    {
      name: 'a role right on a server gives all its tools',
      grants: [grant('allow', server('backoffice'))],
      question: {
        kind: 'tools',
        server: 'backoffice',
        registry: ['read', 'write'],
      },
      expected: ['read', 'write'],
    },
    {
      name: 'a personal tool right without the server gives that tool only',
      grants: [grant('allow', tool('tracker', 'create'))],
      question: {
        kind: 'tools',
        server: 'tracker',
        registry: ['create', 'list'],
      },
      expected: ['create'],
    },
    {
      name: 'a personal tool deny beats the role server right',
      grants: [
        grant('allow', server('backoffice')),
        grant('deny', tool('backoffice', 'write')),
      ],
      question: {
        kind: 'tools',
        server: 'backoffice',
        registry: ['read', 'write'],
      },
      expected: ['read'],
    },
    {
      name: 'a server deny beats a personal right on its tool',
      grants: [
        grant('deny', server('logs')),
        grant('allow', tool('logs', 'search')),
      ],
      question: { kind: 'tools', server: 'logs', registry: ['search', 'tail'] },
      expected: [],
    },
    {
      name: 'a right on a tool missing from the registry list gives nothing',
      grants: [grant('allow', tool('s', 'ghost'))],
      question: { kind: 'tools', server: 's', registry: ['a', 'b'] },
      expected: [],
    },
    {
      name: 'a right on another server gives nothing here',
      grants: [grant('allow', server('other'))],
      question: { kind: 'tools', server: 's', registry: ['a'] },
      expected: [],
    },
    {
      name: 'a model deny beats the role model right',
      grants: [grant('allow', model(A)), grant('deny', model(A))],
      question: { kind: 'model', model: A },
      expected: { allowed: false } satisfies ModelAccess,
    },
    {
      name: 'a model without any right is closed',
      grants: [grant('allow', model(B))],
      question: { kind: 'model', model: A },
      expected: { allowed: false } satisfies ModelAccess,
    },
    {
      name: 'quotas 50 + 20 + personal 30 add up to 100',
      grants: [roleQuota50, roleQuota20, personalQuota30],
      question: { kind: 'model', model: A },
      expected: {
        allowed: true,
        quotaUsd: 100,
        parts: quotaParts(roleQuota50, roleQuota20, personalQuota30),
      } satisfies ModelAccess,
    },
    {
      name: 'cent quotas add up to the cent',
      grants: [grant('allow', model(A), 0.1), grant('allow', model(A), 0.2)],
      question: { kind: 'model', model: A },
      expected: expect.objectContaining({ allowed: true, quotaUsd: 0.3 }),
    },
    {
      name: 'a role without a quota and a role with quota 20 give no limit',
      grants: [roleNoQuota, roleQuota20],
      question: { kind: 'model', model: A },
      expected: {
        allowed: true,
        quotaUsd: null,
        parts: quotaParts(roleNoQuota, roleQuota20),
      } satisfies ModelAccess,
    },
    {
      name: 'the role without a quota added later still lifts the limit',
      grants: [roleQuota20, roleNoQuota],
      question: { kind: 'model', model: A },
      expected: {
        allowed: true,
        quotaUsd: null,
        parts: quotaParts(roleQuota20, roleNoQuota),
      } satisfies ModelAccess,
    },
    {
      name: 'allowed models leave out denied ones',
      grants: [
        grant('allow', model(A)),
        grant('allow', model(B)),
        grant('deny', model(B)),
      ],
      question: { kind: 'allowedModels' },
      expected: [A],
    },
  ])('$name', ({ grants, question, expected }) => {
    expect(ask(effectiveAccess(grants), question)).toEqual(expected);
  });
});
