import { describe, expect, it } from 'vitest';
import { CreateRecordBodySchema, DeepAgentContentSchema } from './library';

const MODEL = 'anthropic/claude-haiku-5-5';

const agentContent = {
  prompt: 'Разбери платежи за день.',
  servers: ['logs'],
  model: MODEL,
  maxTurns: 20,
  agents: [],
  tools: [],
};
const agent = {
  kind: 'agent',
  name: 'разбор оплат',
  description: 'Ищет сбои оплат.',
  content: agentContent,
};

const withAgent = (content: Record<string, unknown>) => ({
  ...agent,
  content: { ...agentContent, ...content },
});
// AC-06.3 and Failure Mode "invalid option": the body schema is the 400 boundary that
// keeps a record of a wrong size or with a tool outside the closed set from reaching the service.
describe('record body: lengths and the closed tool set are bounded by the schema', () => {
  it.each<{ label: string; body: Record<string, unknown>; valid: boolean }>([
    // AC-06.3
    {
      label: 'name of 80 padded with spaces (trimmed)',
      body: { ...agent, name: `  ${'и'.repeat(80)}  ` },
      valid: true,
    },
    { label: 'empty name', body: { ...agent, name: '' }, valid: false },
    {
      label: 'name of spaces only',
      body: { ...agent, name: '   ' },
      valid: false,
    },
    {
      label: 'name of 81',
      body: { ...agent, name: 'и'.repeat(81) },
      valid: false,
    },
    // runtime Security Considerations: a name never adds a line to a tool description
    {
      label: 'name with a line break',
      body: { ...agent, name: 'разбор\n- оплат (ваша)' },
      valid: false,
    },
    {
      label: 'description of 301',
      body: { ...agent, description: 'о'.repeat(301) },
      valid: false,
    },
    // AgentContent
    { label: 'empty prompt', body: withAgent({ prompt: '' }), valid: false },
    {
      label: 'prompt of 20 001',
      body: withAgent({ prompt: 'п'.repeat(20_001) }),
      valid: false,
    },
    { label: 'no model', body: withAgent({ model: undefined }), valid: false },
    {
      label: 'all servers once',
      body: withAgent({ servers: ['*'] }),
      valid: true,
    },
    {
      label: 'all servers twice',
      body: withAgent({ servers: ['*', '*'] }),
      valid: false,
    },
    { label: 'maxTurns 0', body: withAgent({ maxTurns: 0 }), valid: false },
    { label: 'maxTurns 1', body: withAgent({ maxTurns: 1 }), valid: true },
    { label: 'maxTurns 200', body: withAgent({ maxTurns: 200 }), valid: true },
    { label: 'maxTurns 201', body: withAgent({ maxTurns: 201 }), valid: false },
    {
      label: 'repeated agent id',
      body: withAgent({
        agents: [
          '0b6f3c1e-4d2a-4c8b-9f3e-1a2b3c4d5e6f',
          '0b6f3c1e-4d2a-4c8b-9f3e-1a2b3c4d5e6f',
        ],
      }),
      valid: false,
    },
    {
      label: 'tool start_agent',
      body: withAgent({ tools: ['start_agent'] }),
      valid: true,
    },
    {
      label: 'tool start_deep_agent',
      body: withAgent({ tools: ['start_deep_agent'] }),
      valid: false,
    },
    {
      label: 'tool run_code',
      body: withAgent({ tools: ['run_code'] }),
      valid: false,
    },
  ])('$label -> valid: $valid', ({ body, valid }) => {
    expect(CreateRecordBodySchema.safeParse(body).success).toBe(valid);
  });
});

const subagent = {
  name: 'Аналитик',
  description: 'Разбирает логи, когда нужен поиск сбоя.',
  prompt: 'Найди сбой.',
  servers: ['logs'],
  model: MODEL,
  maxTurns: 20,
  maxRuns: 3,
};
const subagentNamed = (name: string) => ({ ...subagent, name });
const deepAgentContent = {
  prompt: 'Разбери инцидент командой.',
  servers: [],
  model: MODEL,
  maxTurns: 30,
  subagents: [subagent],
  finalSubagent: null,
};

// deep-agents design-task-list.md KD-2, AC-16.1: a record that names no task-list flag keeps a list for
// an agent and a deep agent, never for a subagent — a wrong default would hand every subagent the task tools.
describe('the task-list flag a record leaves out', () => {
  it('is on for an agent and a deep agent and off for a subagent', () => {
    const agentBody = CreateRecordBodySchema.parse(agent);
    const deepAgent = DeepAgentContentSchema.parse(deepAgentContent);

    expect({
      agent: agentBody.content.taskList,
      deepAgent: deepAgent.taskList,
      subagent: deepAgent.subagents[0]?.taskList,
    }).toEqual({ agent: true, deepAgent: true, subagent: false });
  });
});

// UC-1 (AC-27.1, AC-01.1): the content schema is the tool's argument schema, so the chat learns the
// path and the rule of a broken deep agent from the refusal before any card.
describe('deep agent content is refused with the path and the rule', () => {
  it.each<{
    label: string;
    content: Record<string, unknown>;
    issue: Record<string, unknown>;
  }>([
    {
      label: '11 subagents',
      content: {
        subagents: Array.from({ length: 11 }, (_, i) =>
          subagentNamed(`Сабагент ${i}`),
        ),
      },
      issue: { path: ['subagents'], code: 'too_big', maximum: 10 },
    },
    {
      label: 'final subagent outside the team',
      content: { finalSubagent: 'Писатель' },
      issue: {
        path: ['finalSubagent'],
        code: 'custom',
        message: 'no such subagent',
      },
    },
    {
      label: 'empty prompt of a subagent',
      content: { subagents: [{ ...subagent, prompt: '' }] },
      issue: {
        path: ['subagents', 0, 'prompt'],
        code: 'too_small',
        minimum: 1,
      },
    },
    {
      label: 'subagent name repeated in another case',
      content: {
        subagents: [subagentNamed('Аналитик'), subagentNamed('аналитик')],
      },
      issue: {
        path: ['subagents'],
        code: 'custom',
        message: 'subagent names repeat',
      },
    },
    // deep-agents/design-task.md, Contract «Инструмент `task`»: the built-in subagent's name is not a record's.
    {
      label: 'subagent named general-purpose',
      content: { subagents: [subagentNamed('General-Purpose')] },
      issue: {
        path: ['subagents', 0, 'name'],
        code: 'custom',
        message: 'general-purpose is the name of the built-in subagent',
      },
    },
  ])('$label', ({ content, issue }) => {
    const result = DeepAgentContentSchema.safeParse({
      ...deepAgentContent,
      ...content,
    });

    expect(result.error?.issues).toContainEqual(expect.objectContaining(issue));
  });
});
