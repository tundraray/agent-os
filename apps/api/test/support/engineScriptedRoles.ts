import type { ResolveModel, RoleModel, TokenCounter } from '@agent-os/engine';
import { FIXTURE_SOURCE_ID } from '@agent-os/sources';
import { MockLanguageModelV4 } from 'ai/test';

/**
 * The role models of the real engine in the chat-entry child's mode `E2E_ENGINE_SCRIPTED_ROLES=1` (E2E-1 of
 * agent-quality / engine), modelled on `selfCheckModels.ts`: one `MockLanguageModelV4` per model id behind
 * `resolveModel`, answering the five roles of `deep-research` v2 with one fixed journey —
 *
 * - the controller reads one slice of the fixture logs (`search_logs`), then asks to verify both claims of the worker,
 *   then proposes the answer;
 * - the worker writes {@link ENGINE_JOURNEY}`.observation` and, separately, `.causal`, each pointing at the first
 *   record of the page that carries a trace, with that trace as its atom;
 * - the verifier assesses the claim against the numbered records: a record with a trace supports it; the type is
 *   `causal` for the causal claim and `observation` otherwise;
 * - synthesis answers with every input claim and chooses all of them for the summary, so the engine's rule that keeps
 *   a causal claim out of the summary is what removes it.
 *
 * The double reads its packets by their structure only (the tagged slots of `role-packets.ts`, the output schema's
 * properties). It tells the two claims apart by exact equality of a claim text with a text this double wrote — it
 * recognises its own script, it does not interpret text. Synthesis is held until {@link EngineScriptedRoles.release},
 * so the test decides when the investigation may finish.
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
 * Files the child in this mode loads instead of the defaults (E2E-2): `processFile` — the JSON of the only process
 * configuration (`ENGINE_PROCESSES`); `groupTablesDir` — a directory whose `*.json` files, in name order, are the group
 * tables as `calibrate` wrote them (`ENGINE_GROUP_TABLES`). Without them the child loads the shipped configuration and
 * the test table.
 */
export interface EngineFiles {
  readonly processFile: string;
  readonly groupTablesDir: string;
}

/** The variables that carry {@link EngineFiles} to the child; only the child reads them. */
export const ENGINE_FILES_VARIABLES = {
  processFile: 'E2E_ENGINE_PROCESS_FILE',
  groupTablesDir: 'E2E_ENGINE_GROUP_TABLES_DIR',
} as const satisfies Record<keyof EngineFiles, string>;

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

type RoleName = 'plan' | 'controller' | 'worker' | 'verifier' | 'synthesis';

type GenerateOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

/** A property only the output schema of that role has; synthesis also has `claims`, so it is checked before the worker. */
const ROLE_MARKERS: readonly (readonly [RoleName, string])[] = [
  ['synthesis', 'summaryClaimIds'],
  ['plan', 'readinessCriteria'],
  ['controller', 'kind'],
  ['worker', 'claims'],
  ['verifier', 'records'],
];

const USAGE: GenerateResult['usage'] = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

const ANALYZE_WORKFLOW = 'research.analyze';
const VERIFY_WORKFLOW = 'research.verify';

/** The slice the sub-question reads: one page of fixture records, as the engine's own E2E reads it. */
const SUBQUESTION_SLICE = {
  from: '2026-09-15T00:00:00.000Z',
  to: '2026-09-15T00:10:00.000Z',
  service: 'provider-adapter',
  pageSize: 20,
};

const WORKER_TEXTS = new Set<string>([
  ENGINE_JOURNEY.observation,
  ENGINE_JOURNEY.causal,
]);

function roleOf(options: GenerateOptions): RoleName {
  const format = options.responseFormat;
  const schema = format?.type === 'json' ? format.schema : undefined;
  const properties =
    (schema as { properties?: Record<string, unknown> } | undefined)
      ?.properties ?? {};
  const found = ROLE_MARKERS.find(([, marker]) => marker in properties);
  if (found === undefined) {
    throw new Error('engineScriptedRoles: a call of an unknown role');
  }
  return found[0];
}

function userText(options: GenerateOptions): string {
  return options.prompt
    .flatMap((message) => {
      if (message.role !== 'user') return [];
      if (typeof message.content === 'string') return [message.content];
      return message.content.flatMap((part) =>
        part.type === 'text' ? [part.text] : [],
      );
    })
    .join('\n');
}

/** The content of the `<tag>` slot of a role packet (`role-packets.ts`). */
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

/** The first record of the worker packet's pages that carries a trace: its page id, number and trace. */
function tracedRecordOf(user: string): {
  evidenceId: string;
  number: number;
  traceId: string;
} {
  const page = /<evidence id="([^"]+)">\n([\s\S]*?)\n<\/evidence>/g;
  const record = /<record number="(\d+)">(.*)<\/record>/g;
  for (const [, evidenceId, records] of user.matchAll(page)) {
    for (const [, number, json] of records!.matchAll(record)) {
      const { traceId } = JSON.parse(json!) as { traceId?: unknown };
      if (typeof traceId === 'string') {
        return { evidenceId: evidenceId!, number: Number(number), traceId };
      }
    }
  }
  throw new Error(
    'engineScriptedRoles: the worker read no record with a trace',
  );
}

interface ControllerInput {
  observations?: {
    tasks?: { type?: string }[];
    claims?: { claimId: string; text: string }[];
  };
}

function controller(user: string): unknown {
  const input = jsonSlot<ControllerInput>(user, 'decision_input');
  const counts = jsonSlot<{ type: string }[]>(user, 'task_counts');
  const types = new Set([
    ...(input.observations?.tasks ?? []).map((task) => task.type),
    ...counts.map((count) => count.type),
  ]);
  if (!types.has(ANALYZE_WORKFLOW)) {
    return {
      kind: 'requestAnalysis',
      rationale: 'read the provider-adapter records',
      subquestions: [
        {
          text: 'Какие ошибки записал provider-adapter?',
          sourceId: FIXTURE_SOURCE_ID,
          toolName: 'search_logs',
          args: JSON.stringify(SUBQUESTION_SLICE),
          completeness: 'sample',
        },
      ],
    };
  }
  const toVerify = (input.observations?.claims ?? [])
    .filter((claim) => WORKER_TEXTS.has(claim.text))
    .map((claim) => claim.claimId);
  if (!types.has(VERIFY_WORKFLOW) && toVerify.length > 0) {
    return {
      kind: 'requestVerification',
      rationale: 'check both claims against the records',
      claimIds: toVerify,
    };
  }
  return { kind: 'proposeAnswer', rationale: 'the claims are checked' };
}

function worker(user: string): unknown {
  const { evidenceId, number, traceId } = tracedRecordOf(user);
  return {
    claims: [ENGINE_JOURNEY.observation, ENGINE_JOURNEY.causal].map((text) => ({
      text,
      atoms: [{ kind: 'text', value: traceId }],
      pointer: [{ pageId: evidenceId, records: [number] }],
    })),
  };
}

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

const PROGRAMS: Record<RoleName, (user: string) => unknown> = {
  plan: () => ({
    readinessCriteria: ['the errors of provider-adapter are found'],
    branches: [],
  }),
  controller,
  worker,
  verifier,
  synthesis,
};

export interface EngineScriptedRoles {
  readonly resolveModel: ResolveModel;
  /** One token per character of the instructions and the messages: no provider is called to count. */
  readonly tokenCounter: TokenCounter;
  /** Lets the held synthesis call answer. */
  release(): void;
}

export function createEngineScriptedRoles(): EngineScriptedRoles {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = async (options: GenerateOptions): Promise<GenerateResult> => {
    const role = roleOf(options);
    if (role === 'synthesis') await released;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(PROGRAMS[role](userText(options))),
        },
      ],
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage: USAGE,
      warnings: [],
    };
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
      countInputTokens: (request) =>
        Promise.resolve({
          outcome: 'counted',
          inputTokens:
            request.system.length +
            request.messages.reduce(
              (sum, message) => sum + message.content.length,
              0,
            ),
        }),
      countTurnInputTokens: () =>
        Promise.reject(new Error('v2 runs no agent turn')),
    },
    release: () => release(),
  };
}
