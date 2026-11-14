import type { Logger } from '@agent-os/common';

import { createWorkflows, type WorkflowsAgents } from './create-workflows.js';
import { SHIPPED_TEMPLATES } from './shipped-templates.js';
import { parseTemplates, toDefinitions, toLimits } from './template.js';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

interface RawTemplate {
  [field: string]: unknown;
  coordinator: Record<string, unknown>;
  agents: Record<string, unknown>[];
}

function validTemplate(): RawTemplate {
  return {
    name: 'demo-flow',
    title: 'Demo flow',
    description: 'Use for the demo.',
    coordinator: { prompt: 'Coordinate the executors.', maxTurns: 20 },
    agents: [
      {
        name: 'demo-gather',
        description: 'Gathers material.',
        prompt: 'Gather.',
        tools: [],
        mcpServers: ['fixture'],
        maxTurns: 10,
        maxRuns: 3,
      },
      {
        name: 'demo-answer',
        description: 'Writes the answer.',
        prompt: 'Answer.',
        tools: [],
        mcpServers: [],
        maxTurns: 5,
        maxRuns: 1,
      },
    ],
    finalAgent: 'demo-answer',
  };
}

type Mutate = (template: RawTemplate) => void;

// DC-1 (UC-E3): a bad template stops the start; the error names the template and the field path.
describe('parseTemplates refuses a bad template naming the template and the field path', () => {
  it('accepts a valid template', () => {
    expect(parseTemplates([validTemplate()]).map((template) => template.name)).toEqual([
      'demo-flow',
    ]);
  });

  it.each<[string, Mutate, string]>([
    ['an unknown field', (t) => (t.extra = 1), 'workflow template "demo-flow" is invalid at <root>'],
    ['a template name not in kebab-case', (t) => (t.name = 'Demo_Flow'), 'workflow template "Demo_Flow" is invalid at name'],
    ['an executor name not in kebab-case', (t) => (t.agents[0]!.name = 'DemoGather'), 'workflow template "demo-flow" is invalid at agents.0.name'],
    ['a repeated executor name', (t) => (t.agents[1]!.name = 'demo-gather'), 'workflow template "demo-flow" is invalid at agents.1.name'],
    ['a finalAgent outside the executors', (t) => (t.finalAgent = 'demo-other'), 'workflow template "demo-flow" is invalid at finalAgent'],
    ['maxRuns 0', (t) => (t.agents[0]!.maxRuns = 0), 'workflow template "demo-flow" is invalid at agents.0.maxRuns'],
    ['maxRuns 21', (t) => (t.agents[0]!.maxRuns = 21), 'workflow template "demo-flow" is invalid at agents.0.maxRuns'],
    ['maxTurns 0', (t) => (t.coordinator.maxTurns = 0), 'workflow template "demo-flow" is invalid at coordinator.maxTurns'],
    ['maxTurns 201', (t) => (t.agents[1]!.maxTurns = 201), 'workflow template "demo-flow" is invalid at agents.1.maxTurns'],
    ['an executor with start_workflow', (t) => (t.agents[0]!.tools = ['start_workflow']), 'workflow template "demo-flow" is invalid at agents.0.tools.0'],
  ])('refuses %s', (_case, mutate, expected) => {
    const template = validTemplate();
    mutate(template);
    expect(() => parseTemplates([template])).toThrow(expected);
  });

  // DC-1: the start goes no further than parsing — nothing is registered in agents before the error.
  it('createWorkflows with a bad template throws naming the template and the path and registers nothing', () => {
    const registered: string[] = [];
    const agents: WorkflowsAgents = {
      definitions: { register: (definition) => void registered.push(definition.name) },
      tools: { register: (tool) => void registered.push(tool.name) },
      sessions: {
        get: () => Promise.reject(new Error('not used')),
        list: () => Promise.reject(new Error('not used')),
        history: () => Promise.reject(new Error('not used')),
      },
    };
    const bad = validTemplate();
    bad.agents[0]!.maxRuns = 0;

    expect(() =>
      createWorkflows({ agents, logger: silentLogger, templates: [validTemplate(), bad] }),
    ).toThrow('workflow template "demo-flow" is invalid at agents.0.maxRuns');
    expect(registered).toEqual([]);
  });

  it('refuses two templates with one name', () => {
    expect(() => parseTemplates([validTemplate(), validTemplate()])).toThrow(
      'workflow template "demo-flow" is invalid at name',
    );
  });

  // AC-19.2: the shipped deep-research carries the limits and the coordinator model the design names.
  it('shipped deep-research parses', () => {
    const [template] = parseTemplates(SHIPPED_TEMPLATES);

    expect(template!.name).toBe('deep-research');
    expect(template!.coordinator.model).toBe('anthropic/claude-sonnet-5-5');
    expect(toLimits(template!)).toEqual({
      agents: { 'deep-research-plan': 1, 'deep-research-gather': 5, 'deep-research-answer': 2 },
      finalAgent: 'deep-research-answer',
    });
  });

  // KD-2: the coordinator gets the three built-in tools and the executors; the limits carry maxRuns and finalAgent.
  it('builds the coordinator definition and its limits', () => {
    const [template] = parseTemplates([validTemplate()]);
    const [coordinator, ...executors] = toDefinitions(template!);

    expect(coordinator).toEqual({
      name: 'demo-flow',
      description: 'Use for the demo.',
      prompt: 'Coordinate the executors.',
      tools: ['start_agent', 'message_agent'],
      mcpServers: [],
      agents: ['demo-gather', 'demo-answer'],
      maxTurns: 20,
    });
    expect(executors[0]).toEqual({
      name: 'demo-gather',
      description: 'Gathers material.',
      prompt: 'Gather.',
      tools: [],
      mcpServers: ['fixture'],
      agents: [],
      maxTurns: 10,
    });
    expect(toLimits(template!)).toEqual({
      agents: { 'demo-gather': 3, 'demo-answer': 1 },
      finalAgent: 'demo-answer',
    });
  });
});
