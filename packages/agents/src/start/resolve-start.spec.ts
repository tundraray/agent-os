import type { AgentContent } from '@agent-os/contracts';
import type { ModelPrice } from '@agent-os/runtime';

import { type AuditRecord, OwnerDisabledError } from '../access-gate';
import {
  type AccessGateDoubleOptions,
  createAccessGateDouble,
  createLibraryDouble,
  createProviderRegistryDouble,
  type LibraryDouble,
} from '../testing';
import {
  auditStartRefusal,
  resolveStart,
  type StartResolution,
  type StartSource,
} from './resolve-start';
import type { DeepAgentSnapshot, RunSnapshot } from './snapshot';

// DC-3, DC-4, DC-5, AC-14.1, AC-14.3, AC-14.4 (rule): every kind of start takes its own source — only the
// built-in and by-id starts ask the library, on behalf of the starter and not the author; a record that is
// missing, hidden from the starter or of another kind is `record_unavailable`; the snapshot's model is
// checked by the access gate — out of the catalogue `model_not_connected`, without the right
// `model_not_allowed` with its id and an audit record; a spent quota does not stop the start.

const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const UNKNOWN_MODEL = 'acme/unknown-1';
const AUTHOR = '00000000-0000-4000-8000-0000000000a1';
const STARTER = '00000000-0000-4000-8000-0000000000b2';
const DELETED_ID = '00000000-0000-4000-8000-0000000000c3';

const PRICE: ModelPrice = {
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 5,
  cacheWriteUsdPerMTok: 1.25,
  cacheReadUsdPerMTok: 0.1,
};

function agentContent(model: string, agents: string[] = []): AgentContent & { model: string } {
  return { prompt: 'You help.', servers: [], model, maxTurns: 10, agents, tools: ['start_agent'] };
}

function subagent(name: string): DeepAgentSnapshot['content']['subagents'][number] {
  return {
    name,
    description: `Когда звать ${name}`,
    prompt: `You are ${name}.`,
    servers: [],
    model: HAIKU,
    maxTurns: 6,
    maxRuns: 2,
  };
}

/** The content of the author's deep agent: one subagent, no final one. */
function deepAgentContent(): DeepAgentSnapshot['content'] {
  return {
    prompt: 'You research.',
    servers: [],
    model: SONNET,
    maxTurns: 30,
    subagents: [subagent('gather')],
    finalSubagent: null,
    selfLearning: false,
  };
}

/** The records of a row: the author's agents and deep agent, and the system `chat`. */
function seed(library: LibraryDouble) {
  const visibleAgent = (name: string, model: string) =>
    library.add({
      kind: 'agent',
      name,
      ownerId: AUTHOR,
      everyone: true,
      content: agentContent(model),
    });
  const helper = visibleAgent('Сверка', HAIKU);
  const hidden = library.add({
    kind: 'agent',
    name: 'Черновик Ани',
    ownerId: AUTHOR,
    content: agentContent(HAIKU),
  });
  const agent = library.add({
    kind: 'agent',
    name: 'Разбор оплат',
    ownerId: AUTHOR,
    everyone: true,
    content: agentContent(HAIKU, [hidden, helper]),
  });
  const deepAgent = library.add({
    kind: 'deep_agent',
    name: 'Глубокий ресерч',
    ownerId: AUTHOR,
    everyone: true,
    content: deepAgentContent(),
  });
  const unknownModel = visibleAgent('Новая модель', UNKNOWN_MODEL);
  library.add({
    kind: 'agent',
    name: 'Главный чат',
    ownerId: null,
    everyone: true,
    builtinKey: 'chat',
    content: agentContent(HAIKU),
  });
  return { helper, hidden, agent, deepAgent, unknownModel };
}
type Ids = ReturnType<typeof seed>;

/** The deep agent's snapshot taken at its start (AC-16.3: its subagents need no library). */
function deepAgentSnapshot(ids: Ids): DeepAgentSnapshot {
  return {
    kind: 'deep_agent',
    name: 'Глубокий ресерч',
    origin: {
      recordId: ids.deepAgent,
      kind: 'deep_agent',
      version: 1,
      name: 'Глубокий ресерч',
      author: { id: AUTHOR, name: AUTHOR },
      builtinKey: null,
      subagent: null,
    },
    content: deepAgentContent(),
  };
}

/** An earlier agent snapshot of the hidden record: a fork or a restart copies it without the library. */
function ownSnapshot(ids: Ids, model: string): RunSnapshot {
  return {
    kind: 'agent',
    name: 'Черновик Ани',
    origin: {
      recordId: ids.hidden,
      kind: 'agent',
      version: 1,
      name: 'Черновик Ани',
      author: { id: AUTHOR, name: AUTHOR },
      builtinKey: null,
      subagent: null,
    },
    content: agentContent(model),
    agents: [],
  };
}

/** The outcome as one literal line: the snapshot's kind, name and startable agents, or the refusal. */
function outcome(resolution: StartResolution): string {
  if (resolution.kind === 'refused') {
    return `refused ${resolution.reason} ${resolution.model ?? '-'}`;
  }
  const { snapshot } = resolution;
  const agents =
    snapshot.kind === 'agent' ? ` [${snapshot.agents.map((agent) => agent.name).join(', ')}]` : '';
  return `${snapshot.kind} ${snapshot.name}${agents}`;
}

const SPENT: AccessGateDoubleOptions['refusedModels'] = {
  [HAIKU]: {
    kind: 'refused',
    reason: 'quota_exhausted',
    spentUsd: 10,
    quotaUsd: 10,
    month: '2026-11',
  },
};
const HAIKU_NOT_ALLOWED: AccessGateDoubleOptions['ownerModelRefusals'] = {
  [STARTER]: { [HAIKU]: { kind: 'refused', reason: 'model_not_allowed' } },
};

describe('resolveStart', () => {
  it.each<{
    case: string;
    source: (ids: Ids) => StartSource;
    gate?: Partial<AccessGateDoubleOptions>;
    expected: string;
    /** The records `resolve` was asked for, all on behalf of the starter. */
    resolved: (ids: Ids) => string[];
    /** Models of the `access_denied` records written. */
    audited?: string[];
  }>([
    {
      case: 'the root of a conversation takes the built-in record by its key',
      source: () => ({ kind: 'builtin', builtinKey: 'chat' }),
      expected: 'agent Главный чат []',
      resolved: () => [],
    },
    {
      case: "an agent by id keeps only the agents the starter sees, not the author's",
      source: (ids) => ({ kind: 'record', recordId: ids.agent, expected: 'agent' }),
      expected: 'agent Разбор оплат [Сверка]',
      resolved: (ids) => [ids.agent],
    },
    {
      case: 'a deep agent by id is its whole team',
      source: (ids) => ({ kind: 'record', recordId: ids.deepAgent, expected: 'deep_agent' }),
      expected: 'deep_agent Глубокий ресерч',
      resolved: (ids) => [ids.deepAgent],
    },
    {
      case: 'a record the author sees and the starter does not is unavailable',
      source: (ids) => ({ kind: 'record', recordId: ids.hidden, expected: 'agent' }),
      expected: 'refused record_unavailable -',
      resolved: (ids) => [ids.hidden],
    },
    {
      case: 'a deleted record is unavailable',
      source: () => ({ kind: 'record', recordId: DELETED_ID, expected: 'agent' }),
      expected: 'refused record_unavailable -',
      resolved: () => [DELETED_ID],
    },
    {
      case: 'a record of another kind is unavailable',
      source: (ids) => ({ kind: 'record', recordId: ids.deepAgent, expected: 'agent' }),
      expected: 'refused record_unavailable -',
      resolved: (ids) => [ids.deepAgent],
    },
    {
      case: 'a subagent comes from the deep agent without the library',
      source: (ids) => ({ kind: 'subagent', deepAgent: deepAgentSnapshot(ids), name: 'gather' }),
      expected: 'subagent gather',
      resolved: () => [],
    },
    {
      case: 'a subagent outside the team is unavailable',
      source: (ids) => ({ kind: 'subagent', deepAgent: deepAgentSnapshot(ids), name: 'nobody' }),
      expected: 'refused record_unavailable -',
      resolved: () => [],
    },
    {
      case: "a fork copies the caller's snapshot without the library",
      source: (ids) => ({ kind: 'fork', snapshot: ownSnapshot(ids, HAIKU) }),
      expected: 'agent Черновик Ани []',
      resolved: () => [],
    },
    {
      case: 'a restart whose model the starter may no longer use is refused with the model',
      source: (ids) => ({ kind: 'restart', snapshot: ownSnapshot(ids, HAIKU) }),
      gate: { ownerModelRefusals: HAIKU_NOT_ALLOWED },
      expected: `refused model_not_allowed ${HAIKU}`,
      resolved: () => [],
      audited: [HAIKU],
    },
    {
      case: 'a model out of the catalogue is not connected',
      source: (ids) => ({ kind: 'record', recordId: ids.unknownModel, expected: 'agent' }),
      expected: `refused model_not_connected ${UNKNOWN_MODEL}`,
      resolved: (ids) => [ids.unknownModel],
      audited: [UNKNOWN_MODEL],
    },
    {
      case: 'a spent quota does not stop the start',
      source: (ids) => ({ kind: 'record', recordId: ids.agent, expected: 'agent' }),
      gate: { refusedModels: SPENT },
      expected: 'agent Разбор оплат [Сверка]',
      resolved: (ids) => [ids.agent],
    },
  ])('$case', async ({ source, gate, expected, resolved, audited = [] }) => {
    const library = createLibraryDouble();
    const ids = seed(library);
    const entries: AuditRecord[] = [];
    const deps = {
      library,
      access: createAccessGateDouble({ prices: { [HAIKU]: PRICE, [SONNET]: PRICE }, ...gate }),
      providers: createProviderRegistryDouble({ anthropic: 'ready' }),
      audit: async (entry: AuditRecord) => void entries.push(entry),
    };

    const resolution = await resolveStart({ ownerId: STARTER, source: source(ids) }, deps);

    expect(outcome(resolution)).toBe(expected);
    expect(library.resolveCalls).toEqual(
      resolved(ids).map((recordId) => ({ viewerId: STARTER, recordId })),
    );
    // The procedure writes nothing; the caller writes the refused model's record once it is the outcome.
    expect(entries).toEqual([]);
    if (resolution.kind === 'refused') await auditStartRefusal(deps.audit, resolution);
    expect(entries.map((entry) => `${entry.actor} ${entry.objectId}`)).toEqual(
      audited.map((model) => `${STARTER} ${model}`),
    );
  });

  it('rejects a disabled starter with OwnerDisabledError', async () => {
    const library = createLibraryDouble();
    const ids = seed(library);
    const deps = {
      library,
      access: createAccessGateDouble({ prices: { [HAIKU]: PRICE }, refusedOwners: [STARTER] }),
      providers: createProviderRegistryDouble({ anthropic: 'ready' }),
    };

    const source: StartSource = { kind: 'record', recordId: ids.agent, expected: 'agent' };

    await expect(resolveStart({ ownerId: STARTER, source }, deps)).rejects.toBeInstanceOf(
      OwnerDisabledError,
    );
  });
});
