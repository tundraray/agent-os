import type { RunRecord } from '@agent-os/engine';
import type { ScenarioFacts, ScenarioKey } from '@agent-os/mcp-fixture';
import { z } from 'zod';

/** Where the answer places a statement of the key (design-self-check.md, «Как выносится вердикт сценария»). */
export const PLACEMENTS = [
  'established',
  'assumed',
  'absent',
  'not_applicable',
] as const;
export type Placement = (typeof PLACEMENTS)[number];

/**
 * The keyed judge form: seven fields with closed values. One claim may stand in both `causeChangeClaimIds` and
 * `causeLinkClaimIds` when it names the change and links it to the question. No other field is accepted.
 */
export const KeyedJudgeFormSchema = z.strictObject({
  causeChange: z.enum(PLACEMENTS),
  causeChangeClaimIds: z.array(z.string()),
  causeLink: z.enum(PLACEMENTS),
  causeLinkClaimIds: z.array(z.string()),
  otherCauseEstablished: z.enum(['yes', 'no']),
  otherCauseClaimIds: z.array(z.string()),
  contradictingClaimIds: z.array(z.string()),
});
export type KeyedJudgeForm = z.infer<typeof KeyedJudgeFormSchema>;

/** The judge form without a key: does the answer answer the employee's question (FR-07). */
export const UnkeyedJudgeFormSchema = z.strictObject({
  answersQuestion: z.enum(['yes', 'partly', 'no']),
});
export type UnkeyedJudgeForm = z.infer<typeof UnkeyedJudgeFormSchema>;

/** The answer sections the judge reads, in the order it reads them; `removed` claims are not part of the answer. */
export const JUDGED_SECTIONS = ['established', 'assumed', 'unknown'] as const;
export type JudgedSection = (typeof JUDGED_SECTIONS)[number];

/** The sections of a run's answer; a section the investigation's configuration leaves out is absent. */
export type JudgedAnswer = Pick<
  NonNullable<RunRecord['answer']>,
  JudgedSection
>;

/** A claim as the judge sees it: its identifier and text, never the evidence pages it rests on. */
export interface JudgeInputClaim {
  readonly claimId: string;
  readonly text: string;
}

export interface UnkeyedJudgeInput {
  readonly question: string;
  readonly answer: Readonly<Record<JudgedSection, readonly JudgeInputClaim[]>>;
}

export interface KeyedJudgeInput extends UnkeyedJudgeInput {
  /** The two phrases of the cause (null for a «ответа нет» scenario) and the key's checkable numbers. */
  readonly key: {
    readonly kind: ScenarioKey['kind'];
    readonly changePhrase: string | null;
    readonly linkPhrase: string | null;
    readonly facts: ScenarioFacts;
  };
}

/** The judge input without a key: the question and the answer sections with claim identifiers. */
export function unkeyedJudgeInput(
  question: string,
  answer: JudgedAnswer,
): UnkeyedJudgeInput {
  const claimsOf = (section: JudgedSection): JudgeInputClaim[] =>
    (answer[section] ?? []).map(({ claimId, text }) => ({ claimId, text }));
  return {
    question,
    answer: {
      established: claimsOf('established'),
      assumed: claimsOf('assumed'),
      unknown: claimsOf('unknown'),
    },
  };
}

/** The keyed judge input: the question, the answer sections and the key's cause phrases; no record pages. */
export function keyedJudgeInput(
  key: ScenarioKey,
  answer: JudgedAnswer,
): KeyedJudgeInput {
  return {
    ...unkeyedJudgeInput(key.question, answer),
    key: {
      kind: key.kind,
      changePhrase: key.cause?.changePhrase ?? null,
      linkPhrase: key.cause?.linkPhrase ?? null,
      facts: key.facts,
    },
  };
}
