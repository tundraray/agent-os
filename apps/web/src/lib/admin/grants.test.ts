import type { Grant, GrantTarget } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';
import { orphanGrantIds } from './grants';

const grant = (id: string, target: GrantTarget): Grant => ({
  id,
  holder: {
    kind: 'role',
    id: '7a3c4b1e-0000-4000-8000-000000000001',
    name: 'Аналитики',
  },
  effect: 'allow',
  target,
  quotaUsd: null,
  createdAt: '2026-11-16T09:00:00.000Z',
});

const registry = [{ name: 'sentry-prod' }];
const toolsByServer = new Map([['sentry-prod', [{ name: 'search_issues' }]]]);

describe('orphanGrantIds (DC-13)', () => {
  it.each<[string, Grant, string[]]>([
    [
      'a grant on a registered server is not an orphan',
      grant('g1', { kind: 'server', server: 'sentry-prod' }),
      [],
    ],
    [
      'a grant on a listed tool is not an orphan',
      grant('g2', {
        kind: 'tool',
        server: 'sentry-prod',
        tool: 'search_issues',
      }),
      [],
    ],
    [
      'a grant on a tool gone from the server is an orphan',
      grant('g3', {
        kind: 'tool',
        server: 'sentry-prod',
        tool: 'delete_issue',
      }),
      ['g3'],
    ],
    [
      'a grant on a server gone from the registry is an orphan',
      grant('g4', { kind: 'server', server: 'github' }),
      ['g4'],
    ],
    [
      'a grant on a tool of a server gone from the registry is an orphan',
      grant('g5', { kind: 'tool', server: 'github', tool: 'create_issue' }),
      ['g5'],
    ],
    [
      'a grant on a model is never an orphan',
      grant('g6', {
        kind: 'model',
        model: 'anthropic/claude-gone',
        modelName: 'Claude Gone',
      }),
      [],
    ],
  ])('%s', (_name, subject, expected) => {
    expect([...orphanGrantIds([subject], registry, toolsByServer)]).toEqual(
      expected,
    );
  });
});
