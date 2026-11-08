import { z } from 'zod';
import type { AgentTurnResult } from '../model/model-gateway.js';
import type { AgentToolDefinition } from '../model/role-agent.js';
import {
  type AfterTurn,
  type AnswerStep,
  decideAfterTurn,
  decideAnswer,
  decideNextTurn,
  decideView,
  routeFailure,
  type NextTurn,
  toolsOfTurn,
} from './turn-rules.js';

// The decision of a turn (design-agent-core.md, C4 «один ход», steps 1 and 6, DC-2, DC-14, DC-17, DC-27, DC-30; UC-E7,
// UC-E8 and UC-E15 on the handler's side): pure rules over numbers and outcomes, no doubles. The handler only glues them.
// Defects caught: a turn started after the deadline; a last turn that offers more than `finish`; a run that goes on past
// `maxTurns` without a result; an attempt that keeps its slot past its slice or a busy reserve; a turn number that grows
// when the window rule steps up; a gateway call with a view that does not fit even at stage 4.

const NOW = new Date('2026-11-08T10:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const TURN_MS = 60_000;
const SLICE_MS = 300_000;

const next = (patch: Partial<Parameters<typeof decideNextTurn>[0]> = {}) =>
  decideNextTurn({
    turnsTaken: 2,
    maxTurns: 8,
    now: NOW,
    notAfter: at(10 * 60_000),
    turnMs: TURN_MS,
    attemptStartedAt: at(-60_000),
    attemptSliceMs: SLICE_MS,
    ...patch,
  });

describe('решение хода: before a turn', () => {
  it.each<[string, Partial<Parameters<typeof decideNextTurn>[0]>, NextTurn]>([
    ['a turn within every limit goes as the next number', {}, { kind: 'turn', turn: 3, last: false }],
    ['the turn numbered maxTurns is the last', { turnsTaken: 7 }, { kind: 'turn', turn: 8, last: true }],
    ['a run that took maxTurns turns without a result ends turn_limit', { turnsTaken: 8 }, { kind: 'fail', code: 'turn_limit' }],
    ['less than AGENT_TURN_MS left to notAfter ends not_after', { notAfter: at(TURN_MS - 1) }, { kind: 'fail', code: 'not_after' }],
    ['exactly AGENT_TURN_MS left to notAfter still starts a turn', { notAfter: at(TURN_MS) }, { kind: 'turn', turn: 3, last: false }],
    ['an attempt past its slice yields', { attemptStartedAt: at(-SLICE_MS) }, { kind: 'yield' }],
  ])('%s', (_case, patch, expected) => {
    expect(next(patch)).toEqual(expected);
  });
});

const TOOLS: AgentToolDefinition[] = [
  { name: 'memory_read', description: 'Reads notes', inputSchema: z.object({}) },
  { name: 'finish', description: 'Returns the result', inputSchema: z.object({ summary: z.string() }) },
];

describe('решение хода: the tools of a turn', () => {
  it.each([
    ['a turn before the last: every tool, the model chooses', false, ['memory_read', 'finish'], 'auto'],
    ['the last turn: finish alone, forced', true, ['finish'], { toolName: 'finish' }],
  ] as const)('%s', (_case, last, names, toolChoice) => {
    const chosen = toolsOfTurn(TOOLS, last);

    expect(chosen.tools.map((tool) => tool.name)).toEqual(names);
    expect(chosen.toolChoice).toEqual(toolChoice);
  });
});

describe('решение хода: the view and the gateway answer', () => {
  it.each([
    ['a view that fits by the estimate is sent', true, { kind: 'send' }],
    ['a view that does not fit even at stage 4 fails context_overflow without the gateway', false, { kind: 'fail', code: 'context_overflow' }],
  ] as const)('%s', (_case, fits, expected) => {
    expect(decideView({ fits })).toEqual(expected);
  });

  const answered = (toolCalls: number): AgentTurnResult => ({
    outcome: 'answered',
    answer: {
      callId: 'call-1',
      text: 'thinking',
      toolCalls: Array.from({ length: toolCalls }, (_, index) => ({ toolCallId: `t${index}`, toolName: 'memory_read', args: {} })),
    },
  });

  it.each<[string, AgentTurnResult, number, AnswerStep]>([
    ['an answer with calls is recorded as it is', answered(2), 0, { kind: 'record', notice: null }],
    ['an answer without a call is a turn with the notice no_tool_call', answered(0), 0, { kind: 'record', notice: 'no_tool_call' }],
    [
      'window_exceeded below stage 4: the next stage, the same turn',
      { outcome: 'no_answer', reason: 'window_exceeded', countedInputTokens: 30_000 },
      2,
      { kind: 'next_stage', stage: 3 },
    ],
    [
      'window_exceeded at stage 4 fails context_overflow',
      { outcome: 'no_answer', reason: 'window_exceeded', countedInputTokens: 30_000 },
      4,
      { kind: 'fail', code: 'context_overflow' },
    ],
    ['busy_wait_exhausted yields', { outcome: 'no_answer', reason: 'busy_wait_exhausted' }, 0, { kind: 'yield' }],
    ['a call cut at notAfter fails not_after', { outcome: 'no_answer', reason: 'deadline' }, 0, { kind: 'fail', code: 'not_after' }],
    ['a cancel ends the attempt without a write', { outcome: 'no_answer', reason: 'cancelled' }, 0, { kind: 'abandon', cause: 'cancelled' }],
    ['a lost attempt ends without a write', { outcome: 'fenced' }, 0, { kind: 'abandon', cause: 'fenced' }],
    [
      'a refused share fails run_tokens_exhausted',
      { outcome: 'failed', code: 'run_tokens_exhausted', failureClass: 'budget_exhausted' },
      0,
      { kind: 'fail', code: 'run_tokens_exhausted' },
    ],
    [
      'an unavailable model fails model_unavailable',
      { outcome: 'failed', code: 'model_unavailable', failureClass: 'transport_protocol' },
      0,
      { kind: 'fail', code: 'model_unavailable' },
    ],
  ])('%s', (_case, result, stage, expected) => {
    expect(decideAnswer(result, stage as 0 | 1 | 2 | 3 | 4)).toEqual(expected);
  });
});

describe('решение хода: after the calls of a turn', () => {
  const finish = { callId: 'c-finish', result: { summary: 'done' } };

  it.each<[string, Parameters<typeof decideAfterTurn>[0], AfterTurn]>([
    ['a lone finish that passed its form completes the run', { finish, waitFor: [], turn: 3, maxTurns: 8 }, { kind: 'complete', finish }],
    [
      'finish beside other calls is refused finish_not_alone, the others ran: the run goes on',
      { finish: null, waitFor: [], turn: 3, maxTurns: 8 },
      { kind: 'next' },
    ],
    ['calls of class task wait for their tasks', { finish: null, waitFor: ['t-1', 't-2'], turn: 3, maxTurns: 8 }, { kind: 'wait', waitFor: ['t-1', 't-2'] }],
    ['the last turn without an accepted finish fails turn_limit', { finish: null, waitFor: [], turn: 8, maxTurns: 8 }, { kind: 'fail', code: 'turn_limit' }],
    ['the last turn with a lone accepted finish completes', { finish, waitFor: [], turn: 8, maxTurns: 8 }, { kind: 'complete', finish }],
  ])('%s', (_case, input, expected) => {
    expect(decideAfterTurn(input)).toEqual(expected);
  });
});

// DC-21, DC-30: a failure the handler would end the run with goes through the form's forced end when the form has a
// function for its code — `context_overflow` of the window rule as any other; without one, or for the prologue's own
// codes, the run fails.
// Defects caught: the window's failure skips the forced end, or a code without a function runs one.
describe('код сбоя → принудительный конец формы или сбой', () => {
  const withForcedEnd = { forcedEnd: { context_overflow: {}, turn_limit: {} } };

  it.each<[string, string, { readonly forcedEnd?: Readonly<Record<string, unknown>> }, ReturnType<typeof routeFailure>]>([
    ['context_overflow with its function', 'context_overflow', withForcedEnd, { kind: 'forced_end', code: 'context_overflow' }],
    ['turn_limit with its function', 'turn_limit', withForcedEnd, { kind: 'forced_end', code: 'turn_limit' }],
    ['context_overflow without a function', 'context_overflow', {}, { kind: 'fail' }],
    ['turn_limit when the form has functions for other codes', 'turn_limit', { forcedEnd: { not_after: {} } }, { kind: 'fail' }],
    ['prologue_oversize, which has no forced end', 'prologue_oversize', withForcedEnd, { kind: 'fail' }],
  ])('%s', (_case, code, form, expected) => {
    expect(routeFailure(code, form)).toEqual(expected);
  });
});
