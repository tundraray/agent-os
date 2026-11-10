import { isDeepStrictEqual } from 'node:util';
import {
  deepResearchProcessV3,
  type ResolveModel,
  type RoleModel,
  type TokenCounter,
} from '@agent-os/engine';
import {
  buildCalibrationPairs,
  buildJudgeChecks,
  type CalibrationPair,
  type JudgeCheck,
  loadScenarioSet,
  scenarioKey,
  type ScenarioKey,
} from '@agent-os/mcp-fixture';
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
 * The model boundary of the self-check integration file (design-self-check.md, Test Strategy), and the only boundary
 * besides the program clock that is doubled: one `MockLanguageModelV4` per model id behind `resolveModel`, answering
 *
 * - the six definitions of v3 with the agent program of `researchFlowAgents.ts`, driven by the key of the scenario the
 *   program is assembling — the script reads the key's evidence trace (or records before the change), states the key's
 *   phrases and places them in the sections the test asked for, so the right and the wrong answer are known; an agent
 *   turn has no output schema, and the agent is found by the prompt its system block starts with;
 * - the judge with the form filled from the same key, or with the expected form of a judge check of the set;
 * - under `calibrate`, the verifier with the key of each calibration pair of the set ({@link SelfCheckModels.calibrating}).
 *
 * Every call is recorded, so "every model call went through `resolveModel`" is read from {@link SelfCheckModels.calls}.
 *
 * The double reads its packets by their structure only: the tagged slots of the verifier's and the answer agent's
 * packets with their JSON, the judge output schema's properties, and the judge input JSON. Where it tells statements
 * apart it compares a claim text with the exact phrase this double wrote from the key — it recognises its own script, it
 * does not interpret text. Built on `ai/test` here because `packages/engine/test/support/scriptedModel.ts` is another
 * package's test file (plan rule 11).
 */

/** The judge is told by its output schema; every other call is an agent turn. */
export type SelfCheckModelRole = 'judge';

type GenerateOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

/** A property of each judge form's output schema. */
const JUDGE_MARKERS: readonly string[] = ['causeChange', 'answersQuestion'];

/** One call the double received. */
export interface SelfCheckModelCall {
  readonly role: SelfCheckModelRole | 'agent' | 'unknown';
  /** The definition of an agent turn; null for a judge call. */
  readonly agent: string | null;
  readonly modelId: string;
  /** The scenario the program was assembling when the call came (`<set>/<scenario>`), or null before any. */
  readonly scenario: string | null;
  /** The `system` text: the agent's instructions or the judge instructions. */
  readonly system: string;
  /** The user text of the packet. */
  readonly user: string;
  /** What the double answered; `undefined` when it threw. */
  output?: unknown;
}

/** A statement of the key the scripted answer can make. */
export type KeyStatement = 'change' | 'link' | 'distractor';

/** Where the answer places a statement: `established` claims are sent to verification, `assumed` ones are not. */
export type StatementSection = 'established' | 'assumed';

/** What the scripted agents do in the runs of one scenario. */
export interface ScenarioBehaviour {
  /**
   * The records the investigation reads and its claims cite: `key_trace` — the first trace of the key's evidence
   * (`get_trace`), `before_change` — records of the quarter hour before the change, which hold no trace of the key's
   * evidence (`search_logs`).
   */
  readonly reads: 'key_trace' | 'before_change';
  /** The key's statements the answer makes, in this order, each in its section; none — an honest refusal. */
  readonly statements: readonly {
    readonly statement: KeyStatement;
    readonly section: StatementSection;
  }[];
  /** The worker asks a tool outside its definition before it finishes (`tool_not_in_definition`). */
  readonly workerAsksOutsideTool?: boolean;
  /**
   * The first draft adds this statement as a new claim, so the root's close is refused `needs_verification` once, the
   * claim is checked and a new draft closes.
   */
  readonly draftAdds?: KeyStatement;
}

/**
 * The default of a scenario (UC-11, UC-10's honest half): with a cause, the change established on the key's trace and
 * the link assumed; without one, nothing stated.
 */
function defaultBehaviour(key: ScenarioKey): ScenarioBehaviour {
  if (key.kind === 'no_cause')
    return { reads: 'before_change', statements: [] };
  return {
    reads: 'key_trace',
    statements: [
      { statement: 'change', section: 'established' },
      { statement: 'link', section: 'assumed' },
    ],
  };
}

export interface SelfCheckModels {
  readonly resolveModel: ResolveModel;
  /** One token per character of what a turn sends. */
  readonly tokenCounter: TokenCounter;
  /** Every call in arrival order; a test may empty it. */
  readonly calls: SelfCheckModelCall[];
  callsOf(role: SelfCheckModelRole): SelfCheckModelCall[];
  /** The turns of one definition, in arrival order. */
  callsOfAgent(agent: string): SelfCheckModelCall[];
  /** Tells the double the definitions of this configuration; the shipped v3 is known from the start. */
  recognizeConfig(config: unknown): void;
  /** Loads the set's scenarios with their keys and judge checks; a scenario the program assembles must be loaded. */
  useSet(setName: string): void;
  /** The key of a loaded scenario, by `<set>/<scenario>`. */
  keyOf(scenario: string): ScenarioKey;
  /** The judge checks of a loaded set, in the order `buildJudgeChecks` builds them. */
  judgeChecksOf(setName: string): readonly JudgeCheck[];
  /** What the scripted agents do in the runs of `scenario` (`<set>/<scenario>`); the default otherwise. */
  behave(scenario: string, behaviour: ScenarioBehaviour): void;
  /** The judge fills a wrong (but well-formed) form for these judge checks, by `checkId` (INT-3 R3). */
  judgeWrongOn(...checkIds: string[]): void;
  /**
   * The verifier answers a check holding a record of these scenarios' `injectionTraceIds` with `support: no`, and the
   * same check without such a record as usual (`<set>/<scenario>`, INT-3 R4, UC-11).
   */
  injectionSways(...scenarios: string[]): void;
  /** Called by the app when the program assembles a scenario: the turns that follow answer from its key. */
  assembling(scenario: string): void;
  /**
   * The verifier judges the calibration pairs of the set (`calibrate`): it answers each pair with the key's support and
   * type, and with the opposite support on pairs of the kinds in `errsOn` (`yes` for an expected `no` or
   * `insufficient`, `no` for an expected `yes`). Every given record gets the relation of the answer.
   */
  calibrating(setName: string, errsOn: readonly string[]): void;
  /** Empties the calls, the behaviours and the wrong checks; loaded sets stay. */
  reset(): void;
}

const USAGE: GenerateResult['usage'] = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

/** The window before the change the `before_change` read covers. */
const BEFORE_CHANGE_WINDOW_MS = 15 * 60 * 1000;
const BEFORE_CHANGE_PAGE_SIZE = 5;

function isJudgeCall(options: GenerateOptions): boolean {
  const format = options.responseFormat;
  const schema = format?.type === 'json' ? format.schema : undefined;
  const properties =
    (schema as { properties?: Record<string, unknown> } | undefined)
      ?.properties ?? {};
  return JUDGE_MARKERS.some((marker) => marker in properties);
}

function textOf(options: GenerateOptions, role: 'system' | 'user'): string {
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

/** The content of the `<tag>` slot of a packet, or undefined when the packet has none. */
function slot(user: string, tag: string): string | undefined {
  const open = `<${tag}>\n`;
  const start = user.indexOf(open);
  if (start < 0) return undefined;
  const end = user.indexOf(`\n</${tag}>`, start + open.length);
  return end < 0 ? undefined : user.slice(start + open.length, end);
}

function jsonSlot<T>(user: string, tag: string): T {
  const content = slot(user, tag);
  if (content === undefined) {
    throw new Error(`selfCheckModels: the packet has no <${tag}> slot`);
  }
  return JSON.parse(content) as T;
}

/** The phrase this double writes for a statement of the key; undefined when the key has none. */
function phraseOf(
  key: ScenarioKey,
  statement: KeyStatement,
): string | undefined {
  switch (statement) {
    case 'change':
      return key.cause?.changePhrase;
    case 'link':
      return key.cause?.linkPhrase;
    case 'distractor':
      return key.distractors[0]?.phrase;
  }
}

/**
 * The verifier's packet as `buildClaimCheck` lays it out: the claim JSON in `<claim>`, then in `<data>` one JSON
 * line per page and one per record, each record with its number.
 */
function claimCheckOf(user: string): {
  text: string;
  records: { number: number; record: { traceId?: unknown } }[];
} {
  const data = slot(user, 'data');
  if (data === undefined) {
    throw new Error('selfCheckModels: the verifier packet has no <data> slot');
  }
  const records = data
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as { number?: number; record?: { traceId?: unknown } },
    )
    .flatMap((line) =>
      line.number === undefined || line.record === undefined
        ? []
        : [{ number: line.number, record: line.record }],
    );
  return { text: jsonSlot<{ text: string }>(user, 'claim').text, records };
}

interface ClaimOfInput {
  claimId: string;
  text: string;
  evidenceIds: string[];
}

/** A claim of the answer agent's packet: its pointer instead of the pages (C3). */
interface SynthesisClaimOfInput {
  claimId: string;
  text: string;
  pointer: { pageId: string; records: number[] }[] | null;
}

interface JudgeInputJson {
  answer?: Partial<
    Record<'established' | 'assumed' | 'unknown', ClaimOfInput[]>
  >;
  key?: unknown;
}

export function createSelfCheckModels(): SelfCheckModels {
  const calls: SelfCheckModelCall[] = [];
  const keys = new Map<string, ScenarioKey>();
  const checks = new Map<string, readonly JudgeCheck[]>();
  const behaviours = new Map<string, ScenarioBehaviour>();
  const wrongChecks = new Set<string>();
  /** The injection traces of the scenarios whose text addressed to the model sways the verifier. */
  const swayingTraceIds = new Set<string>();
  /** The calibration pairs by their claim text, once `calibrating` was called; their verifier answers by the key. */
  const calibrationPairs = new Map<string, CalibrationPair>();
  const calibrationErrs = new Set<string>();
  let current: string | null = null;
  let agentOf: AgentRecognizer = recognizeAgents(
    agentPromptsOf(deepResearchProcessV3),
  );

  const keyOf = (scenario: string): ScenarioKey => {
    const key = keys.get(scenario);
    if (key === undefined) {
      throw new Error(
        `selfCheckModels: scenario ${scenario} is not loaded (useSet first)`,
      );
    }
    return key;
  };

  /** The scenario of a turn: the one the program is assembling. */
  const currentScenario = (): {
    key: ScenarioKey;
    behaviour: ScenarioBehaviour;
  } => {
    if (current === null) {
      throw new Error('selfCheckModels: a turn before any scenario');
    }
    const key = keyOf(current);
    return { key, behaviour: behaviours.get(current) ?? defaultBehaviour(key) };
  };

  /** The text of each stated statement in this scenario, with its section. */
  const scriptedClaims = (): {
    text: string;
    section: StatementSection;
  }[] => {
    const { key, behaviour } = currentScenario();
    return behaviour.statements.map(({ statement, section }) => {
      const text = phraseOf(key, statement);
      if (text === undefined) {
        throw new Error(
          `selfCheckModels: the key of ${current} has no ${statement} statement`,
        );
      }
      return { text, section };
    });
  };

  function readOf(
    key: ScenarioKey,
    behaviour: ScenarioBehaviour,
  ): { toolName: string; args: Record<string, unknown> } {
    if (behaviour.reads === 'key_trace') {
      const traceId = key.causeTraceIds[0];
      if (traceId === undefined) {
        throw new Error(
          `selfCheckModels: ${current} has no evidence trace to read`,
        );
      }
      return { toolName: 'get_trace', args: { traceId } };
    }
    const changeMs = Date.parse(key.facts.changeAt);
    return {
      toolName: 'search_logs',
      args: {
        from: new Date(changeMs - BEFORE_CHANGE_WINDOW_MS).toISOString(),
        to: new Date(changeMs).toISOString(),
        pageSize: BEFORE_CHANGE_PAGE_SIZE,
      },
    };
  }

  /**
   * The closed assessment of one claim: a given record that carries a trace supports it — the record the worker of this
   * script pointed at, whose trace is its atom; under `key_trace` that is a trace of the key's cause, under
   * `before_change` a trace outside the key, so an ungrounded change is still established (INT-3 R2) — any other record
   * is unrelated. The claim is `causal` when it is the key's link or a statement placed in `assumed` (every claim is
   * checked), `observation` otherwise, told apart by exact equality with the phrase this double wrote from the key. A check holding a record of a swaying injection trace (by its
   * `traceId`) answers `support: no` (`injectionSways`).
   */
  function verifier(user: string): unknown {
    if (calibrationPairs.size > 0) return calibrationVerifier(user);
    const { key } = currentScenario();
    const claim = claimCheckOf(user);
    const assumed = scriptedClaims().some(
      ({ text, section }) => section === 'assumed' && text === claim.text,
    );
    const records = claim.records.map(({ number, record }) => ({
      record: number,
      relation: typeof record.traceId === 'string' ? 'supports' : 'unrelated',
    }));
    const swayed = claim.records.some(
      ({ record }) =>
        typeof record.traceId === 'string' &&
        swayingTraceIds.has(record.traceId),
    );
    return {
      support: swayed
        ? 'no'
        : records.some((item) => item.relation === 'supports')
          ? 'yes'
          : 'insufficient',
      claimType:
        assumed || claim.text === phraseOf(key, 'link')
          ? 'causal'
          : 'observation',
      records,
    };
  }

  /**
   * The closed assessment of a calibration pair, found by exact equality of the claim text with a pair's text — the
   * double recognises the pairs `buildCalibrationPairs` wrote, it does not interpret text. The answer is the pair's key
   * (or its opposite support on an erring kind), and every given record carries the answer's relation.
   */
  function calibrationVerifier(user: string): unknown {
    const claim = claimCheckOf(user);
    const pair = calibrationPairs.get(claim.text);
    if (pair === undefined) {
      throw new Error(
        'selfCheckModels: a verifier call for no calibration pair',
      );
    }
    const support = !calibrationErrs.has(pair.pairKind)
      ? pair.expectedSupport
      : pair.expectedSupport === 'yes'
        ? 'no'
        : 'yes';
    const relation =
      support === 'yes'
        ? 'supports'
        : support === 'no'
          ? 'contradicts'
          : 'unrelated';
    return {
      support,
      claimType: pair.expectedType,
      records: claim.records.map(({ number }) => ({
        record: number,
        relation,
      })),
    };
  }

  /**
   * Every input claim by its id with its stored pointer; `answered` when a statement is to be established. For the
   * summary it chooses the claim of the key's change, told apart by exact equality with the phrase this double wrote.
   * With `draftAdds`, the statement not yet among the input claims is added as a new claim on the first claim's pointer.
   */
  function synthesis(user: string): unknown {
    const { key, behaviour } = currentScenario();
    const assignment = jsonSlot<{ claims: SynthesisClaimOfInput[] }>(
      user,
      'assignment',
    );
    const establishes = scriptedClaims().some(
      (claim) => claim.section === 'established',
    );
    return {
      outcome: establishes ? 'answered' : 'inconclusive',
      summaryClaimIds: assignment.claims
        .filter((claim) => claim.text === phraseOf(key, 'change'))
        .map((claim) => claim.claimId),
      claims: [
        ...assignment.claims.map((claim) => ({
          claimId: claim.claimId,
          text: claim.text,
          atoms: [],
          pointer: claim.pointer ?? [],
        })),
        ...freshClaims(key, behaviour, assignment.claims),
      ],
    };
  }

  /** The new claim of a draft under `draftAdds`, once: a claim with its text is an input claim on the next draft. */
  function freshClaims(
    key: ScenarioKey,
    { draftAdds }: ScenarioBehaviour,
    claims: readonly SynthesisClaimOfInput[],
  ): unknown[] {
    const text = draftAdds === undefined ? undefined : phraseOf(key, draftAdds);
    if (text === undefined || claims.some((claim) => claim.text === text)) {
      return [];
    }
    return [
      { claimId: null, text, atoms: [], pointer: claims[0]?.pointer ?? [] },
    ];
  }

  /** The judge check whose answer this input holds, by the claim identifiers of its sections. */
  function checkOf(input: JudgeInputJson): JudgeCheck | undefined {
    const ids = (answer: JudgeInputJson['answer']) =>
      new Set(
        (['established', 'assumed', 'unknown'] as const).flatMap((section) =>
          (answer?.[section] ?? []).map((claim) => claim.claimId),
        ),
      );
    const asked = ids(input.answer);
    return [...checks.values()]
      .flat()
      .find((check) => isDeepStrictEqual(ids(check.answer), asked));
  }

  /** A well-formed form that differs from the expected one: `otherCauseEstablished` flipped. */
  function wrongForm(check: JudgeCheck): unknown {
    const { form } = check;
    if (form.otherCauseEstablished === 'yes') {
      return { ...form, otherCauseEstablished: 'no', otherCauseClaimIds: [] };
    }
    const firstEstablished = check.answer.established[0];
    if (firstEstablished === undefined) {
      throw new Error(
        `selfCheckModels: check ${check.checkId} has no established claim`,
      );
    }
    return {
      ...form,
      otherCauseEstablished: 'yes',
      otherCauseClaimIds: [firstEstablished.claimId],
    };
  }

  /** The key whose judge input (`keyedJudgeInput`) this is: kind, both phrases and facts are equal. */
  function keyOfJudgeInput(inputKey: unknown): ScenarioKey {
    const key = [...keys.values()].find((candidate) =>
      isDeepStrictEqual(inputKey, {
        kind: candidate.kind,
        changePhrase: candidate.cause?.changePhrase ?? null,
        linkPhrase: candidate.cause?.linkPhrase ?? null,
        facts: candidate.facts,
      }),
    );
    if (key === undefined) {
      throw new Error('selfCheckModels: the judge input names no loaded key');
    }
    return key;
  }

  /** The keyed form of a run's answer, from where the answer holds the phrases this double wrote from the key. */
  function formByKey(key: ScenarioKey, input: JudgeInputJson): unknown {
    const inSection = (section: 'established' | 'assumed', text?: string) =>
      (input.answer?.[section] ?? [])
        .filter((claim) => text !== undefined && claim.text === text)
        .map((claim) => claim.claimId);
    const placementOf = (statement: KeyStatement) => {
      if (key.kind === 'no_cause') {
        return { placement: 'not_applicable', claimIds: [] };
      }
      const text = phraseOf(key, statement);
      const established = inSection('established', text);
      if (established.length > 0) {
        return { placement: 'established', claimIds: established };
      }
      const assumed = inSection('assumed', text);
      if (assumed.length > 0)
        return { placement: 'assumed', claimIds: assumed };
      return { placement: 'absent', claimIds: [] };
    };
    const change = placementOf('change');
    const link = placementOf('link');
    const distractors = new Set(key.distractors.map((item) => item.phrase));
    const other = (input.answer?.established ?? [])
      .filter((claim) => distractors.has(claim.text))
      .map((claim) => claim.claimId);
    return {
      causeChange: change.placement,
      causeChangeClaimIds: change.claimIds,
      causeLink: link.placement,
      causeLinkClaimIds: link.claimIds,
      otherCauseEstablished: other.length > 0 ? 'yes' : 'no',
      otherCauseClaimIds: other,
      contradictingClaimIds: [],
    };
  }

  /**
   * The judge: the input is the JSON of `keyedJudgeInput` / `unkeyedJudgeInput` as the user message. A judge check's
   * answer gets its expected form (or the wrong one); a run's answer gets the form filled from its key. Without a key
   * the answer answers the question.
   */
  function judge(user: string): unknown {
    const input = JSON.parse(user) as JudgeInputJson;
    if (input.key === undefined) return { answersQuestion: 'yes' };
    const check = checkOf(input);
    if (check !== undefined) {
      return wrongChecks.has(check.checkId) ? wrongForm(check) : check.form;
    }
    return formByKey(keyOfJudgeInput(input.key), input);
  }

  /** The agent program (`researchFlowAgents.ts`) follows the key and behaviour of the scenario. */
  const researchScript: ResearchScript = {
    read: () => {
      const { key, behaviour } = currentScenario();
      return readOf(key, behaviour);
    },
    claimTexts: () => scriptedClaims().map((claim) => claim.text),
    assess: verifier,
    draft: synthesis,
    workerAsksOutsideTool: () =>
      currentScenario().behaviour.workerAsksOutsideTool === true,
  };

  function answer(modelId: string, options: GenerateOptions): GenerateResult {
    const system = textOf(options, 'system');
    const judgeCall = isJudgeCall(options);
    const agent = judgeCall ? null : agentOf(system);
    const role = judgeCall ? 'judge' : agent === null ? 'unknown' : 'agent';
    const call: SelfCheckModelCall = {
      role,
      agent,
      modelId,
      scenario: current,
      system,
      user: textOf(options, 'user'),
    };
    calls.push(call);
    if (agent !== null) {
      const toolCalls = researchAgentTurn(
        agentCallView(options, agent),
        researchScript,
      );
      call.output = toolCalls;
      return toolCallsAnswer(toolCalls, USAGE);
    }
    if (role !== 'judge') {
      throw new Error(`selfCheckModels ${modelId}: a call of an unknown agent`);
    }
    const output = judge(call.user);
    call.output = output;
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage: USAGE,
      warnings: [],
    };
  }

  const models = new Map<string, RoleModel>();
  return {
    calls,
    resolveModel: (modelId) => {
      const existing = models.get(modelId);
      if (existing !== undefined) return existing;
      const model = new MockLanguageModelV4({
        provider: 'self-check-scripted',
        modelId,
        // A loud failure of the script rejects the call, as a provider error would.
        doGenerate: async (options) => answer(modelId, options),
      });
      models.set(modelId, model);
      return model;
    },
    tokenCounter: {
      countTurnInputTokens: (request) =>
        Promise.resolve({
          outcome: 'counted',
          inputTokens: agentTurnCharacters(request),
        }),
    },
    callsOf: (role) => calls.filter((call) => call.role === role),
    callsOfAgent: (agent) => calls.filter((call) => call.agent === agent),
    recognizeConfig: (config) => {
      agentOf = recognizeAgents(agentPromptsOf(config));
    },
    useSet: (setName) => {
      const loaded = loadScenarioSet(setName);
      if (!loaded.ok) {
        throw new Error(
          `selfCheckModels: set ${setName}: ${loaded.reason} ${loaded.detail}`,
        );
      }
      for (const scenario of loaded.set.scenarios) {
        keys.set(
          `${scenario.setName}/${scenario.scenarioId}`,
          scenarioKey(scenario),
        );
      }
      checks.set(setName, buildJudgeChecks(loaded.set));
    },
    keyOf,
    judgeChecksOf: (setName) => {
      const loaded = checks.get(setName);
      if (loaded === undefined) {
        throw new Error(`selfCheckModels: set ${setName} is not loaded`);
      }
      return loaded;
    },
    behave: (scenario, behaviour) => {
      behaviours.set(scenario, behaviour);
    },
    judgeWrongOn: (...checkIds) => {
      for (const checkId of checkIds) wrongChecks.add(checkId);
    },
    injectionSways: (...scenarios) => {
      for (const scenario of scenarios) {
        for (const traceId of keyOf(scenario).injectionTraceIds) {
          swayingTraceIds.add(traceId);
        }
      }
    },
    assembling: (scenario) => {
      current = scenario;
    },
    calibrating: (setName, errsOn) => {
      const loaded = loadScenarioSet(setName);
      if (!loaded.ok) {
        throw new Error(
          `selfCheckModels: set ${setName}: ${loaded.reason} ${loaded.detail}`,
        );
      }
      for (const pair of buildCalibrationPairs(loaded.set).pairs) {
        const known = calibrationPairs.get(pair.claimText);
        if (
          known !== undefined &&
          (known.pairKind !== pair.pairKind ||
            known.expectedSupport !== pair.expectedSupport ||
            known.expectedType !== pair.expectedType)
        ) {
          throw new Error(
            `selfCheckModels: pairs ${known.pairId} and ${pair.pairId} share a claim text with different keys`,
          );
        }
        calibrationPairs.set(pair.claimText, pair);
      }
      for (const kind of errsOn) calibrationErrs.add(kind);
    },
    reset: () => {
      calls.length = 0;
      behaviours.clear();
      wrongChecks.clear();
      swayingTraceIds.clear();
      current = null;
    },
  };
}
