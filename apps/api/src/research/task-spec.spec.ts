import type { ProposeResult, TaskSpec } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HandlerRegistry, type TaskHandler } from './handler.registry.js';
import { checkTaskSpec } from './task-spec.js';

const handler = (
  workflowType: string,
  workflowVersion: number,
): TaskHandler => ({
  workflowType,
  workflowVersion,
  inputSchema: z.object({ query: z.string().min(1) }),
  run: () => Promise.reject(new Error('not run in this spec')),
});

const validSpec: TaskSpec = {
  investigationId: '0b6f3a2e-6c1d-4a8e-9a57-1f0e2d3c4b5a',
  workflowType: 'fetch',
  workflowVersion: 1,
  input: { query: 'q' },
  inputRefs: [{ kind: 'page', ref: 'p-1', snapshot: '2026-10-31' }],
  expectedOutput: { description: 'all matches', completeness: 'all' },
  dependsOn: [],
  budget: { maxToolCalls: 3, maxRetries: 1, deadlineMs: 60_000, maxTokens: 0 },
};

const without = (key: keyof TaskSpec): Record<string, unknown> => {
  const rest: Record<string, unknown> = { ...validSpec };
  delete rest[key];
  return rest;
};

type Rejected = Extract<ProposeResult, { outcome: 'rejected' }>;

describe('checkTaskSpec — task spec validation and handler lookup (AC-02.1, AC-02.2)', () => {
  const registry = new HandlerRegistry();
  registry.register(handler('fetch', 1));

  it.each<{ name: string; spec: unknown; expected: Rejected | 'ok' }>([
    {
      name: 'a valid spec of a registered handler is accepted',
      spec: validSpec,
      expected: 'ok',
    },
    {
      name: 'no expectedOutput → invalid_spec at expectedOutput',
      spec: without('expectedOutput'),
      expected: {
        outcome: 'rejected',
        reason: 'invalid_spec',
        details: { path: 'expectedOutput' },
      },
    },
    {
      name: 'no budget → invalid_spec at budget',
      spec: without('budget'),
      expected: {
        outcome: 'rejected',
        reason: 'invalid_spec',
        details: { path: 'budget' },
      },
    },
    {
      name: 'an input ref without snapshot → invalid_spec at inputRefs.0.snapshot',
      spec: { ...validSpec, inputRefs: [{ kind: 'page', ref: 'p-1' }] },
      expected: {
        outcome: 'rejected',
        reason: 'invalid_spec',
        details: { path: 'inputRefs.0.snapshot' },
      },
    },
    {
      name: "input rejected by the handler's inputSchema → invalid_spec at input.query",
      spec: { ...validSpec, input: { query: '' } },
      expected: {
        outcome: 'rejected',
        reason: 'invalid_spec',
        details: { path: 'input.query' },
      },
    },
    {
      name: 'unknown workflowType → unknown_workflow',
      spec: { ...validSpec, workflowType: 'crawl' },
      expected: {
        outcome: 'rejected',
        reason: 'unknown_workflow',
        details: { workflowType: 'crawl', workflowVersion: 1 },
      },
    },
    {
      name: 'known workflowType with an unknown version → unknown_workflow',
      spec: { ...validSpec, workflowVersion: 2 },
      expected: {
        outcome: 'rejected',
        reason: 'unknown_workflow',
        details: { workflowType: 'fetch', workflowVersion: 2 },
      },
    },
  ])('$name', ({ spec, expected }) => {
    const result = checkTaskSpec(spec, registry);

    if (expected === 'ok') {
      expect(result).toMatchObject({ ok: true, spec: validSpec });
    } else {
      expect(result).toMatchObject({ ok: false, rejection: expected });
    }
  });

  it('a second handler of the same type and version fails registration, naming them (UC-3)', () => {
    const local = new HandlerRegistry();
    local.register(handler('fetch', 1));

    expect(() => local.register(handler('fetch', 1))).toThrow(
      'Handler of workflow "fetch" version 1 is already registered',
    );
  });
});
