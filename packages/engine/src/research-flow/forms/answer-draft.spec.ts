import type { RuntimeTx } from '@agent-os/runtime';
import type { ForcedEndCode, FormDataReader, FormRunContext } from '../../agents/result-forms.js';
import { InvestigationAnswerSchema } from '../../answer/code-answer.js';
import { answerRepository } from '../../answer/answer.repository.js';
import { AgentProcessConfigSchema } from '../../config/agent-config.schema.js';
import { deepResearchProcessV3 } from '../../processes/shipped-processes.js';
import { ANSWER_DRAFT_FORM as FORM } from './answer-draft.js';

// AC-12.4, DC-3 (the form's side), UC-4, UC-E8 (the form's side); design-research-flow.md, Contract `answer_draft`. Defects
// caught: a root in `model_knowledge` puts a claim in «Установлено»; a child writes an answer; `overflow` becomes a failure.
// The steps run over the input of `collect`, with no database: a double of the reader.

const CLAIM = {
  claimId: 'claim-1',
  status: 'supported',
  confidence: 'high',
  text: 'seven failures',
  pointer: [{ pageId: '11111111-1111-4111-8111-111111111111', records: [0] }],
};
const WARNING = 'Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.';
const MODEL_KNOWLEDGE_MARK = '(из знаний модели, без источника)';
const QUESTION = 'why does the job fail?';

const definition = AgentProcessConfigSchema.parse(deepResearchProcessV3).agents.synthesis!;

const contextOf = (sourceMode: FormRunContext['sourceMode'], assignment: string, depth: number): FormRunContext => ({
  investigationId: 'investigation-1',
  resourceId: 'user-1',
  runTaskId: 'task-1',
  agentName: 'synthesis',
  definition,
  assignment,
  sourceMode,
  depth,
});
const CHILD = contextOf('sources', 'write the answer <now>', 1);
const ROOT = contextOf('model_knowledge', QUESTION, 0);

function readerOf(claims: readonly unknown[]): FormDataReader {
  const unused = () => Promise.reject(new Error('this step does not read it'));
  return {
    plan: unused,
    runs: unused,
    toolCalls: unused,
    records: unused,
    definitionMemoryFingerprint: unused,
    // The stored row holds more than the packet shows.
    claims: () => Promise.resolve(claims.map((claim) => ({ atoms: [], evidenceIds: [], coverage: null, taskId: 'task-0', ...(claim as object) }))),
    recordPages: () => Promise.resolve([]),
    engineRun: () => Promise.resolve({ launchKey: 'launch-1', sourceMode: 'model_knowledge' }),
    budgetExhausted: () => Promise.resolve(false),
  };
}

const collectPrologue = (context: FormRunContext, claims: readonly unknown[]) => FORM.prologue!.collect!(context, readerOf(claims));
const build = (input: unknown) => FORM.prologue!.build(input, {});
const collectClosure = (context: FormRunContext) => FORM.closure!.collect!(context, readerOf([]));

async function evaluate(context: FormRunContext, result: unknown) {
  return FORM.closure!.evaluate({ result, prologueInput: null, collected: await collectClosure(context) }, {});
}

/** One claim whose text makes the first message exactly `bytes` long (`x` is one byte, inside and outside JSON). */
async function claimOfMessageBytes(bytes: number) {
  const measured = build(await collectPrologue(CHILD, [{ ...CLAIM, text: '' }]));
  if (measured.kind !== 'start') throw new Error('a short packet starts');
  return { ...CLAIM, text: 'x'.repeat(bytes - Buffer.byteLength(measured.firstMessage, 'utf8')) };
}

const DRAFT = { outcome: 'answered', summaryClaimIds: [], claims: [] };
const newClaim = (text: string, pointer: unknown[] = []) => ({ claimId: null, text, atoms: [], pointer });

describe('черновик ответа формой answer_draft', () => {
  // The root is the run at depth 0, not the mode: a child of a root without sources still hands its draft up unchanged.
  it('дочерний запуск без источников отдаёт черновик как есть, ответа не строит', async () => {
    expect(await evaluate(contextOf('model_knowledge', 'write the answer', 1), DRAFT)).toEqual({ kind: 'accept', result: DRAFT });
  });


  describe('пролог', () => {
    it('у дочернего запуска пакет агента ответа, за ним задание вызывающего в конверте данных', async () => {
      const built = build(await collectPrologue(CHILD, [CLAIM]));

      expect(built).toEqual({
        kind: 'start',
        firstMessage: [
          '<assignment>',
          '{"claims":[{"claimId":"claim-1","status":"supported","confidence":"high","text":"seven failures","pointer":[{"pageId":"11111111-1111-4111-8111-111111111111","records":[0]}]}]}',
          '</assignment>',
          '<data source="caller task" author="agent">',
          'write the answer &lt;now&gt;',
          '</data>',
        ].join('\n'),
      });
    });

    it('у корня model_knowledge вопрос уже в пакете: пустой список утверждений и нет конверта с заданием', async () => {
      expect(build(await collectPrologue(ROOT, []))).toEqual({ kind: 'start', firstMessage: '<assignment>\n{"claims":[]}\n</assignment>' });
    });

    it('пакет ровно в 32 000 байт начинает запуск', async () => {
      const built = build(await collectPrologue(CHILD, [await claimOfMessageBytes(32_000)]));

      expect(built.kind === 'start' && Buffer.byteLength(built.firstMessage, 'utf8')).toBe(32_000);
    });

    it('UC-E8: пакет на байт длиннее — короткий вход, end overflow, а закрытие принимает его результатом overflow', async () => {
      const input = await collectPrologue(CHILD, [await claimOfMessageBytes(32_001)]);
      expect(input).toEqual({ kind: 'overflow', claimCount: 1 });

      const built = build(input);
      expect(built).toEqual({ kind: 'end', result: { overflow: true } });

      expect(await evaluate(CHILD, built.kind === 'end' ? built.result : null)).toEqual({ kind: 'accept', result: { overflow: true } });
    });
  });

  it('дочерний запуск принимает черновик как есть и ничего не пишет', async () => {
    const draft = { ...DRAFT, claims: [{ ...newClaim('a claim'), claimId: 'claim-1' }] };

    const decision = await evaluate(CHILD, draft);

    expect(decision).toEqual({ kind: 'accept', result: draft });
    const writeAnswer = vi.spyOn(answerRepository, 'writeAnswer');
    await FORM.closure!.write({} as RuntimeTx, CHILD, decision);
    expect(writeAnswer).not.toHaveBeenCalled();
    writeAnswer.mockRestore();
  });

  describe('AC-12.4, UC-4: закрытие у корня model_knowledge', () => {
    it.each(['answered', 'partial', 'inconclusive'])('черновик с исходом %s: ответ answered, каждое утверждение — предположение с пометкой', async (outcome) => {
      const decision = await evaluate(ROOT, { ...DRAFT, outcome, claims: [newClaim('first'), newClaim('second')] });

      expect(decision).toMatchObject({
        kind: 'accept',
        result: {
          outcome: 'answered',
          stopReason: null,
          established: [],
          unknown: [],
          removed: [],
          assumed: [
            { text: 'first', evidenceIds: [], verified: false, causal: false },
            { text: 'second', evidenceIds: [], verified: false, causal: false },
          ],
        },
      });
      const { text } = (decision as unknown as { message: { text: string } }).message;
      expect(text.startsWith(WARNING)).toBe(true);
      expect(text).toContain(`- first ${MODEL_KNOWLEDGE_MARK}`);
      expect(text).toContain(`- second ${MODEL_KNOWLEDGE_MARK}`);
      expect(text).not.toContain('Установлено');
    });

    it('утверждение со ссылкой на страницу снимается, а номера ответа проходят схему записанного ответа', async () => {
      const cited = newClaim('cited', [{ pageId: '11111111-1111-4111-8111-111111111111', records: [0] }]);

      const decision = await evaluate(ROOT, { ...DRAFT, claims: [newClaim('kept'), cited] });

      const accepted = decision as { result: unknown };
      const answer = InvestigationAnswerSchema.parse(accepted.result);
      expect(answer.assumed.map((claim) => claim.text)).toEqual(['kept']);
      expect(answer.removed).toMatchObject([{ text: 'cited', reason: 'evidence_not_found' }]);
      expect(new Set([answer.assumed[0]!.claimId, answer.removed[0]!.claimId]).size).toBe(2);
    });

    it('один и тот же сбор и черновик решаются одинаково: шаг решения чист', async () => {
      const collected = await collectClosure(ROOT);
      const input = { result: { ...DRAFT, claims: [newClaim('kept')] }, prologueInput: null, collected };

      expect(FORM.closure!.evaluate(input, {})).toEqual(FORM.closure!.evaluate(input, {}));
    });

    it('write кладёт ответ и его сообщение той же записью', async () => {
      const decision = await evaluate(ROOT, { ...DRAFT, claims: [newClaim('kept')] });
      const { result, message } = decision as unknown as { result: unknown; message: unknown };
      const writeAnswer = vi.spyOn(answerRepository, 'writeAnswer').mockResolvedValue(undefined as never);
      const tx = {} as RuntimeTx;

      await FORM.closure!.write(tx, ROOT, decision);

      expect(writeAnswer).toHaveBeenCalledWith(tx, 'investigation-1', result, message);
      writeAnswer.mockRestore();
    });
  });

  describe('принудительный конец', () => {
    const ROWS: readonly (readonly [ForcedEndCode, string])[] = [
      ['run_tokens_exhausted', 'budget_exhausted'],
      ['investigation_tokens_exhausted', 'budget_exhausted'],
      ['not_after', 'deadline'],
      ['turn_limit', 'step_limit'],
      ['model_unavailable', 'model_unavailable'],
      ['context_overflow', 'context_overflow'],
    ];

    const decide = async (code: ForcedEndCode, context: FormRunContext) => {
      const forcedEnd = FORM.forcedEnd![code]!;
      return forcedEnd.decide(await forcedEnd.collect!(context, readerOf([])), {});
    };

    it.each(ROWS)('%s у корня: ответ кодом inconclusive с причиной %s', async (code, stopReason) => {
      expect(await decide(code, ROOT)).toMatchObject({ kind: 'result', result: { outcome: 'inconclusive', stopReason, summaryItems: [] } });
    });

    it.each(ROWS)('%s у дочернего запуска: none', async (code) => {
      expect(await decide(code, CHILD)).toEqual({ kind: 'none' });
    });
  });
});
