import type { FormDataReader, FormRunContext } from '../../agents/result-forms.js';
import { AgentProcessConfigSchema } from '../../config/agent-config.schema.js';
import { deepResearchProcessV3 } from '../../processes/shipped-processes.js';
import { RESEARCH_CLOSE_FORM as FORM } from './research-close.js';

// UC-E3, DC-9, AC-15.1, AC-15.2 (the code's side), UC-E8 (the root's side), invariants 3, 4; design-research-flow.md, «Как корень
// закрывает расследование». Defects caught: the root closes without a check; the gates go out of order; something unverified
// reaches «Установлено». The steps run over the input of `collect`, with a double of the reader and no database.

const ROOT_RUN = '11111111-1111-4111-8111-111111111111';
const DRAFT_RUN = '22222222-2222-4222-8222-222222222222';
const PAGE = '33333333-3333-4333-8333-333333333333';
const CHECKED = '44444444-4444-4444-8444-444444444444';
const OPEN = '55555555-5555-4555-8555-555555555555';
const FROM_MEMORY = '66666666-6666-4666-8666-666666666666';
/** The id gate 4 gives the first new claim of this root: sha256 of `<run>:0` in the form of a UUID. */
const NEW_CLAIM = 'cd6aaf59-c682-56ca-a49e-ba870d98b42c';
const WORKER_TASK = 'task-worker';
const PLANNER_TASK = 'task-planner';
const REFUSAL_CALL = 5;
const BEFORE_REFUSAL = 3;
const AFTER_REFUSAL = 7;

const config = AgentProcessConfigSchema.parse(deepResearchProcessV3);
const ROOT: FormRunContext = {
  investigationId: 'investigation-1',
  resourceId: 'user-1',
  runTaskId: ROOT_RUN,
  agentName: 'controller',
  definition: config.agents.controller!,
  assignment: 'why does the job fail?',
  sourceMode: 'sources',
  depth: 0,
};

const POINTER = [{ pageId: PAGE, records: [0] }];
const claimRow = (claimId: string, status: string, taskId = WORKER_TASK) => ({
  claimId,
  text: `text of ${claimId}`,
  status,
  atoms: [],
  pointer: POINTER,
  confidence: status === 'supported' ? 'high' : null,
  evidenceIds: [PAGE],
  coverage: null,
  taskId,
});
const SUPPORTED = claimRow(CHECKED, 'supported');

const verifierCall = (claimId: string, state: string, reason: string | null = null, agent = 'verifier') => ({
  run: 'task-any',
  callIndex: 1,
  toolName: 'call_agent',
  arguments: { agent, assignment: claimId },
  state,
  outcome: state === 'done' ? { outcome: 'success', result: {} } : { outcome: 'rejected', reason },
  reason,
});

const refusedFinish = (formReason: string, callIndex = REFUSAL_CALL) => ({
  run: ROOT_RUN,
  callIndex,
  toolName: 'finish',
  arguments: { answer: DRAFT_RUN },
  state: 'rejected',
  outcome: { outcome: 'rejected', reason: 'invalid_result', detail: { reason: formReason, detail: { claimIds: [NEW_CLAIM] } } },
  reason: 'invalid_result',
});

const answerRun = (result: unknown, patch: Record<string, unknown> = {}) => ({
  run: DRAFT_RUN,
  agent: 'synthesis',
  parent: ROOT_RUN,
  parentCallIndex: BEFORE_REFUSAL,
  result,
  failure: null,
  ...patch,
});

const draftClaim = (claimId: string | null, text = 'a claim') => ({ claimId, text, atoms: [], pointer: POINTER });
const draftOf = (...claims: unknown[]) => ({ outcome: 'answered', summaryClaimIds: [], claims });
const DRAFT_OF_CHECKED = draftOf(draftClaim(CHECKED));
const DRAFT_WITH_NEW = draftOf(draftClaim(CHECKED), draftClaim(null, 'a new claim'));

interface Scenario {
  readonly plan?: unknown;
  readonly claims?: readonly unknown[];
  readonly runs?: readonly unknown[];
  readonly toolCalls?: readonly unknown[];
  readonly processConfig?: unknown;
}

function readerOf({ plan = { revision: 1, plan: {} }, claims = [SUPPORTED], runs = [], toolCalls = [], processConfig = deepResearchProcessV3 }: Scenario): FormDataReader {
  const unused = () => Promise.reject(new Error('this step does not read it'));
  return {
    plan: () => Promise.resolve(plan),
    claims: () => Promise.resolve(claims),
    runs: () => Promise.resolve(runs),
    toolCalls: () => Promise.resolve(toolCalls),
    recordPages: () =>
      Promise.resolve([
        { page: PAGE, evidenceKey: 'key', provenance: { sourceId: 'fixture', toolName: 'search_logs', snapshot: 'snapshot-1' }, coverage: { truncated: false } },
      ]),
    engineRun: () => Promise.resolve({ launchKey: 'launch-1', sourceMode: 'sources', processConfig }),
    budgetExhausted: () => Promise.resolve(false),
    records: unused,
    definitionMemoryFingerprint: unused,
  };
}

async function close(result: unknown, scenario: Scenario) {
  const collected = await FORM.closure!.collect!(ROOT, readerOf(scenario));
  return FORM.closure!.evaluate({ result, prologueInput: null, collected }, {});
}

const ANSWER = { answer: DRAFT_RUN };
const INCONCLUSIVE = { inconclusive: true };
const refused = (reason: string, detail?: unknown) => (detail === undefined ? { kind: 'refuse', reason } : { kind: 'refuse', reason, detail });
const UNVERIFIED_OPEN = refused('unverified_claims', { claimIds: [OPEN] });
const UNVERIFIED_NEW = refused('unverified_claims', { claimIds: [NEW_CLAIM] });

describe('закрытие расследования формой research_close', () => {
  describe('ворота закрытия', () => {
    const newClaimStored = claimRow(NEW_CLAIM, 'unverified', ROOT_RUN);
    const newClaimChecked = claimRow(NEW_CLAIM, 'supported', ROOT_RUN);
    const newClaimCall = verifierCall(NEW_CLAIM, 'done');

    it.each<[string, unknown, Scenario, unknown]>([
      ['answer без плана', ANSWER, { plan: null }, refused('plan_missing')],
      ['inconclusive без плана', INCONCLUSIVE, { plan: null }, refused('plan_missing')],
      ['план важнее непроверенного: ворота 1 раньше ворот 2', ANSWER, { plan: null, claims: [claimRow(OPEN, 'unverified')] }, refused('plan_missing')],
      ['answer с непроверенным утверждением worker', ANSWER, { claims: [claimRow(OPEN, 'unverified')], runs: [answerRun(DRAFT_OF_CHECKED)] }, UNVERIFIED_OPEN],
      ['inconclusive с непроверенным утверждением worker', INCONCLUSIVE, { claims: [claimRow(OPEN, 'unverified')] }, UNVERIFIED_OPEN],
      ['вызов проверяющего ещё идёт', ANSWER, { claims: [claimRow(OPEN, 'unverified')], toolCalls: [verifierCall(OPEN, 'waiting')] }, UNVERIFIED_OPEN],
      ['вызов другого агента с этим номером не считается', ANSWER, { claims: [claimRow(OPEN, 'unverified')], toolCalls: [verifierCall(OPEN, 'done', null, 'worker')] }, UNVERIFIED_OPEN],
      [
        'черновик с новым утверждением',
        ANSWER,
        { runs: [answerRun(DRAFT_WITH_NEW)] },
        // DC-9: the model reads only the claim ids; the claims `write` puts down travel beside the detail.
        { ...refused('needs_verification', { claimIds: [NEW_CLAIM] }), newClaims: [{ text: 'a new claim', atoms: [], pointer: POINTER }] },
      ],
      [
        'повторный finish с тем же черновиком до проверки: ворота 2 раньше ворот 3',
        ANSWER,
        { claims: [SUPPORTED, newClaimStored], runs: [answerRun(DRAFT_WITH_NEW)], toolCalls: [refusedFinish('needs_verification')] },
        UNVERIFIED_NEW,
      ],
      [
        'новый черновик без проверки утверждений из needs_verification',
        ANSWER,
        {
          claims: [SUPPORTED, newClaimStored],
          runs: [answerRun(DRAFT_OF_CHECKED, { parentCallIndex: AFTER_REFUSAL })],
          toolCalls: [refusedFinish('needs_verification')],
        },
        UNVERIFIED_NEW,
      ],
      [
        'новые утверждения проверены, но черновик кончился до отказа',
        ANSWER,
        { claims: [SUPPORTED, newClaimChecked], runs: [answerRun(DRAFT_WITH_NEW)], toolCalls: [refusedFinish('needs_verification'), newClaimCall] },
        refused('draft_invalid'),
      ],
      ['запуска нет', ANSWER, {}, refused('draft_invalid')],
      ['запуск не корня', ANSWER, { runs: [answerRun(DRAFT_OF_CHECKED, { parent: 'task-other' })] }, refused('draft_invalid')],
      ['запуск кончился сбоем', ANSWER, { runs: [answerRun(null, { failure: { code: 'turn_limit' } })] }, refused('draft_invalid')],
      ['запуск агента другой формы', ANSWER, { runs: [answerRun(DRAFT_OF_CHECKED, { agent: 'worker' })] }, refused('draft_invalid')],
      ['результат запуска не черновик', ANSWER, { runs: [answerRun({ summary: 'a note', refs: [] })] }, refused('draft_invalid')],
    ])('%s', async (_case, result, scenario, expected) => {
      expect(await close(result, scenario)).toEqual(expected);
    });

    // AC-06.2 (the rule), Flow 3 (design-catalog-planning.md, «Закрытие корня и причина остановки»). Defects caught: an
    // investigation whose plan attempts are exhausted cannot close; `answer`, or «не выяснено» before the attempts are
    // exhausted, closes without a plan.
    describe('gate 1 without a plan', () => {
      const planWrite = (reason: string) => ({ run: 'task-planner', callIndex: 0, toolName: 'plan_write', arguments: {}, state: 'rejected', outcome: null, reason });
      const THREE_REFUSED = [planWrite('plan_sources_invalid'), planWrite('plan_sources_invalid'), planWrite('plan_sources_invalid')];
      const TWO_REFUSED = [planWrite('plan_sources_invalid'), planWrite('plan_sources_invalid'), planWrite('plan_attempts_exhausted')];

      it('inconclusive with the attempts exhausted is accepted with the reason plan_sources_rejected', async () => {
        expect(await close(INCONCLUSIVE, { plan: null, claims: [], toolCalls: THREE_REFUSED })).toMatchObject({
          kind: 'accept',
          result: { outcome: 'inconclusive', stopReason: 'plan_sources_rejected', established: [] },
        });
      });

      it.each<[string, unknown, readonly unknown[]]>([
        ['inconclusive before the attempts are exhausted', INCONCLUSIVE, TWO_REFUSED],
        ['answer with the attempts exhausted', ANSWER, THREE_REFUSED],
      ])('%s is refused plan_missing', async (_case, result, toolCalls) => {
        expect(await close(result, { plan: null, claims: [], runs: [answerRun(DRAFT_OF_CHECKED)], toolCalls })).toEqual(refused('plan_missing'));
      });
    });

    it.each<[string, string, string | null]>([
      ['успех', 'done', null],
      ['child_failed', 'done', 'child_failed'],
      ['budget_exhausted', 'rejected', 'budget_exhausted'],
      ['children_limit', 'rejected', 'children_limit'],
      ['task_limit', 'rejected', 'task_limit'],
    ])('законченный вызов проверяющего с исходом %s снимает ворота 2 и у answer, и у inconclusive', async (_case, state, reason) => {
      const scenario = { claims: [SUPPORTED, claimRow(OPEN, 'unverified')], runs: [answerRun(DRAFT_OF_CHECKED)], toolCalls: [verifierCall(OPEN, state, reason)] };

      expect(await close(ANSWER, scenario)).toMatchObject({ kind: 'accept' });
      expect(await close(INCONCLUSIVE, scenario)).toMatchObject({ kind: 'accept' });
    });

    // Owner decision: any other refusal is the caller's mistake, and the root must call the checker again.
    it.each<[string, string]>([
      ['предел вызовов за ход', 'calls_per_turn_limit'],
      ['access_denied', 'access_denied'],
      ['invalid_arguments', 'invalid_arguments'],
    ])('отказ вызова проверяющего (%s) не снимает ворота 2', async (_case, reason) => {
      const scenario = { claims: [SUPPORTED, claimRow(OPEN, 'unverified')], runs: [answerRun(DRAFT_OF_CHECKED)], toolCalls: [verifierCall(OPEN, 'rejected', reason)] };

      expect(await close(ANSWER, scenario)).toEqual(UNVERIFIED_OPEN);
      expect(await close(INCONCLUSIVE, scenario)).toEqual(UNVERIFIED_OPEN);
    });

    it('аналитик — определение с инструментом claims_write, а не имя: переименованный worker держит ворота 2', async () => {
      const { worker, ...agents } = config.agents;
      const processConfig = { ...config, agents: { ...agents, analyst: worker } };
      const analysts = [answerRun({ summary: 'done', refs: [] }, { run: 'task-analyst', agent: 'analyst', parentCallIndex: 0 })];

      expect(await close(INCONCLUSIVE, { processConfig, claims: [claimRow(OPEN, 'unverified', 'task-analyst')], runs: analysts })).toEqual(UNVERIFIED_OPEN);
    });

    it('утверждение другого автора ворота 2 не держат, а ворота 4 корня держат', async () => {
      const planners = [answerRun({ summary: 'done', refs: [] }, { run: PLANNER_TASK, agent: 'planner', parentCallIndex: 0 })];

      expect(await close(INCONCLUSIVE, { claims: [claimRow(OPEN, 'unverified', PLANNER_TASK)], runs: planners })).toMatchObject({ kind: 'accept' });
      expect(await close(INCONCLUSIVE, { claims: [claimRow(OPEN, 'unverified', ROOT_RUN)], runs: planners })).toEqual(UNVERIFIED_OPEN);
    });

    it('после проверки и нового черновика закрытие проходит: новое утверждение в «Установлено» по последней ревизии', async () => {
      const decision = await close(ANSWER, {
        claims: [SUPPORTED, newClaimChecked],
        runs: [answerRun(draftOf(draftClaim(CHECKED), draftClaim(NEW_CLAIM)), { parentCallIndex: AFTER_REFUSAL })],
        toolCalls: [refusedFinish('needs_verification'), newClaimCall],
      });

      expect(decision).toMatchObject({
        kind: 'accept',
        result: {
          outcome: 'answered',
          stopReason: null,
          established: [
            { claimId: CHECKED, verified: true, confidence: 'high' },
            { claimId: NEW_CLAIM, verified: true, confidence: 'high' },
          ],
          assumed: [],
        },
      });
    });

    it('отказ по другой причине ворота 3 и 4 не включает', async () => {
      expect(await close(ANSWER, { runs: [answerRun(DRAFT_WITH_NEW)], toolCalls: [refusedFinish('draft_invalid')] })).toMatchObject({
        kind: 'refuse',
        reason: 'needs_verification',
      });
    });
  });

  describe('ответ кодом', () => {
    it('UC-E8: overflow не отказывает, ответ кодом с причиной context_overflow', async () => {
      expect(await close(ANSWER, { runs: [answerRun({ overflow: true })] })).toMatchObject({
        kind: 'accept',
        result: { outcome: 'partial', stopReason: 'context_overflow', established: [{ claimId: CHECKED }] },
      });
    });

    it('overflow, кончившийся до отказа, отказывает draft_invalid', async () => {
      expect(await close(ANSWER, { runs: [answerRun({ overflow: true })], toolCalls: [refusedFinish('needs_verification')] })).toEqual(refused('draft_invalid'));
    });

    it('inconclusive с выполненными воротами: ответ собирает код, без проверки черновика', async () => {
      expect(await close(INCONCLUSIVE, {})).toMatchObject({
        kind: 'accept',
        result: { outcome: 'inconclusive', stopReason: null, summaryItems: [], established: [{ claimId: CHECKED }] },
        message: { text: expect.any(String) as unknown as string },
      });
    });

    it('принудительный конец корня: ответ кодом с причиной', async () => {
      const forcedEnd = FORM.forcedEnd!.not_after!;

      expect(forcedEnd.decide(await forcedEnd.collect!(ROOT, readerOf({})), {})).toMatchObject({
        kind: 'result',
        result: { outcome: 'partial', stopReason: 'deadline' },
      });
    });
  });

  describe('AC-15.2: в «Установлено» только проверенное', () => {
    const afterRefusal = (result: unknown, claims: readonly unknown[] = [SUPPORTED]): Scenario => ({
      claims,
      runs: [answerRun(result, { parentCallIndex: AFTER_REFUSAL })],
      toolCalls: [refusedFinish('needs_verification')],
    });

    it.each<[string, unknown, Scenario, unknown[]]>([
      ['номер, которого нет среди утверждений (из памяти или результата)', FROM_MEMORY, afterRefusal(draftOf(draftClaim(CHECKED), draftClaim(FROM_MEMORY, 'remembered'))), ['remembered']],
      ['новое утверждение на следующем закрытии', null, afterRefusal(draftOf(draftClaim(CHECKED), draftClaim(null, 'remembered'))), ['remembered']],
    ])('%s идёт в «Предположения» без отметки проверки и не записывается', async (_case, _id, scenario, assumed) => {
      const decision = await close(ANSWER, scenario);

      expect(decision).toMatchObject({
        kind: 'accept',
        result: { established: [{ claimId: CHECKED }], assumed: assumed.map((text) => ({ text, verified: false, causal: false })) },
      });
    });

    it('утверждение с последней ревизией unverified и законченным вызовом — предположение, а не установленное', async () => {
      const decision = await close(ANSWER, {
        claims: [claimRow(OPEN, 'unverified')],
        runs: [answerRun(draftOf(draftClaim(OPEN)))],
        toolCalls: [verifierCall(OPEN, 'rejected', 'budget_exhausted')],
      });

      expect(decision).toMatchObject({ kind: 'accept', result: { outcome: 'inconclusive', established: [], assumed: [{ claimId: OPEN, verified: false }] } });
    });
  });
});
