import { describe, expect, it } from 'vitest';
import {
  toolCoverage,
  type CoverageInput,
  type PersonalCoverageLevel,
  type RoleCoverageLevel,
  type ToolCoverage,
} from './access-levels';

const READ_TOOL = { tool: 'search', readOnly: true, enabled: true };
const CHANGE_TOOL = { tool: 'create', readOnly: false, enabled: true };
const OFF_TOOL = { tool: 'drop', readOnly: false, enabled: false };

const NO_PERSONAL: PersonalCoverageLevel = { level: 'none', marks: [] };
const role = (
  roleId: string,
  level: RoleCoverageLevel['level'],
  picked: string[] = [],
): RoleCoverageLevel => ({ roleId, level, picked });

type Row = {
  name: string;
  input: Omit<CoverageInput, 'superAdmin' | 'personal'> &
    Partial<Pick<CoverageInput, 'superAdmin' | 'personal'>>;
  expected: ToolCoverage;
};

// UC-2: AC-36.1, AC-36.3, AC-37.1, AC-37.2, AC-37.4, AC-16.2, AC-17.1, AC-17.2, AC-34.2, AC-38.3.
describe('coverage rule: switched off beats the super-administrator, a personal deny beats every role, read covers read tools only', () => {
  it.each<Row>([
    {
      name: 'a switched-off tool at level all is off for everyone',
      input: { tool: OFF_TOOL, roles: [role('sre', 'all')] },
      expected: { state: 'disabled', sources: [] },
    },
    {
      name: 'a switched-off tool is off for the super-administrator too',
      input: { tool: OFF_TOOL, roles: [], superAdmin: true },
      expected: { state: 'disabled', sources: [] },
    },
    {
      name: 'the super-administrator has the tool against a personal deny',
      input: {
        tool: CHANGE_TOOL,
        roles: [],
        superAdmin: true,
        personal: { level: 'denied', marks: [] },
      },
      expected: { state: 'available', sources: [{ kind: 'super_admin' }] },
    },
    {
      name: 'read covers a read tool the server listed later',
      input: { tool: READ_TOOL, roles: [role('everyone', 'read')] },
      expected: {
        state: 'available',
        sources: [{ kind: 'role', roleId: 'everyone' }],
      },
    },
    {
      name: 'read does not cover a changing tool',
      input: { tool: CHANGE_TOOL, roles: [role('everyone', 'read')] },
      expected: { state: 'none', sources: [] },
    },
    {
      name: 'read of one role and a pick of another give the read tool',
      input: {
        tool: READ_TOOL,
        roles: [role('everyone', 'read'), role('sre', 'pick', ['create'])],
      },
      expected: {
        state: 'available',
        sources: [{ kind: 'role', roleId: 'everyone' }],
      },
    },
    {
      name: 'read of one role and a pick of another give the picked changing tool',
      input: {
        tool: CHANGE_TOOL,
        roles: [role('everyone', 'read'), role('sre', 'pick', ['create'])],
      },
      expected: {
        state: 'available',
        sources: [{ kind: 'role', roleId: 'sre' }],
      },
    },
    {
      name: 'a personal deny mark beats a role at all',
      input: {
        tool: CHANGE_TOOL,
        roles: [role('sre', 'all')],
        personal: {
          level: 'pick',
          marks: [{ tool: 'create', effect: 'deny' }],
        },
      },
      expected: {
        state: 'denied',
        sources: [{ kind: 'role', roleId: 'sre' }],
      },
    },
    {
      name: 'a personal denied beats «Все сотрудники» at all',
      input: {
        tool: READ_TOOL,
        roles: [role('everyone', 'all')],
        personal: { level: 'denied', marks: [] },
      },
      expected: {
        state: 'denied',
        sources: [{ kind: 'role', roleId: 'everyone' }],
      },
    },
    {
      name: 'a personal allow mark without roles gives the tool from «лично»',
      input: {
        tool: CHANGE_TOOL,
        roles: [],
        personal: {
          level: 'pick',
          marks: [{ tool: 'create', effect: 'allow' }],
        },
      },
      expected: { state: 'available', sources: [{ kind: 'personal' }] },
    },
  ])('$name', ({ input, expected }) => {
    expect(
      toolCoverage({ superAdmin: false, personal: NO_PERSONAL, ...input }),
    ).toEqual(expected);
  });
});
