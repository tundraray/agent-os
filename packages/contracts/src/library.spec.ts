import { describe, expect, it } from 'vitest';
import { CreateRecordBodySchema } from './library';

const MODEL = 'anthropic/claude-haiku-5-5';

const agentContent = {
  prompt: 'Разбери платежи за день.',
  servers: ['logs'],
  model: MODEL,
  maxTurns: 20,
  agents: [],
  tools: [],
};
const agent = { kind: 'agent', name: 'разбор оплат', description: 'Ищет сбои оплат.', content: agentContent };

const executorWithoutRole = {
  name: 'Аналитик',
  prompt: 'Найди сбой.',
  servers: ['logs'],
  model: MODEL,
  maxTurns: 20,
  maxRuns: 3,
  tools: [],
  source: null,
};
const executor = { ...executorWithoutRole, role: 'Разбирает логи, когда нужен поиск сбоя.' };
const executorNamed = (name: string) => ({ ...executor, name });
const workflowContent = {
  coordinator: { rules: 'Сначала логи.', model: MODEL, maxTurns: 20 },
  executors: [executor],
  finalExecutor: null,
};
const workflow = { kind: 'workflow', name: 'дежурство', description: 'Разбор инцидента.', content: workflowContent };

const withAgent = (content: Record<string, unknown>) => ({ ...agent, content: { ...agentContent, ...content } });
const withWorkflow = (content: Record<string, unknown>) => ({
  ...workflow,
  content: { ...workflowContent, ...content },
});

// AC-06.3, AC-16.5 and Failure Mode "invalid option": the body schema is the 400 boundary that
// keeps a record of a wrong size or with a tool outside the closed set from reaching the service.
describe('record body: lengths, closed tool set and team size are bounded by the schema', () => {
  it.each<{ label: string; body: Record<string, unknown>; valid: boolean }>([
    // AC-06.3
    { label: 'name of 80 padded with spaces (trimmed)', body: { ...agent, name: `  ${'и'.repeat(80)}  ` }, valid: true },
    { label: 'empty name', body: { ...agent, name: '' }, valid: false },
    { label: 'name of spaces only', body: { ...agent, name: '   ' }, valid: false },
    { label: 'name of 81', body: { ...agent, name: 'и'.repeat(81) }, valid: false },
    // runtime Security Considerations: a name never adds a line to a tool description
    { label: 'name with a line break', body: { ...agent, name: 'разбор\n- оплат (ваша)' }, valid: false },
    { label: 'description of 301', body: { ...agent, description: 'о'.repeat(301) }, valid: false },
    // AgentContent
    { label: 'empty prompt', body: withAgent({ prompt: '' }), valid: false },
    { label: 'prompt of 20 001', body: withAgent({ prompt: 'п'.repeat(20_001) }), valid: false },
    { label: 'no model', body: withAgent({ model: undefined }), valid: false },
    { label: 'all servers once', body: withAgent({ servers: ['*'] }), valid: true },
    { label: 'all servers twice', body: withAgent({ servers: ['*', '*'] }), valid: false },
    { label: 'maxTurns 0', body: withAgent({ maxTurns: 0 }), valid: false },
    { label: 'maxTurns 1', body: withAgent({ maxTurns: 1 }), valid: true },
    { label: 'maxTurns 200', body: withAgent({ maxTurns: 200 }), valid: true },
    { label: 'maxTurns 201', body: withAgent({ maxTurns: 201 }), valid: false },
    {
      label: 'repeated agent id',
      body: withAgent({
        agents: ['0b6f3c1e-4d2a-4c8b-9f3e-1a2b3c4d5e6f', '0b6f3c1e-4d2a-4c8b-9f3e-1a2b3c4d5e6f'],
      }),
      valid: false,
    },
    { label: 'tool start_agent', body: withAgent({ tools: ['start_agent'] }), valid: true },
    { label: 'tool start_workflow', body: withAgent({ tools: ['start_workflow'] }), valid: false },
    { label: 'tool run_code', body: withAgent({ tools: ['run_code'] }), valid: false },
    // WorkflowContent
    { label: 'empty coordinator rules', body: withWorkflow({ coordinator: { ...workflowContent.coordinator, rules: '' } }), valid: true },
    {
      label: 'coordinator rules of 4 001',
      body: withWorkflow({ coordinator: { ...workflowContent.coordinator, rules: 'п'.repeat(4_001) } }),
      valid: false,
    },
    { label: '0 executors', body: withWorkflow({ executors: [] }), valid: false },
    {
      label: '10 executors',
      body: withWorkflow({ executors: Array.from({ length: 10 }, (_, i) => executorNamed(`Исполнитель ${i}`)) }),
      valid: true,
    },
    {
      label: '11 executors',
      body: withWorkflow({ executors: Array.from({ length: 11 }, (_, i) => executorNamed(`Исполнитель ${i}`)) }),
      valid: false,
    },
    { label: 'maxRuns 21', body: withWorkflow({ executors: [{ ...executor, maxRuns: 21 }] }), valid: false },
    // AC-16.5
    { label: 'executor without role', body: withWorkflow({ executors: [executorWithoutRole] }), valid: false },
    {
      label: 'executor name repeated in another case',
      body: withWorkflow({ executors: [executorNamed('Аналитик'), executorNamed('аналитик')] }),
      valid: false,
    },
    { label: 'final executor by name', body: withWorkflow({ finalExecutor: 'Аналитик' }), valid: true },
  ])('$label -> valid: $valid', ({ body, valid }) => {
    expect(CreateRecordBodySchema.safeParse(body).success).toBe(valid);
  });
});
