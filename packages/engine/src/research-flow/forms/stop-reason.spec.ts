import type { FormDataReader, FormRunContext } from '../../agents/result-forms.js';
import type { StopReason } from '../../answer/code-answer.js';
import { AgentProcessConfigSchema } from '../../config/agent-config.schema.js';
import { deepResearchProcessV3 } from '../../processes/shipped-processes.js';
import { CODE_ANSWER_FORCED_END, decideCodeAnswer } from './code-answer-end.js';
import { type RootEnding, stopReasonOf } from './stop-reason.js';

// AC-12.3, AC-07.1, DC-1 (design-research-flow.md, «Как причина остановки получается из конца корня»). Defects caught: a
// `deadline` or `step_limit` although the tree was already refused by the budget; a lost `context_overflow`; an answer built
// by code with the wrong outcome or with a summary; a message built from anything but what `collect` read. The wiring of
// the forced end is INT-3 A–C (T5.4); `model_unavailable` and `context_overflow` of stage 4 are `turn-rules.spec.ts`.

describe('stopReasonOf: the stop reason follows the rule of precedence', () => {
  it.each<[RootEnding, boolean, StopReason | null]>([
    ['answer_overflow', false, 'context_overflow'],
    ['answer_overflow', true, 'context_overflow'],
    ['context_overflow', false, 'context_overflow'],
    ['context_overflow', true, 'context_overflow'],
    ['run_tokens_exhausted', false, 'budget_exhausted'],
    ['run_tokens_exhausted', true, 'budget_exhausted'],
    ['investigation_tokens_exhausted', false, 'budget_exhausted'],
    ['investigation_tokens_exhausted', true, 'budget_exhausted'],
    ['model_unavailable', false, 'model_unavailable'],
    ['model_unavailable', true, 'model_unavailable'],
    ['not_after', false, 'deadline'],
    ['not_after', true, 'budget_exhausted'],
    ['turn_limit', false, 'step_limit'],
    ['turn_limit', true, 'budget_exhausted'],
    ['inconclusive', false, null],
    ['inconclusive', true, 'budget_exhausted'],
  ])('%s with budgetExhausted %s is %s', (ending, budgetExhausted, expected) => {
    expect(stopReasonOf(ending, { budgetExhausted, planSourcesRejected: false })).toBe(expected);
  });
});

// AC-06.2 (the rule), Flow 3 (design-catalog-planning.md, «Закрытие корня и причина остановки»). Defect caught: an
// investigation stopped with no accepted plan and the attempts exhausted carries no reason, or one a later rule decides.
describe('no accepted plan and attempts exhausted → plan_sources_rejected', () => {
  it.each<[RootEnding, boolean]>([
    ['inconclusive', false],
    ['inconclusive', true],
    ['turn_limit', false],
    ['turn_limit', true],
    ['not_after', false],
    ['run_tokens_exhausted', false],
    ['investigation_tokens_exhausted', true],
    ['model_unavailable', false],
    ['context_overflow', false],
  ])('%s with budgetExhausted %s', (ending, budgetExhausted) => {
    expect(stopReasonOf(ending, { budgetExhausted, planSourcesRejected: true })).toBe('plan_sources_rejected');
  });
});

const ANSWER_CLAIM = '7b0c4a8e-9f62-4c1a-b2d4-8f1b6e2a9c33';
const OPEN_CLAIM = '9a1d2e3f-4b5c-4d6e-8f70-112233445566';
const PAGE_ID = '0d8f6f53-5e3e-4bd4-9d3f-2b6f5d0f5a11';

const supportedClaim = {
  claimId: ANSWER_CLAIM,
  text: 'payments restarted at 10:02',
  status: 'supported',
  confidence: 'medium',
  evidenceIds: [PAGE_ID],
};
const planWriteCall = (state: string, reason: string | null) => ({ toolName: 'plan_write', state, reason });
const refusedPlan = planWriteCall('rejected', 'plan_sources_invalid');
/** `plan_attempts_exhausted` is not an attempt: two refusals and it do not exhaust the attempts. */
const exhaustedPlan = planWriteCall('rejected', 'plan_attempts_exhausted');
const unverifiedClaim = { claimId: OPEN_CLAIM, text: 'the cache was cold', status: 'unverified', confidence: null, evidenceIds: [] };

const context: FormRunContext = {
  investigationId: 'investigation-1',
  resourceId: 'user-1',
  runTaskId: 'task-1',
  agentName: 'controller',
  definition: AgentProcessConfigSchema.parse(deepResearchProcessV3).agents.controller!,
  assignment: 'why did payments restart?',
  sourceMode: 'sources',
  depth: 0,
};

function readerOf(options: {
  readonly claims: readonly unknown[];
  readonly budgetExhausted?: boolean;
  readonly sourceMode?: string;
  readonly plan?: unknown;
  readonly toolCalls?: readonly unknown[];
}): FormDataReader {
  const unused = () => Promise.reject(new Error('this step does not read it'));
  return {
    plan: () => Promise.resolve(options.plan === undefined ? { revision: 1, plan: {} } : options.plan),
    runs: unused,
    toolCalls: () => Promise.resolve(options.toolCalls ?? []),
    records: unused,
    definitionMemoryFingerprint: unused,
    claims: () => Promise.resolve(options.claims),
    budgetExhausted: () => Promise.resolve(options.budgetExhausted ?? false),
    engineRun: () => Promise.resolve({ launchKey: 'launch-1', sourceMode: options.sourceMode ?? 'sources' }),
    recordPages: () =>
      Promise.resolve([
        {
          page: PAGE_ID,
          provenance: { sourceId: 'logs', toolName: 'search_logs', snapshot: 'snapshot-1' },
          coverage: { truncated: true },
        },
      ]),
  };
}

async function forcedEndAnswer(code: 'not_after' | 'turn_limit', reader: FormDataReader) {
  const forcedEnd = CODE_ANSWER_FORCED_END[code];
  const decision = forcedEnd.decide(await forcedEnd.collect!(context, reader), {});
  if (decision.kind !== 'result') throw new Error('the forced end of the root always has a result');
  return decision.result;
}

describe('the code answer of the root is built from what collect read', () => {
  it.each([
    ['a supported claim', [supportedClaim, unverifiedClaim], 'partial', 1],
    ['no supported claim', [unverifiedClaim], 'inconclusive', 0],
  ] as const)('a forced end with %s', async (_, claims, outcome, established) => {
    const answer = await forcedEndAnswer('not_after', readerOf({ claims }));

    expect(answer).toMatchObject({ outcome, stopReason: 'deadline', summary: null, summaryItems: [] });
    expect((answer as { established: unknown[] }).established).toHaveLength(established);
  });

  it('takes the reason from the sign budgetExhausted of the tree', async () => {
    const answer = await forcedEndAnswer('turn_limit', readerOf({ claims: [supportedClaim], budgetExhausted: true }));

    expect(answer).toMatchObject({ outcome: 'partial', stopReason: 'budget_exhausted' });
  });

  it('builds the message from the goal, the engine row and the provenance of the cited page', async () => {
    const forcedEnd = CODE_ANSWER_FORCED_END.not_after;
    const collected = await forcedEnd.collect!(context, readerOf({ claims: [supportedClaim] }));

    const { message } = decideCodeAnswer(collected, 'not_after');

    expect(message.metadata).toMatchObject({
      outcome: 'partial',
      goal: 'why did payments restart?',
      launchKey: 'launch-1',
      sources: [{ number: 1, sourceId: 'logs', toolName: 'search_logs', snapshot: 'snapshot-1', truncated: true }],
    });
    expect(message.text).toContain('Остановлен: истёк срок расследования');
  });

  it('closes as not established without a reason, whatever is supported, when the budget was not refused', async () => {
    const forcedEnd = CODE_ANSWER_FORCED_END.not_after;
    const collected = await forcedEnd.collect!(context, readerOf({ claims: [supportedClaim] }));

    const { result } = decideCodeAnswer(collected, 'inconclusive');

    expect(result).toMatchObject({ outcome: 'inconclusive', stopReason: null });
  });

  it.each([
    ['a forced end', 'turn_limit'],
    ['the closure «не выяснено»', 'inconclusive'],
  ] as const)('with no plan and three plan attempts refused, %s stops with plan_sources_rejected', async (_, ending) => {
    const reader = readerOf({ claims: [], budgetExhausted: true, plan: null, toolCalls: [refusedPlan, refusedPlan, refusedPlan] });
    const collected = await CODE_ANSWER_FORCED_END.turn_limit.collect!(context, reader);

    const answer = decideCodeAnswer(collected, ending);

    expect(answer.result).toMatchObject({ outcome: 'inconclusive', stopReason: 'plan_sources_rejected' });
    expect(answer.message.text).toContain('Остановлен: план не прошёл проверку источников');
  });

  it.each([
    ['two attempts refused', null, [refusedPlan, refusedPlan, exhaustedPlan]],
    ['an accepted revision', { revision: 1, plan: {} }, [refusedPlan, refusedPlan, refusedPlan]],
  ] as const)('with %s a forced end keeps its own reason', async (_, plan, toolCalls) => {
    const answer = await forcedEndAnswer('turn_limit', readerOf({ claims: [], plan, toolCalls }));

    expect(answer).toMatchObject({ outcome: 'inconclusive', stopReason: 'step_limit' });
  });

  it('without sources is inconclusive with its reason and cites no page', async () => {
    const answer = decideCodeAnswer(
      await CODE_ANSWER_FORCED_END.turn_limit.collect!(
        { ...context, sourceMode: 'model_knowledge' },
        readerOf({ claims: [], sourceMode: 'model_knowledge' }),
      ),
      'turn_limit',
    );

    expect(answer.result).toMatchObject({ outcome: 'inconclusive', stopReason: 'step_limit' });
    expect(answer.message.metadata.sources).toEqual([]);
  });
});
