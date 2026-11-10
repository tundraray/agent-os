import { describe, expect, it } from 'vitest';
import { BASE_TOOLS } from './tool-registry.js';

// design-agent-core.md, Базовые инструменты, `investigation_read`; DC-30: the arguments are one object at the root, so
// the per-view rules a union of one object per view kept are checked in code. A view takes only its own fields, and
// `records` requires `page`; the refusal names the field, as the union's did.
// Defects caught: a field of another view accepted (a cursor on the plan, a run on records), `records` without a page
// accepted, an accepted call of a view refused by the flat schema.

const investigationRead = BASE_TOOLS.find((tool) => tool.name === 'investigation_read')?.argsSchema;

describe('investigation_read arguments: one object at the root, the fields of each view checked in code', () => {
  if (investigationRead === undefined || investigationRead === 'result_form') {
    throw new Error('the base tools have no investigation_read with an argument schema');
  }
  const schema = investigationRead;

  it.each<[string, unknown]>([
    ['the plan', { view: 'plan' }],
    ['the claims from a cursor', { view: 'claims', cursor: '3' }],
    ['the record pages', { view: 'record_pages' }],
    ['the records of a page from a number and a cursor', { view: 'records', page: 'p-1', from: 2, cursor: '1' }],
    ['the list of runs', { view: 'runs', cursor: '0' }],
    ['one run from a byte offset', { view: 'runs', run: 'r-1', from: 0 }],
  ])('accepts %s', (_case, args) => {
    expect(schema.safeParse(args)).toMatchObject({ success: true, data: args });
  });

  it.each<[string, unknown, Record<string, unknown>]>([
    ['a cursor on the plan', { view: 'plan', cursor: '0' }, { code: 'unrecognized_keys', keys: ['cursor'] }],
    ['a page on the claims', { view: 'claims', page: 'p-1' }, { code: 'unrecognized_keys', keys: ['page'] }],
    ['a run and an offset on the record pages', { view: 'record_pages', run: 'r-1', from: 0 }, { code: 'unrecognized_keys', keys: ['run', 'from'] }],
    ['a run on the records', { view: 'records', page: 'p-1', run: 'r-1' }, { code: 'unrecognized_keys', keys: ['run'] }],
    ['a page on the runs', { view: 'runs', page: 'p-1' }, { code: 'unrecognized_keys', keys: ['page'] }],
    ['the records without a page', { view: 'records', from: 0 }, { code: 'invalid_type', path: ['page'] }],
    ['the records with an empty page', { view: 'records', page: '' }, { code: 'too_small', path: ['page'] }],
    ['a negative offset', { view: 'runs', run: 'r-1', from: -1 }, { code: 'too_small', path: ['from'] }],
    ['a view the tool does not have', { view: 'memory' }, { code: 'invalid_value', path: ['view'] }],
    ['a field no view takes', { view: 'plan', limit: 5 }, { code: 'unrecognized_keys', keys: ['limit'] }],
  ])('refuses %s', (_case, args, issue) => {
    const parsed = schema.safeParse(args);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([expect.objectContaining(issue)]);
  });
});
