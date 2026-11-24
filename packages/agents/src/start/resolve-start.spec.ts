import type {
  AgentContent,
  ChipRecord,
  DeepAgentContent,
} from '@agent-os/contracts';
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
  type NamedStartRequest,
  type NamedStartResolution,
  resolveNamedStart,
  resolveStart,
  type StartSource,
} from './resolve-start';
import type { RunStart } from './run-definition';

// DC-3, DC-4, DC-5, AC-14.1, AC-14.3, AC-14.4 (rule): every kind of start takes its own source — only the
// built-in and by-id starts ask the library, on behalf of the starter and not the author; a record that is
// missing, hidden from the starter or of another kind is `record_unavailable`; the run's model is checked by
// the access gate — out of the catalogue `model_not_connected`, without the right `model_not_allowed` with
// its id and an audit record; a spent quota does not stop the start.
// data-model design-agents.md DC-19 (KD-3, R19): the model is the version's, else the caller's, else — only at
// the root — the system one, else `model_not_configured`; DC-20: a model inherited from the caller is checked
// like any other, its refusal audited once. DC-24, DC-27 (KD-5, rule): a name starts the agent of the asked kind
// the starter sees, else a temporary agent — the default agent of that kind under the call's name — for an
// invisible and a missing name alike; never the chat; the name of a visible agent of the other kind is
// `other_kind`. The chip of the message a call answers (rule): the name of the chip starts the chosen record, not
// the winner of the name; another name, or a record the starter does not see, leaves the name rule to decide.

const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const UNKNOWN_MODEL = 'acme/unknown-1';
const AUTHOR = '00000000-0000-4000-8000-0000000000a1';
const COLLEAGUE = '00000000-0000-4000-8000-0000000000e5';
const STARTER = '00000000-0000-4000-8000-0000000000b2';
const DELETED_ID = '00000000-0000-4000-8000-0000000000c3';

const PRICE: ModelPrice = {
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 5,
  cacheWriteUsdPerMTok: 1.25,
  cacheReadUsdPerMTok: 0.1,
};

function agentContent(
  model: string | null,
  agents: string[] = [],
): AgentContent {
  return {
    prompt: 'You help.',
    servers: [],
    model,
    maxTurns: 10,
    agents,
    tools: ['start_agent'],
    taskList: false,
  };
}

function subagent(name: string): DeepAgentContent['subagents'][number] {
  return {
    name,
    description: `Когда звать ${name}`,
    prompt: `You are ${name}.`,
    servers: [],
    model: HAIKU,
    maxTurns: 6,
    maxRuns: 2,
    taskList: false,
  };
}

/** The content of the author's deep agent: one subagent, no final one. */
function deepAgentContent(): DeepAgentContent {
  return {
    prompt: 'You research.',
    servers: [],
    model: SONNET,
    maxTurns: 30,
    subagents: [subagent('gather')],
    finalSubagent: null,
    taskList: true,
    listDelegation: true,
    selfLearning: false,
    scripts: [],
  };
}

/**
 * The records of a row: the author's agents and deep agent, a colleague's later agent under the name of the
 * author's «Сверка», and the default agents every employee sees — `chat` on `chatModel`, `general-purpose`
 * without a model and the default deep agent.
 */
function seed(library: LibraryDouble, chatModel: string | null) {
  const visibleAgent = (name: string, model: string | null) =>
    library.add({
      kind: 'agent',
      name,
      ownerId: AUTHOR,
      everyone: true,
      content: agentContent(model),
    });
  const helper = visibleAgent('Сверка', HAIKU);
  // Created later than `helper`: the name rule never starts it.
  const namesake = library.add({
    kind: 'agent',
    name: 'Сверка',
    ownerId: COLLEAGUE,
    everyone: true,
    content: agentContent(SONNET),
  });
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
  const noModel = visibleAgent('Без модели', null);
  library.add({
    kind: 'agent',
    name: 'Главный чат',
    ownerId: null,
    everyone: true,
    builtinKey: 'chat',
    content: agentContent(chatModel),
  });
  const generalPurpose = library.add({
    kind: 'agent',
    name: 'general-purpose',
    ownerId: null,
    everyone: true,
    builtinKey: 'agent',
    content: agentContent(null),
  });
  const defaultDeepAgent = library.add({
    kind: 'deep_agent',
    name: 'Глубокий агент',
    ownerId: null,
    everyone: true,
    builtinKey: 'deep_agent',
    content: deepAgentContent(),
  });
  return {
    helper,
    namesake,
    hidden,
    agent,
    deepAgent,
    unknownModel,
    noModel,
    generalPurpose,
    defaultDeepAgent,
  };
}
type Ids = ReturnType<typeof seed>;

/** An earlier run of the hidden record: a fork or a restart repeats it without the library. */
function ownRun(ids: Ids, model: string): RunStart {
  return {
    version: {
      id: '00000000-0000-4000-8000-0000000000d4',
      agentId: ids.hidden,
      number: 1,
      kind: 'agent',
      content: agentContent(model),
    },
    name: 'Черновик Ани',
    subagent: null,
    model,
  };
}

/** A start by the name a call gives: the name and the kind the tool starts. */
type NamedCall = Pick<NamedStartRequest, 'name' | 'kind'>;

/** A call by name carries the kind of agent it starts; a source carries where its start comes from. */
function isNamedCall(start: StartSource | NamedCall): start is NamedCall {
  return start.kind === 'agent' || start.kind === 'deep_agent';
}

/**
 * The outcome as one literal line: the version's kind, the run's name and model, or the refusal, or the kind
 * a name of the other kind belongs to.
 */
function outcome(resolution: NamedStartResolution): string {
  if (resolution.kind === 'refused') {
    return `refused ${resolution.reason} ${resolution.model ?? '-'}`;
  }
  if (resolution.kind === 'other_kind') return `other_kind ${resolution.found}`;
  const { run } = resolution;
  return `${run.version.kind} ${run.name} ${run.model}`;
}

/** The agent whose version the run started on; `null` — no run. */
function startedAgent(resolution: NamedStartResolution): string | null {
  return resolution.kind === 'started' ? resolution.run.version.agentId : null;
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
    /** A start by its source, or a call by name. */
    source: (ids: Ids) => StartSource | NamedCall;
    /** The chip of the message a call by name answers; none by default. */
    chip?: (ids: Ids) => ChipRecord;
    /** The caller's conversation model; `null` — a root (the default). */
    callerModel?: string | null;
    /** The model of the default agent `chat`; Haiku by default. */
    chatModel?: string | null;
    gate?: Partial<AccessGateDoubleOptions>;
    expected: string;
    /** The records `resolve` was asked for, all on behalf of the starter. */
    resolved: (ids: Ids) => string[];
    /** Models of the `access_denied` records written. */
    audited?: string[];
    /** The agent whose version a call by name started on. */
    agent?: (ids: Ids) => string;
  }>([
    {
      case: 'the root of a conversation takes the default agent by its key, on its model',
      source: () => ({ kind: 'builtin', builtinKey: 'chat' }),
      expected: `agent Главный чат ${HAIKU}`,
      resolved: () => [],
    },
    {
      case: 'a root whose agent has no model takes the system model',
      source: () => ({ kind: 'builtin', builtinKey: 'chat' }),
      chatModel: null,
      gate: { defaultChatModel: SONNET },
      expected: `agent Главный чат ${SONNET}`,
      resolved: () => [],
    },
    {
      case: 'a root without either model is not configured',
      source: () => ({ kind: 'builtin', builtinKey: 'chat' }),
      chatModel: null,
      expected: 'refused model_not_configured -',
      resolved: () => [],
    },
    {
      case: 'an agent by id runs on its version’s model, not the caller’s',
      source: (ids) => ({
        kind: 'record',
        recordId: ids.agent,
        expected: 'agent',
      }),
      callerModel: SONNET,
      expected: `agent Разбор оплат ${HAIKU}`,
      resolved: (ids) => [ids.agent],
    },
    {
      // DC-19: the parent's model, not the system one.
      case: 'a child whose agent has no model takes the caller’s model',
      source: (ids) => ({
        kind: 'record',
        recordId: ids.noModel,
        expected: 'agent',
      }),
      callerModel: SONNET,
      gate: { defaultChatModel: HAIKU },
      expected: `agent Без модели ${SONNET}`,
      resolved: (ids) => [ids.noModel],
    },
    {
      // DC-20: the inherited model is checked for the starter, and its refusal is audited once.
      case: 'an inherited model the starter may not use is refused with the model',
      source: (ids) => ({
        kind: 'record',
        recordId: ids.noModel,
        expected: 'agent',
      }),
      callerModel: HAIKU,
      gate: { ownerModelRefusals: HAIKU_NOT_ALLOWED },
      expected: `refused model_not_allowed ${HAIKU}`,
      resolved: (ids) => [ids.noModel],
      audited: [HAIKU],
    },
    {
      case: 'a deep agent by id runs on its version',
      source: (ids) => ({
        kind: 'record',
        recordId: ids.deepAgent,
        expected: 'deep_agent',
      }),
      callerModel: HAIKU,
      expected: `deep_agent Глубокий ресерч ${SONNET}`,
      resolved: (ids) => [ids.deepAgent],
    },
    {
      // «Старт», row «перезапуск агента или корня»: the restart keeps the restarted conversation's name.
      case: 'a restarted temporary agent keeps its call’s name, not the default agent’s',
      source: (ids) => ({
        kind: 'record',
        recordId: ids.generalPurpose,
        expected: 'agent',
        name: 'log-analyst',
      }),
      callerModel: SONNET,
      expected: `agent log-analyst ${SONNET}`,
      resolved: (ids) => [ids.generalPurpose],
    },
    {
      case: 'a record the author sees and the starter does not is unavailable',
      source: (ids) => ({
        kind: 'record',
        recordId: ids.hidden,
        expected: 'agent',
      }),
      expected: 'refused record_unavailable -',
      resolved: (ids) => [ids.hidden],
    },
    {
      case: 'a deleted record is unavailable',
      source: () => ({
        kind: 'record',
        recordId: DELETED_ID,
        expected: 'agent',
      }),
      expected: 'refused record_unavailable -',
      resolved: () => [DELETED_ID],
    },
    {
      case: 'a record of another kind is unavailable',
      source: (ids) => ({
        kind: 'record',
        recordId: ids.deepAgent,
        expected: 'agent',
      }),
      expected: 'refused record_unavailable -',
      resolved: (ids) => [ids.deepAgent],
    },
    {
      case: "a fork repeats the caller's run without the library",
      source: (ids) => ({ kind: 'fork', run: ownRun(ids, HAIKU) }),
      callerModel: HAIKU,
      expected: `agent Черновик Ани ${HAIKU}`,
      resolved: () => [],
    },
    {
      case: 'a restart whose model the starter may no longer use is refused with the model',
      source: (ids) => ({ kind: 'restart', run: ownRun(ids, HAIKU) }),
      callerModel: HAIKU,
      gate: { ownerModelRefusals: HAIKU_NOT_ALLOWED },
      expected: `refused model_not_allowed ${HAIKU}`,
      resolved: () => [],
      audited: [HAIKU],
    },
    {
      case: 'a model out of the catalogue is not connected',
      source: (ids) => ({
        kind: 'record',
        recordId: ids.unknownModel,
        expected: 'agent',
      }),
      expected: `refused model_not_connected ${UNKNOWN_MODEL}`,
      resolved: (ids) => [ids.unknownModel],
      audited: [UNKNOWN_MODEL],
    },
    {
      case: 'a name the starter sees starts that agent under its own name, whatever the case',
      source: () => ({ name: 'разбор оплат', kind: 'agent' }),
      callerModel: SONNET,
      expected: `agent Разбор оплат ${HAIKU}`,
      resolved: () => [],
      agent: (ids) => ids.agent,
    },
    {
      // DC-24: an agent the author sees and the starter does not is not told apart from a missing one.
      case: 'a name the starter does not see starts a temporary general-purpose under that name',
      source: () => ({ name: 'Черновик Ани', kind: 'agent' }),
      callerModel: SONNET,
      expected: `agent Черновик Ани ${SONNET}`,
      resolved: () => [],
      agent: (ids) => ids.generalPurpose,
    },
    {
      case: 'the chat is never started by name',
      source: () => ({ name: 'Главный чат', kind: 'agent' }),
      callerModel: SONNET,
      expected: `agent Главный чат ${SONNET}`,
      resolved: () => [],
      agent: (ids) => ids.generalPurpose,
    },
    {
      case: 'a missing deep agent name starts a temporary default deep agent under that name',
      source: () => ({ name: 'Ресерч логов', kind: 'deep_agent' }),
      callerModel: HAIKU,
      expected: `deep_agent Ресерч логов ${SONNET}`,
      resolved: () => [],
      agent: (ids) => ids.defaultDeepAgent,
    },
    {
      // DC-27: start_agent with a deep agent's name starts nothing.
      case: 'the name of a deep agent the starter sees, asked as an agent, is of the other kind',
      source: () => ({ name: 'Глубокий ресерч', kind: 'agent' }),
      callerModel: HAIKU,
      expected: 'other_kind deep_agent',
      resolved: () => [],
    },
    {
      case: 'the name of the chip starts the chosen record, not the winner of the name',
      source: () => ({ name: 'сверка', kind: 'agent' }),
      chip: (ids) => ({ id: ids.namesake, kind: 'agent', name: 'Сверка' }),
      callerModel: HAIKU,
      expected: `agent Сверка ${SONNET}`,
      resolved: (ids) => [ids.namesake],
      agent: (ids) => ids.namesake,
    },
    {
      case: 'a name other than the chip’s is left to the name rule',
      source: () => ({ name: 'Сверка', kind: 'agent' }),
      chip: (ids) => ({ id: ids.agent, kind: 'agent', name: 'Разбор оплат' }),
      callerModel: SONNET,
      expected: `agent Сверка ${HAIKU}`,
      resolved: () => [],
      agent: (ids) => ids.helper,
    },
    {
      // An invisible chosen record answers as a missing one: the start is the one without a chip.
      case: 'a chip of a record the starter no longer sees is left to the name rule',
      source: () => ({ name: 'Сверка', kind: 'agent' }),
      chip: (ids) => ({ id: ids.hidden, kind: 'agent', name: 'Сверка' }),
      callerModel: SONNET,
      expected: `agent Сверка ${HAIKU}`,
      resolved: (ids) => [ids.hidden],
      agent: (ids) => ids.helper,
    },
    {
      case: 'a spent quota does not stop the start',
      source: (ids) => ({
        kind: 'record',
        recordId: ids.agent,
        expected: 'agent',
      }),
      gate: { refusedModels: SPENT },
      expected: `agent Разбор оплат ${HAIKU}`,
      resolved: (ids) => [ids.agent],
    },
  ])(
    '$case',
    async ({
      source,
      chip,
      callerModel = null,
      chatModel = HAIKU,
      gate,
      expected,
      resolved,
      audited = [],
      agent,
    }) => {
      const library = createLibraryDouble();
      const ids = seed(library, chatModel);
      const entries: AuditRecord[] = [];
      const deps = {
        library,
        access: createAccessGateDouble({
          prices: { [HAIKU]: PRICE, [SONNET]: PRICE },
          ...gate,
        }),
        providers: createProviderRegistryDouble({ anthropic: 'ready' }),
        audit: async (entry: AuditRecord) => void entries.push(entry),
      };

      const start = source(ids);
      const resolution = isNamedCall(start)
        ? await resolveNamedStart(
            {
              ownerId: STARTER,
              ...start,
              callerModel,
              chip: chip?.(ids) ?? null,
            },
            deps,
          )
        : await resolveStart(
            { ownerId: STARTER, source: start, callerModel },
            deps,
          );

      expect(outcome(resolution)).toBe(expected);
      if (agent !== undefined)
        expect(startedAgent(resolution)).toBe(agent(ids));
      expect(library.resolveCalls).toEqual(
        resolved(ids).map((recordId) => ({ viewerId: STARTER, recordId })),
      );
      // The procedure writes nothing; the caller writes the refused model's record once it is the outcome.
      expect(entries).toEqual([]);
      if (resolution.kind === 'refused')
        await auditStartRefusal(deps.audit, resolution);
      expect(
        entries.map((entry) => `${entry.actor} ${entry.objectId}`),
      ).toEqual(audited.map((model) => `${STARTER} ${model}`));
    },
  );

  it('rejects a disabled starter with OwnerDisabledError', async () => {
    const library = createLibraryDouble();
    const ids = seed(library, HAIKU);
    const deps = {
      library,
      access: createAccessGateDouble({
        prices: { [HAIKU]: PRICE },
        refusedOwners: [STARTER],
      }),
      providers: createProviderRegistryDouble({ anthropic: 'ready' }),
    };

    const source: StartSource = {
      kind: 'record',
      recordId: ids.agent,
      expected: 'agent',
    };

    await expect(
      resolveStart({ ownerId: STARTER, source, callerModel: null }, deps),
    ).rejects.toBeInstanceOf(OwnerDisabledError);
  });
});
