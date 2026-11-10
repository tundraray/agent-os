import {
  type AssessBinding,
  type AssessUsage,
  type Engine,
  promptVersion,
} from '@agent-os/engine';
import type { JudgeCheck, ScenarioKey } from '@agent-os/mcp-fixture';
import type { z } from 'zod';
import type { SelfCheckSettings } from '../settings.js';
import {
  checkKeyedForm,
  checkUnkeyedForm,
  type FormCheckResult,
} from './form-check.js';
import {
  type JudgedAnswer,
  type KeyedJudgeForm,
  KeyedJudgeFormSchema,
  keyedJudgeInput,
  type UnkeyedJudgeForm,
  UnkeyedJudgeFormSchema,
  unkeyedJudgeInput,
} from './judge-forms.js';

/**
 * The judge of the self-check program (design-self-check.md, «Как выносится вердикт сценария», DC-3): one
 * `Engine.assess` call with role `judge` that fills a closed-value form. The model only fills the form; the form check
 * and the verdict ladder decide. The judge sees the question, the answer's claims and, with a key, the key's phrases
 * and facts — never a record page (NFR-02). A provider that does not answer and a form not by the rules both give
 * `judge_invalid`; the run goes on.
 */

export type JudgeSettings = SelfCheckSettings['judge'];

/** Which of the two judge prompts a call uses. */
export type JudgePrompt = keyof JudgeSettings['prompts'];

export interface JudgeDeps {
  readonly engine: Pick<Engine, 'assess'>;
  readonly judge: JudgeSettings;
}

/** The checked form and the spend of every attempt; the caller counts the spend into the run's budget. */
export interface JudgeCallResult<Form> {
  readonly checked: FormCheckResult<Form>;
  readonly usage: AssessUsage;
}

/** The judge as a run result names it: its model and the version of the prompt it was called with (`RunResult.judge`). */
export interface JudgeIdentity {
  readonly model: string;
  readonly promptVersion: string;
}

const INVALID = { valid: false, reason: 'judge_invalid' } as const;

/** The judge's model and the fingerprint of the prompt, by the same function as a role's prompt version (KD-2). */
export function judgeIdentity(
  judge: JudgeSettings,
  prompt: JudgePrompt,
): JudgeIdentity {
  return {
    model: judge.model,
    promptVersion: promptVersion(judge.prompts[prompt]),
  };
}

export interface KeyedRunJudgeInput {
  readonly key: ScenarioKey;
  readonly answer: JudgedAnswer;
  /** The run's investigation, of `system:self-check`; the judge transcript is bound to it. */
  readonly investigationId: string;
  readonly notAfter: Date;
}

/** The keyed judge on a scenario run's answer, bound to the run's investigation. */
export async function judgeRunWithKey(
  deps: JudgeDeps,
  { key, answer, investigationId, notAfter }: KeyedRunJudgeInput,
): Promise<JudgeCallResult<KeyedJudgeForm>> {
  const called = await callJudge(deps, {
    prompt: 'withKey',
    input: keyedJudgeInput(key, answer),
    outputSchema: KeyedJudgeFormSchema,
    binding: { investigationId },
    notAfter,
  });
  return {
    checked: called.answered
      ? checkKeyedForm(called.output, { scenarioKind: key.kind, answer })
      : INVALID,
    usage: called.usage,
  };
}

export interface UnkeyedRunJudgeInput {
  /** The investigation's question as it was asked. */
  readonly question: string;
  readonly answer: JudgedAnswer;
  /**
   * What the judge transcript is bound to, chosen by the caller: a repeat's own investigation, or — for an employee's
   * investigation, which must not get a self-check transcript — an id that remembers that source.
   */
  readonly binding: AssessBinding;
  readonly notAfter: Date;
}

/** The judge without a key on an answer: does it answer the question (FR-07); the form feeds the failure signals. */
export async function judgeRunWithoutKey(
  deps: JudgeDeps,
  { question, answer, binding, notAfter }: UnkeyedRunJudgeInput,
): Promise<JudgeCallResult<UnkeyedJudgeForm>> {
  const called = await callJudge(deps, {
    prompt: 'withoutKey',
    input: unkeyedJudgeInput(question, answer),
    outputSchema: UnkeyedJudgeFormSchema,
    binding,
    notAfter,
  });
  return {
    checked: called.answered ? checkUnkeyedForm(called.output) : INVALID,
    usage: called.usage,
  };
}

export interface JudgeCheckInput {
  readonly check: JudgeCheck;
  /** The key of the check's scenario. */
  readonly key: ScenarioKey;
  /** `self-check:run:<runId>`: a check answer belongs to no investigation. */
  readonly selfCheckRunId: string;
  readonly notAfter: Date;
}

/** Whether the judge filled a check answer's form right, and the spend of the call (DC-8, AC-04.4). */
export interface JudgeCheckResult {
  readonly agreed: boolean;
  readonly usage: AssessUsage;
}

/**
 * The keyed judge on one check answer with a known form, bound to the self-check run. The judge agrees when its
 * form passes the form check and equals the known form field for field; the order of claim ids within a field does
 * not matter.
 */
export async function judgeCheck(
  deps: JudgeDeps,
  { check, key, selfCheckRunId, notAfter }: JudgeCheckInput,
): Promise<JudgeCheckResult> {
  const called = await callJudge(deps, {
    prompt: 'withKey',
    input: keyedJudgeInput(key, check.answer),
    outputSchema: KeyedJudgeFormSchema,
    binding: { selfCheckRunId },
    notAfter,
  });
  if (!called.answered) return { agreed: false, usage: called.usage };
  const checked = checkKeyedForm(called.output, {
    scenarioKind: key.kind,
    answer: check.answer,
  });
  return {
    agreed: checked.valid && sameForm(checked.form, check.form),
    usage: called.usage,
  };
}

interface JudgeRequest<T> {
  readonly prompt: JudgePrompt;
  /** The judge input; it travels as one user message, the JSON of this object. */
  readonly input: object;
  readonly outputSchema: z.ZodType<T>;
  readonly binding: AssessBinding;
  readonly notAfter: Date;
}

type JudgeAnswer<T> =
  | { readonly answered: true; readonly output: T; readonly usage: AssessUsage }
  | { readonly answered: false; readonly usage: AssessUsage };

/**
 * One `Engine.assess` call with role `judge`. `invalid_output` (after the retry `assess` makes) and `failed`
 * (`model_unavailable`, the provider did not answer) are the judge not answering by the rules; anything `assess`
 * throws is a fault of the program and propagates.
 */
async function callJudge<T>(
  { engine, judge }: JudgeDeps,
  request: JudgeRequest<T>,
): Promise<JudgeAnswer<T>> {
  const result = await engine.assess({
    role: 'judge',
    model: judge.model,
    effort: judge.effort,
    maxOutputTokens: judge.maxOutputTokens,
    instructions: judge.prompts[request.prompt],
    messages: [{ role: 'user', content: JSON.stringify(request.input) }],
    outputSchema: request.outputSchema,
    binding: request.binding,
    notAfter: request.notAfter,
  });
  return result.outcome === 'answered'
    ? { answered: true, output: result.output, usage: result.usage }
    : { answered: false, usage: result.usage };
}

const CLAIM_ID_FIELDS = [
  'causeChangeClaimIds',
  'causeLinkClaimIds',
  'otherCauseClaimIds',
  'contradictingClaimIds',
] as const satisfies readonly (keyof KeyedJudgeForm)[];

const VALUE_FIELDS = [
  'causeChange',
  'causeLink',
  'otherCauseEstablished',
] as const satisfies readonly (keyof KeyedJudgeForm)[];

/** Equal closed values, and the same set of claim ids in each id field. */
function sameForm(filled: KeyedJudgeForm, known: KeyedJudgeForm): boolean {
  return (
    VALUE_FIELDS.every((field) => filled[field] === known[field]) &&
    CLAIM_ID_FIELDS.every((field) => sameIds(filled[field], known[field]))
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((id) => rightSet.has(id))
  );
}
