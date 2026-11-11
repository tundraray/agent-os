import type { ResolveModel, RoleModel, TokenCounter } from '@agent-os/engine';
import { loadScenarioSet, scenarioKey } from '@agent-os/mcp-fixture';
import { BACKOFFICE_SOURCE_ID, FIXTURE_SOURCE_ID } from '@agent-os/sources';
import { MockLanguageModelV4 } from 'ai/test';
import {
  type AgentCallView,
  agentCallView,
  type AgentRecognizer,
  agentTurnCharacters,
  recognizeAgents,
  researchAgentTurn,
  type ResearchScript,
  toolCallsAnswer,
  type WorkerGather,
} from './researchFlowAgents.js';
import { agentPromptsOf } from './researchFlowConfig.js';

/**
 * The agent models of the real engine in the chat-entry child's path `research-flow` (agent-runtime / research-flow
 * E2E-2, source-planning / catalog-planning E2E-1), modelled on `selfCheckModels.ts`: one `MockLanguageModelV4` per model
 * id behind `resolveModel`, playing one fixed journey ({@link EngineJourneyName}) with the agents of the loaded
 * configuration. The default journey: `researchFlowAgents.ts` calls the planner and one worker,
 * which reads one slice of the fixture logs (`search_logs`) and writes {@link ENGINE_JOURNEY}`.observation` and
 * `.causal`; a verifier per claim — a record with a trace supports the claim, the type is `causal` for the causal claim
 * and `observation` otherwise; and the answer agent, which answers with every input claim and chooses all of them for
 * the summary, so the engine's rule that keeps a causal claim out of the summary is what removes it.
 *
 * The double reads its packets by their structure only (the tagged slots of the prologue packets). It tells the two
 * claims apart by exact equality of a claim text with a text this double wrote: it recognises its own script, it does
 * not interpret text.
 */

/** The journey of E2E-1: what the employee asks, what the worker states and what the chat model replies. */
export const ENGINE_JOURNEY = {
  goal: 'Почему замедлились ответы provider-adapter?',
  tokenBudget: 400_000,
  observation:
    'provider-adapter записал ошибки в первые десять минут 15 сентября',
  causal: 'ошибки provider-adapter вызваны релизом 15 сентября',
  /** Chat model replies to the plain turns, in order: the first question, its regenerate, the next question. */
  replies: [
    'Пока идёт ресерч, проверь графики задержек.',
    'Посмотри графики задержек и очередь.',
    'Ответ ресерча выше: ошибки подтверждены записями.',
  ],
} as const;

/**
 * Which journey the scripted agents and the chat model of the child play (`E2E_ENGINE_JOURNEY`):
 *
 * - `provider-adapter` (default) — {@link ENGINE_JOURNEY} on the fixture logs alone (agent-runtime / research-flow E2E-2);
 * - `two-sources` — the question of {@link TWO_SOURCES_SCENARIO} (source-planning / catalog-planning E2E-1 S1, S3): the
 *   planner names `fixture`, the worker gathers from `fixture` and then from `backoffice` and points its claim at both
 *   pages; with an empty catalog the root `synthesis` answers from model knowledge;
 * - `revocation-hold` / `revocation-resume` — the two processes of E2E-1 S2 on the same scenario: the worker gathers a
 *   page from `backoffice`, and in `revocation-hold` its next turn waits until the process stops it; in
 *   `revocation-resume` it asks `backoffice` twice more, then gathers from `fixture` and points its claim at both pages.
 */
export type EngineJourneyName =
  'provider-adapter' | 'two-sources' | 'revocation-hold' | 'revocation-resume';

/** The variable that carries the journey to the child; empty means `provider-adapter`. */
export const ENGINE_JOURNEY_VARIABLE = 'E2E_ENGINE_JOURNEY';

const JOURNEY_NAMES: readonly EngineJourneyName[] = [
  'provider-adapter',
  'two-sources',
  'revocation-hold',
  'revocation-resume',
];

/** The journey of the variable's value; an unknown value fails loudly. */
export function engineJourneyOf(value: string | undefined): EngineJourneyName {
  if (value === undefined || value === '') return 'provider-adapter';
  const journey = JOURNEY_NAMES.find((name) => name === value);
  if (journey === undefined) {
    throw new Error(
      `${ENGINE_JOURNEY_VARIABLE}=${value} is not one of ${JOURNEY_NAMES.join(', ')}`,
    );
  }
  return journey;
}

/** The scenario of the two-source journeys: its cause is seen only in the logs and the back office together. */
const TWO_SOURCES_SCENARIO = {
  setName: 'two-sources',
  scenarioId: 'method-declined-01',
} as const;

/** `FIXTURE_SCENARIO` of a journey's children: both fixture processes serve it; empty for the dataset of `provider-adapter`. */
export function fixtureScenarioOf(journey: EngineJourneyName): string {
  return journey === 'provider-adapter'
    ? ''
    : `${TWO_SOURCES_SCENARIO.setName}/${TWO_SOURCES_SCENARIO.scenarioId}`;
}

/** What the test and the child both need of {@link TWO_SOURCES_SCENARIO}: its recorded question and its change time. */
export interface TwoSourcesFacts {
  readonly question: string;
  readonly changeAt: string;
}

/** The recorded question and change time of {@link TWO_SOURCES_SCENARIO}, from the scenario's key. */
export function twoSourcesFacts(): TwoSourcesFacts {
  const loaded = loadScenarioSet(TWO_SOURCES_SCENARIO.setName);
  if (!loaded.ok) {
    throw new Error(
      `scenario set ${TWO_SOURCES_SCENARIO.setName} does not load: ${loaded.reason}: ${loaded.detail}`,
    );
  }
  const scenario = loaded.set.scenarios.find(
    ({ scenarioId }) => scenarioId === TWO_SOURCES_SCENARIO.scenarioId,
  );
  if (scenario === undefined) {
    throw new Error(
      `scenario set ${TWO_SOURCES_SCENARIO.setName} has no scenario ${TWO_SOURCES_SCENARIO.scenarioId}`,
    );
  }
  const key = scenarioKey(scenario);
  return { question: key.question, changeAt: key.facts.changeAt };
}

/** The goal the chat model passes to `deepResearch` in a journey. */
export function journeyGoal(journey: EngineJourneyName): string {
  return journey === 'provider-adapter'
    ? ENGINE_JOURNEY.goal
    : twoSourcesFacts().question;
}

/**
 * The claim of the two-source journeys and the text the root `synthesis` writes when the catalog is empty (model
 * knowledge): texts of this double, recognised by equality only.
 */
export const TWO_SOURCES_TEXTS = {
  observation:
    'ошибки оплаты выросли после изменения, записи логов и заказы бэк-офиса это показывают',
  assumption:
    'рост ошибок оплаты обычно связан с отказами одного способа оплаты',
} as const;

/**
 * Files the child loads instead of the defaults (E2E-2): `processFile` — the JSON of the only process configuration
 * (`ENGINE_PROCESSES`); `groupTablesDir` — the directory of the group tables `calibrate` wrote. Without them the child
 * loads the shipped configuration.
 */
export interface EngineFiles {
  readonly processFile: string;
  readonly groupTablesDir: string;
}

/** The variable that carries the process file to the child; only the child reads it (the tables go as `RESEARCH_GROUP_TABLES_DIR`). */
export const ENGINE_FILES_VARIABLES = {
  processFile: 'E2E_ENGINE_PROCESS_FILE',
} as const satisfies Partial<Record<keyof EngineFiles, string>>;

/**
 * The variable that picks the path of `E2E_ENGINE_SCRIPTED_ROLES=1`: {@link RESEARCH_FLOW_PATH} is the chat launch of the
 * shipped v3 (agent-runtime / research-flow E2E-2), the only path there is.
 */
export const ENGINE_PATH_VARIABLE = 'E2E_ENGINE_PATH';
export const RESEARCH_FLOW_PATH = 'research-flow';

/** IPC to the harness: the start failed; the error's `code` and message, before the child exits non-zero. */
export interface StartFailedMessage {
  readonly kind: 'startFailed';
  readonly code: string | null;
  readonly message: string;
}

/** IPC from the harness: send back the input of every chat model call so far. */
export interface ChatCallsRequest {
  readonly kind: 'chatCalls';
}

/** IPC to the harness: the messages (without the system messages) of every chat model call, in arrival order. */
export interface ChatCallsMessage {
  readonly kind: 'chatCalls';
  readonly calls: readonly (readonly unknown[])[];
}

type GenerateOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const USAGE: GenerateResult['usage'] = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

/** The slice the sub-question reads: one page of fixture records, as the engine's own E2E reads it. */
const SUBQUESTION_SLICE = {
  from: '2026-09-15T00:00:00.000Z',
  to: '2026-09-15T00:10:00.000Z',
  service: 'provider-adapter',
  pageSize: 20,
};

function textOfRole(options: GenerateOptions, role: 'system' | 'user'): string {
  return options.prompt
    .flatMap((message) => {
      if (message.role !== role) return [];
      if (typeof message.content === 'string') return [message.content];
      return message.content.flatMap((part) =>
        part.type === 'text' ? [part.text] : [],
      );
    })
    .join('\n');
}

/** The content of the `<tag>` slot of a prologue packet. */
function slot(user: string, tag: string): string {
  const open = `<${tag}>\n`;
  const start = user.indexOf(open);
  const end = start < 0 ? -1 : user.indexOf(`\n</${tag}>`, start + open.length);
  if (end < 0) {
    throw new Error(`engineScriptedRoles: the packet has no <${tag}> slot`);
  }
  return user.slice(start + open.length, end);
}

const jsonSlot = <T>(user: string, tag: string): T =>
  JSON.parse(slot(user, tag)) as T;

/**
 * The closed assessment: `<claim>` holds the claim JSON, `<data>` one JSON line per page and per numbered record. A log
 * record with a trace and an order of the back office support the claim; the others are unrelated.
 */
function verifier(user: string): unknown {
  const { text } = jsonSlot<{ text: string }>(user, 'claim');
  const records = slot(user, 'data')
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          number?: number;
          record?: { traceId?: unknown; orderId?: unknown };
        },
    )
    .flatMap(({ number, record }) =>
      number === undefined || record === undefined
        ? []
        : [
            {
              record: number,
              relation:
                typeof record.traceId === 'string' ||
                typeof record.orderId === 'string'
                  ? 'supports'
                  : 'unrelated',
            },
          ],
    );
  return {
    support: records.some((item) => item.relation === 'supports')
      ? 'yes'
      : 'insufficient',
    claimType: text === ENGINE_JOURNEY.causal ? 'causal' : 'observation',
    records,
  };
}

interface SynthesisClaimOfInput {
  claimId: string;
  text: string;
  pointer: { pageId: string; records: number[] }[] | null;
}

/**
 * The answer agent's draft. The root `synthesis` of an empty catalog (mode `model_knowledge`) is given a packet without
 * claims: it answers with one new assumption, no atoms and no pointer.
 */
function synthesis(user: string): unknown {
  const { claims } = jsonSlot<{ claims: SynthesisClaimOfInput[] }>(
    user,
    'assignment',
  );
  if (claims.length === 0) {
    return {
      outcome: 'answered',
      summaryClaimIds: [],
      claims: [
        {
          claimId: null,
          text: TWO_SOURCES_TEXTS.assumption,
          atoms: [],
          pointer: [],
        },
      ],
    };
  }
  return {
    outcome: 'answered',
    summaryClaimIds: claims.map((claim) => claim.claimId),
    claims: claims.map((claim) => ({
      claimId: claim.claimId,
      text: claim.text,
      atoms: [],
      pointer: claim.pointer ?? [],
    })),
  };
}

export interface EngineScriptedRoles {
  readonly resolveModel: ResolveModel;
  /** One token per character of the turn's input: no provider is called to count. */
  readonly tokenCounter: TokenCounter;
}

const RESEARCH_FLOW_SCRIPT: ResearchScript = {
  read: () => ({ toolName: 'search_logs', args: SUBQUESTION_SLICE }),
  claimTexts: () => [ENGINE_JOURNEY.observation, ENGINE_JOURNEY.causal],
  assess: verifier,
  draft: synthesis,
  workerAsksOutsideTool: () => false,
};

const PAGE_SIZE = 10;
const WINDOW_MS = 10 * 60_000;

/** The slices of the two-source journeys: ten minutes from the scenario's change, in the logs and in the back office. */
function twoSourcesGathers(changeAt: string): {
  readonly logs: WorkerGather;
  readonly orders: (pageSize: number) => WorkerGather;
} {
  const window = {
    from: changeAt,
    to: new Date(Date.parse(changeAt) + WINDOW_MS).toISOString(),
  };
  return {
    logs: {
      sourceId: FIXTURE_SOURCE_ID,
      toolName: 'search_logs',
      args: { ...window, pageSize: PAGE_SIZE },
    },
    orders: (pageSize) => ({
      sourceId: BACKOFFICE_SOURCE_ID,
      toolName: 'search_orders',
      args: { ...window, pageSize },
    }),
  };
}

/**
 * The worker's gathers of a two-source journey. S2 asks `backoffice` three times with different page sizes (the first
 * before the restart, gets a page; the second is denied by the narrower table; the third is refused from the recorded
 * denial), then `fixture`.
 */
function journeyGathers(
  journey: Exclude<EngineJourneyName, 'provider-adapter'>,
  changeAt: string,
): readonly WorkerGather[] {
  const { logs, orders } = twoSourcesGathers(changeAt);
  return journey === 'two-sources'
    ? [logs, orders(PAGE_SIZE)]
    : [orders(PAGE_SIZE), orders(PAGE_SIZE - 1), orders(PAGE_SIZE - 2), logs];
}

function scriptOf(journey: EngineJourneyName): ResearchScript {
  if (journey === 'provider-adapter') return RESEARCH_FLOW_SCRIPT;
  const gathers = journeyGathers(journey, twoSourcesFacts().changeAt);
  return {
    read: () => {
      throw new Error(`engineScriptedRoles: ${journey} reads by its gathers`);
    },
    gathers: () => gathers,
    claimTexts: () => [TWO_SOURCES_TEXTS.observation],
    assess: verifier,
    draft: synthesis,
    workerAsksOutsideTool: () => false,
  };
}

/** Whether the turn waits for the process to stop it: the worker of `revocation-hold` once it has its first page. */
const holdsTurn = (journey: EngineJourneyName, view: AgentCallView): boolean =>
  journey === 'revocation-hold' &&
  view.agent === 'worker' &&
  view.resultsOf('gather').length >= 1;

/** A turn that never answers: it rejects when the call is aborted (the runtime's shutdown returns the task to the queue). */
function heldTurn(signal: AbortSignal | undefined): Promise<GenerateResult> {
  return new Promise((_, reject) => {
    const stopped = (): void =>
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error('engineScriptedRoles: the held turn was aborted'),
      );
    if (signal?.aborted === true) stopped();
    signal?.addEventListener('abort', stopped, { once: true });
  });
}

/**
 * `config`: the configuration the child loads; its agents are recognised by their prompts. `journey`: what the agents
 * play ({@link EngineJourneyName}).
 */
export function createEngineScriptedRoles(
  config: unknown,
  journey: EngineJourneyName = 'provider-adapter',
): EngineScriptedRoles {
  const agentOf: AgentRecognizer = recognizeAgents(agentPromptsOf(config));
  const script = scriptOf(journey);
  const answer = (options: GenerateOptions): Promise<GenerateResult> => {
    const agent = agentOf(textOfRole(options, 'system'));
    if (agent === null) {
      throw new Error(
        'engineScriptedRoles: a call of no agent of the configuration',
      );
    }
    const view = agentCallView(options, agent);
    if (holdsTurn(journey, view)) return heldTurn(options.abortSignal);
    return Promise.resolve(
      toolCallsAnswer(researchAgentTurn(view, script), USAGE),
    );
  };
  const models = new Map<string, RoleModel>();
  return {
    resolveModel: (modelId) => {
      let model = models.get(modelId);
      if (model === undefined) {
        model = new MockLanguageModelV4({
          provider: 'engine-scripted',
          modelId,
          // A loud failure of the script rejects the call, as a provider error would.
          doGenerate: answer,
        });
        models.set(modelId, model);
      }
      return model;
    },
    tokenCounter: {
      countTurnInputTokens: (request) =>
        Promise.resolve({
          outcome: 'counted',
          inputTokens: agentTurnCharacters(request),
        }),
    },
  };
}
