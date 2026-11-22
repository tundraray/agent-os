import { describe, expect, it } from 'vitest';
import {
  recordListText,
  type ChatRecord,
  type RecordOwnership,
  type UsableServer,
} from './record-listing';

const ID = '00000000-0000-4000-8000-000000000001';

function record(ownership: RecordOwnership, shared: boolean): ChatRecord {
  return {
    id: ID,
    kind: 'deep_agent',
    name: 'Разбор логов',
    description: 'Собирает логи\nи отвечает',
    version: 1,
    ownership,
    shared,
    body: {
      kind: 'deep_agent',
      content: {
        prompt: 'Разбери',
        servers: [],
        model: null,
        maxTurns: 20,
        subagents: [
          {
            name: 'сбор',
            description: 'Собирает',
            prompt: 'Собери',
            servers: ['logs'],
            model: null,
            maxTurns: 10,
            maxRuns: 2,
            taskList: false,
          },
        ],
        finalSubagent: null,
        taskList: true,
        selfLearning: false,
      },
    },
  };
}

const JIRA: UsableServer = { server: 'jira', tools: ['search_issues'] };
const NO_TOOLS: UsableServer = { server: 'logs', tools: [] };

// DC-7, AC-26.1 (rule), deep-agents Risks «Длинное описание серверов»: whose a record is, which servers
// are named, and the cut of a long answer.
describe('recordListText', () => {
  it.each([
    {
      label: 'own record, not shared',
      records: [record('own', false)],
      servers: [JIRA],
      maxChars: 10_000,
      has: [`- ${ID} | deep_agent | Разбор логов | yours | not shared | Собирает логи и отвечает`],
      lacks: [],
    },
    {
      label: "another employee's record opened to the role",
      records: [record('role', true)],
      servers: [JIRA],
      maxChars: 10_000,
      has: [`| opened to your role | shared |`],
      lacks: ['| yours |'],
    },
    {
      label: 'system record',
      records: [record('system', true)],
      servers: [JIRA],
      maxChars: 10_000,
      has: ['| system | shared |'],
      lacks: [],
    },
    {
      label: 'a server without an allowed tool is not named',
      records: [],
      servers: [JIRA, NO_TOOLS],
      maxChars: 10_000,
      has: ['You see no library records.', '- jira: search_issues'],
      lacks: ['logs'],
    },
    {
      label: 'no usable server',
      records: [],
      servers: [NO_TOOLS],
      maxChars: 10_000,
      has: ['You may use no MCP server.'],
      lacks: ['logs'],
    },
    {
      label: 'cut past the limit with a note',
      records: [record('own', false)],
      servers: [JIRA],
      maxChars: 80,
      has: ['Library records you see', '[cut: 4 more lines are not shown, the answer is limited to 80 characters]'],
      lacks: ['jira'],
    },
  ])('$label', ({ records, servers, maxChars, has, lacks }) => {
    const text = recordListText(records, servers, maxChars);
    for (const part of has) expect(text).toContain(part);
    for (const part of lacks) expect(text).not.toContain(part);
  });
});
