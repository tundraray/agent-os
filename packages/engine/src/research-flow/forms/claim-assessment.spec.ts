import type { FormBindings, FormDataReader, FormRunContext } from '../../agents/result-forms.js';
import { agentFingerprint } from '../../agents/fingerprint.js';
import { agentToolsOf, BASE_TOOLS, createToolRegistry } from '../../agents/tool-registry.js';
import type { GroupTable } from '../../calibration/group-table.js';
import { AgentProcessConfigSchema } from '../../config/agent-config.schema.js';
import { deepResearchProcessV3 } from '../../processes/shipped-processes.js';
import { CLAIM_ASSESSMENT_FORM as FORM, type ClaimAssessmentPrologueInput } from './claim-assessment.js';

// DC-7, DC-8, DC-10, UC-E2 (design-research-flow.md, Contract `claim_assessment`). Defects caught: the status comes from a
// text instead of the assessment's fields; a group without the bound table of the pair; a lost `insufficient`; a wrong
// group when there is no table. The steps run over the input of `collect`, with no database: a double of the reader.

const CLAIM_ID = 'claim-1';
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const MEMORY_FINGERPRINT = 'abcdefabcdef';
const PROFILE = { claimType: 'quantitative', valueCheck: 'matched', independentRecords: 'two_or_more', contradictions: false } as const;
const ITEMS = [{ count: 7, note: 'first' }, { count: 7, note: 'second' }, { count: 1, note: 'not pointed' }];
const POINTER = [{ pageId: PAGE_ID, records: [0, 1] }];

const definition = AgentProcessConfigSchema.parse(deepResearchProcessV3).agents.verifier!;
const AGENT_FINGERPRINT = agentFingerprint({
  definition,
  tools: agentToolsOf(definition.tools, { registry: createToolRegistry(BASE_TOOLS), resultSchema: FORM.resultSchema }),
  form: FORM,
});

const context: FormRunContext = {
  investigationId: 'investigation-1',
  resourceId: 'user-1',
  runTaskId: 'task-1',
  agentName: 'verifier',
  definition,
  assignment: CLAIM_ID,
  sourceMode: 'sources',
  depth: 1,
};

function readerOf(options: { readonly text?: string; readonly items?: readonly unknown[] } = {}): FormDataReader {
  const unused = () => Promise.reject(new Error('this step does not read it'));
  return {
    plan: unused,
    runs: unused,
    engineRun: unused,
    toolCalls: unused,
    budgetExhausted: unused,
    claims: () =>
      Promise.resolve([
        { claimId: CLAIM_ID, text: options.text ?? 'seven failures', atoms: [{ kind: 'number', value: '7' }], pointer: POINTER, status: 'unverified' },
      ]),
    recordPages: () =>
      Promise.resolve([
        {
          page: PAGE_ID,
          evidenceKey: 'key',
          provenance: { sourceId: 'logs', toolName: 'search_logs', normalizedArgs: { service: 'api' }, snapshot: 'snapshot-1' },
          coverage: { completeness: 'complete' },
        },
      ]),
    records: (page, from) => Promise.resolve(page === PAGE_ID ? (options.items ?? ITEMS).slice(from) : null),
    definitionMemoryFingerprint: () => Promise.resolve(MEMORY_FINGERPRINT),
  };
}

const collect = (reader: FormDataReader = readerOf(), run: FormRunContext = context) => FORM.prologue!.collect!(run, reader);

const table = (overrides: Partial<GroupTable>): GroupTable => ({
  model: 'anthropic/claude-haiku-5-5',
  agentFingerprint: AGENT_FINGERPRINT,
  definitionMemoryFingerprint: MEMORY_FINGERPRINT,
  scenarioSet: 'first',
  pairsFingerprint: '0123456789ab',
  calibratedAt: '2026-11-07T10:00:00.000Z',
  groupCount: 3,
  profiles: [{ profile: PROFILE, group: 'medium' }],
  groups: [{ group: 'medium', establishedPairs: 12, correctShare: 0.8 }],
  pairKinds: [{ pairKind: 'supported', supportMatch: 0.9, typeMatch: 0.8, decisionMatch: 0.85 }],
  ...overrides,
});

const tablesBound = (tables: readonly GroupTable[]): FormBindings => ({ groupTables: { kind: 'definition_pair_table', value: tables } });
const CALIBRATING: FormBindings = {
  groupTables: { kind: 'fixed', value: { calibrating: { agentFingerprint: AGENT_FINGERPRINT, definitionMemoryFingerprint: MEMORY_FINGERPRINT } } },
};

const assessment = (support: 'yes' | 'no' | 'insufficient', claimType = 'quantitative', relation = 'supports') => ({
  support,
  claimType,
  records: [0, 1].map((record) => ({ record, relation })),
});

const evaluate = (result: unknown, prologueInput: unknown, bindings: FormBindings = tablesBound([])) =>
  FORM.closure!.evaluate({ result, prologueInput, collected: null }, bindings);

/** A record pad that makes the first message exactly `bytes` long (`x` is one byte, inside and outside JSON). */
async function itemsOfMessageBytes(bytes: number): Promise<unknown[]> {
  const measured = FORM.prologue!.build(await collect(readerOf({ items: [{ count: 7, note: '' }, ITEMS[1]] })), tablesBound([]));
  if (measured.kind !== 'start') throw new Error('a short packet starts');
  return [{ count: 7, note: 'x'.repeat(bytes - Buffer.byteLength(measured.firstMessage, 'utf8')) }, ITEMS[1]];
}

describe('проверка утверждения формой claim_assessment', () => {
  describe('DC-7: пакет и его предел в 24 000 байт', () => {
    it('пакет ровно в 24 000 байт начинает запуск полным входом', async () => {
      const input = await collect(readerOf({ items: await itemsOfMessageBytes(24_000) }));

      const built = FORM.prologue!.build(input, tablesBound([]));

      expect(built.kind).toBe('start');
      expect(built.kind === 'start' && Buffer.byteLength(built.firstMessage, 'utf8')).toBe(24_000);
    });

    it('пакет на байт длиннее: короткий вход, end needs_narrowing, accept с ревизией insufficient без основы', async () => {
      const input = await collect(readerOf({ items: await itemsOfMessageBytes(24_001) }));

      expect(input).toEqual({
        kind: 'oversize',
        claimId: CLAIM_ID,
        pointer: POINTER,
        agentFingerprint: AGENT_FINGERPRINT,
        definitionMemoryFingerprint: MEMORY_FINGERPRINT,
      });
      const built = FORM.prologue!.build(input, tablesBound([]));
      expect(built).toEqual({ kind: 'end', result: { end: 'needs_narrowing', claimId: CLAIM_ID } });

      const decided = evaluate(built.kind === 'end' ? built.result : null, input);
      expect(decided).toMatchObject({
        kind: 'accept',
        result: { claimId: CLAIM_ID, status: 'insufficient', group: null },
        revision: {
          status: 'insufficient',
          atoms: null,
          evidenceIds: [],
          claimType: null,
          confidence: null,
          assessment: { answer: null, invalidForm: false, reason: 'needs_narrowing' },
        },
      });
    });

    it('полный вход длиннее предела (путь калибровки без collect) тоже кончается end needs_narrowing', async () => {
      const full = (await collect()) as ClaimAssessmentPrologueInput;
      const huge = { ...full, pages: full.pages.map((page) => ({ ...page, records: [{ note: 'x'.repeat(24_000) }, ...page.records.slice(1)] })) };

      expect(FORM.prologue!.build(huge, CALIBRATING)).toEqual({ kind: 'end', result: { end: 'needs_narrowing', claimId: CLAIM_ID } });
    });
  });

  it('пакет проверки: утверждение с атомами и только записи указателя по порядку', async () => {
    const built = FORM.prologue!.build(await collect(), tablesBound([]));

    expect(built.kind === 'start' && built.firstMessage).toBe(
      [
        '<claim>',
        '{"text":"seven failures","atoms":[{"kind":"number","value":"7","verdict":"found","records":[0,1]}]}',
        '</claim>',
        '<data>',
        '{"page":{"source":"logs","tool":"search_logs","args":{"service":"api"},"snapshot":"snapshot-1","complete":true}}',
        '{"number":0,"record":{"count":7,"note":"first"}}',
        '{"number":1,"record":{"count":7,"note":"second"}}',
        '</data>',
      ].join('\n'),
    );
  });

  it('задание — не номер утверждения этого расследования: end not_a_claim, закрытие отказывает', async () => {
    const input = await collect(readerOf(), { ...context, assignment: 'look at the logs' });
    const built = FORM.prologue!.build(input, tablesBound([]));

    expect(built).toEqual({ kind: 'end', result: { end: 'not_a_claim' } });
    expect(evaluate(built.kind === 'end' ? built.result : null, input)).toMatchObject({ kind: 'refuse' });
  });

  it.each<[string, unknown]>([
    ['yes без записи supports', assessment('yes', 'quantitative', 'unrelated')],
    ['номер записи вне входа', { support: 'no', claimType: 'observation', records: [{ record: 0, relation: 'contradicts' }, { record: 2, relation: 'unrelated' }] }],
    ['не все записи получили отношение', { support: 'no', claimType: 'observation', records: [{ record: 0, relation: 'contradicts' }] }],
  ])('DC-8: оценка не по форме (%s) — refuse invalid_result', async (_case, result) => {
    expect(evaluate(result, await collect())).toEqual({ kind: 'refuse', reason: 'invalid_result' });
  });

  it.each<[string, () => FormBindings, string | null]>([
    ['таблица своей пары с профилем в группе medium', () => tablesBound([table({})]), 'medium'],
    ['таблица другой пары', () => tablesBound([table({ agentFingerprint: '000000000000' })]), 'low'],
    ['таблица другой памяти', () => tablesBound([table({ definitionMemoryFingerprint: '000000000000' })]), 'low'],
    ['таблицы нет', () => tablesBound([]), 'low'],
    ['таблица своей пары без этого профиля', () => tablesBound([table({ profiles: [] })]), 'low'],
  ])('DC-10: %s — группа %s', async (_case, bindings, group) => {
    const decided = evaluate(assessment('yes'), await collect(), bindings());

    expect(decided).toMatchObject({ kind: 'accept', result: { claimId: CLAIM_ID, status: 'supported', group }, revision: { confidence: group } });
    expect(decided.kind === 'accept' && Object.keys(decided.result as object).sort()).toEqual(['claimId', 'group', 'status']);
  });

  it('пометка «калибруемый»: статус и профиль без группы, таблица не читается', async () => {
    expect(evaluate(assessment('yes'), await collect(), CALIBRATING)).toMatchObject({
      kind: 'accept',
      result: { claimId: CLAIM_ID, status: 'supported', group: null, profile: PROFILE, assessment: assessment('yes') },
    });
  });

  // The claim text says the opposite of the assessment in every row: only the fields of the assessment decide.
  it.each<[string, () => unknown, string, string[], string | null]>([
    ['support yes', () => assessment('yes'), 'supported', [PAGE_ID], 'low'],
    ['support no', () => assessment('no', 'quantitative', 'contradicts'), 'refuted', [PAGE_ID], null],
    ['support insufficient', () => assessment('insufficient', 'quantitative', 'unrelated'), 'insufficient', [], null],
    ['тип causal', () => assessment('yes', 'causal'), 'causal', [PAGE_ID], null],
  ])('статус следует полям оценки, а не тексту: %s', async (_case, result, status, evidenceIds, confidence) => {
    const input = await collect(readerOf({ text: 'this claim is refuted, insufficient and supported at once' }));

    expect(evaluate(result(), input)).toMatchObject({ kind: 'accept', revision: { status, evidenceIds, confidence } });
  });

  it('ревизия оценки несёт тип, ответ проверяющего и итог сверки атомов', async () => {
    expect(evaluate(assessment('yes'), await collect())).toMatchObject({
      revision: {
        claimType: 'quantitative',
        assessment: { answer: assessment('yes'), invalidForm: false },
        atoms: [{ kind: 'number', value: '7', verdict: 'found', records: [0, 1] }],
      },
    });
  });

  it('страница, названная в указателе дважды, остаётся одной записью основы, номера записей совпадают с пакетом', async () => {
    const pointer = [{ pageId: PAGE_ID, records: [0] }, { pageId: PAGE_ID, records: [1] }];
    const reader: FormDataReader = {
      ...readerOf(),
      claims: () => Promise.resolve([{ claimId: CLAIM_ID, text: 'seven', atoms: [{ kind: 'number', value: '7' }], pointer }]),
    };

    expect(evaluate(assessment('yes'), await collect(reader))).toMatchObject({ result: { status: 'supported' }, revision: { evidenceIds: [PAGE_ID] } });
  });

  it.each<[string, { kind: string; result?: unknown }]>([
    ['turn_limit', { kind: 'result', result: { claimId: CLAIM_ID, status: 'insufficient', group: null } }],
    ['run_tokens_exhausted', { kind: 'none' }],
    ['investigation_tokens_exhausted', { kind: 'none' }],
    ['not_after', { kind: 'none' }],
    ['model_unavailable', { kind: 'none' }],
    ['context_overflow', { kind: 'none' }],
  ])('DC-8: принудительный конец %s', async (code, expected) => {
    const forcedEnd = FORM.forcedEnd![code as 'turn_limit']!;
    const collected = forcedEnd.collect === undefined ? null : await forcedEnd.collect(context, readerOf());

    expect(forcedEnd.decide(collected, tablesBound([]))).toEqual(expected);
  });
});
