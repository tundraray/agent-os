import {
  decideEmployeeAudience,
  decideSystemAudience,
  type EmployeeAudienceInput,
  type SystemAudienceInput,
} from './audience-rules';

const SRE = '00000000-0000-4000-8000-0000000000a1';
const FINANCE = '00000000-0000-4000-8000-0000000000a2';
const GHOST_ROLE = '00000000-0000-4000-8000-0000000000a3';
const BORIS = '00000000-0000-4000-8000-0000000000b1';
const GHOST_USER = '00000000-0000-4000-8000-0000000000b2';

function employeeAudience(
  fields: Partial<EmployeeAudienceInput>,
): EmployeeAudienceInput {
  return {
    currentRoleIds: [],
    roleIds: [],
    ownerRoleIds: [SRE],
    banned: false,
    ...fields,
  };
}

function systemAudience(
  fields: Partial<SystemAudienceInput>,
): SystemAudienceInput {
  return {
    builtinKey: null,
    roleIds: [SRE],
    userIds: [BORIS],
    existingRoleIds: [SRE],
    existingUserIds: [BORIS],
    ...fields,
  };
}

const allowed = { kind: 'allowed' };
const refused = (reason: string) => ({ kind: 'refused', reason });

type Question =
  | { kind: 'employee'; input: EmployeeAudienceInput }
  | { kind: 'system'; input: SystemAudienceInput };

function ask(question: Question): unknown {
  if (question.kind === 'employee')
    return decideEmployeeAudience(question.input);
  return decideSystemAudience(question.input);
}

// Flow 2, DC-4: AC-04.1; panel audience (audience_fixed, holder_not_found).
describe('audience rule: an owner opens a record only to their own roles and not under a ban, a system audience names existing holders and the chat audience is fixed', () => {
  it.each<{ name: string; question: Question; expected: unknown }>([
    {
      name: 'the owner opens the record to their role',
      question: {
        kind: 'employee',
        input: employeeAudience({ roleIds: [SRE] }),
      },
      expected: allowed,
    },
    {
      name: 'AC-04.1: an added role the owner is not in',
      question: {
        kind: 'employee',
        input: employeeAudience({ roleIds: [SRE, FINANCE] }),
      },
      expected: refused('role_not_member'),
    },
    {
      name: 'AC-04.1: a role that does not exist',
      question: {
        kind: 'employee',
        input: employeeAudience({ roleIds: [GHOST_ROLE] }),
      },
      expected: refused('role_not_member'),
    },
    {
      name: 'DC-4: a role the record is open to stays after the owner left it',
      question: {
        kind: 'employee',
        input: employeeAudience({
          currentRoleIds: [FINANCE],
          roleIds: [FINANCE, SRE],
        }),
      },
      expected: allowed,
    },
    {
      name: 'a ban refuses any role',
      question: {
        kind: 'employee',
        input: employeeAudience({ roleIds: [SRE], banned: true }),
      },
      expected: refused('sharing_banned'),
    },
    {
      name: 'a ban lets the owner make the record personal',
      question: {
        kind: 'employee',
        input: employeeAudience({ currentRoleIds: [SRE], banned: true }),
      },
      expected: allowed,
    },
    {
      name: 'the admin sets existing roles and employees',
      question: { kind: 'system', input: systemAudience({}) },
      expected: allowed,
    },
    {
      name: 'the main-chat record audience is fixed',
      question: {
        kind: 'system',
        input: systemAudience({ builtinKey: 'chat' }),
      },
      expected: refused('audience_fixed'),
    },
    {
      name: 'a role that does not exist',
      question: {
        kind: 'system',
        input: systemAudience({ roleIds: [SRE, GHOST_ROLE] }),
      },
      expected: refused('holder_not_found'),
    },
    {
      name: 'an employee who does not exist',
      question: {
        kind: 'system',
        input: systemAudience({ userIds: [GHOST_USER] }),
      },
      expected: refused('holder_not_found'),
    },
  ])('$name', ({ question, expected }) => {
    expect(ask(question)).toEqual(expected);
  });
});
