import type { ResolveModel, RoleModel, TokenCounter } from '@agent-os/engine';
import { MockLanguageModelV4 } from 'ai/test';
import {
  agentCallView,
  type AgentRecognizer,
  agentTurnCharacters,
  recognizeAgents,
  researchAgentTurn,
  type ResearchScript,
  toolCallsAnswer,
} from './researchFlowAgents.js';
import { agentPromptsOf } from './researchFlowConfig.js';

/**
 * The agent models of the real engine in the chat-entry child's path `research-flow` (agent-runtime / research-flow
 * E2E-2), modelled on `selfCheckModels.ts`: one `MockLanguageModelV4` per model id behind `resolveModel`, playing one
 * fixed journey with the agents of the loaded configuration. `researchFlowAgents.ts` calls the planner and one worker,
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

/** The closed assessment: `<claim>` holds the claim JSON, `<data>` one JSON line per page and per numbered record. */
function verifier(user: string): unknown {
  const { text } = jsonSlot<{ text: string }>(user, 'claim');
  const records = slot(user, 'data')
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as { number?: number; record?: { traceId?: unknown } },
    )
    .flatMap(({ number, record }) =>
      number === undefined || record === undefined
        ? []
        : [
            {
              record: number,
              relation:
                typeof record.traceId === 'string' ? 'supports' : 'unrelated',
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

function synthesis(user: string): unknown {
  const { claims } = jsonSlot<{ claims: SynthesisClaimOfInput[] }>(
    user,
    'assignment',
  );
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

/** `config`: the configuration the child loads; its agents are recognised by their prompts. */
export function createEngineScriptedRoles(
  config: unknown,
): EngineScriptedRoles {
  const agentOf: AgentRecognizer = recognizeAgents(agentPromptsOf(config));
  const answer = (options: GenerateOptions): Promise<GenerateResult> => {
    const agent = agentOf(textOfRole(options, 'system'));
    if (agent === null) {
      throw new Error(
        'engineScriptedRoles: a call of no agent of the configuration',
      );
    }
    return Promise.resolve(
      toolCallsAnswer(
        researchAgentTurn(agentCallView(options, agent), RESEARCH_FLOW_SCRIPT),
        USAGE,
      ),
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
