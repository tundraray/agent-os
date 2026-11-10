import {
  type ResearchAnswerBody,
  ResearchAnswerBodySchema,
  type ResearchAnswerClaim,
  type ResearchAnswerConfidence,
  type ResearchAnswerSource,
} from '@agent-os/contracts';
import type { z } from 'zod';
import type { SourceMode } from '../config/source-check.js';
import type { InvestigationAnswerSchema } from './code-answer.js';

/** What the answer message says about one page the answer cites: `provenance` and `coverage.truncated` of its evidence. */
export type AnswerPage = Omit<ResearchAnswerSource, 'number'>;

/**
 * A stored answer as any version of the engine wrote it, or as `InvestigationView.answer` shows it: the fields added by
 * agent-quality may be absent (an answer written before it), and so may a section its configuration leaves out.
 */
type StoredAnswer = z.input<typeof InvestigationAnswerSchema>;
export type AnswerToBuild = Pick<StoredAnswer, 'outcome' | 'stopReason'> &
  Partial<Pick<StoredAnswer, 'summaryItems' | 'established' | 'assumed' | 'unknown'>>;

export interface BuildResearchAnswerInput {
  readonly answer: AnswerToBuild;
  /** The investigation's question. */
  readonly goal: string;
  readonly launchKey: string;
  /** The mode recorded at the investigation's start (DC-16). */
  readonly sourceMode: SourceMode;
  /** Details of every page {@link citedEvidenceIds} returns; other entries are ignored. */
  readonly pages: ReadonlyMap<string, AnswerPage>;
}

/**
 * The answer message (design-engine.md, KD-8): the Markdown text the chat model reads and «Копировать» copies, and the
 * `researchAnswer` metadata without `launch`, which the chat server adds.
 */
export interface AnswerMessage {
  readonly text: string;
  readonly metadata: ResearchAnswerBody;
}

const GROUPS = ['established', 'assumed', 'unknown'] as const;
type Group = (typeof GROUPS)[number];
type AnswerClaim = NonNullable<AnswerToBuild[Group]>[number];

/** Texts of deep-research UXRD, Content and Microcopy. */
const MC_23_HEADER = 'Ответ ресерча';
const MC_24_OUTCOME: Record<AnswerToBuild['outcome'], string> = {
  answered: 'Есть ответ',
  partial: 'Частичный ответ',
  inconclusive: 'Вывода нет',
};
const MC_25_STOP_REASON: Record<NonNullable<AnswerToBuild['stopReason']>, string> = {
  budget_exhausted: 'Остановлен: исчерпан бюджет',
  step_limit: 'Остановлен: достигнут лимит шагов',
  controller_invalid: 'Остановлен: агент не смог выбрать следующий шаг',
  model_unavailable: 'Остановлен: модель недоступна',
  deadline: 'Остановлен: истёк срок расследования',
  context_overflow: 'Остановлен: материала больше, чем агент может учесть',
  plan_sources_rejected: 'Остановлен: план не прошёл проверку источников',
};
const MC_26_GROUP: Record<Group, string> = {
  established: 'Установлено',
  assumed: 'Предположения',
  unknown: 'Не выяснено',
};
const MC_27_UNVERIFIED = 'не проверено';
const MC_28_TRUNCATED = 'данные усечены';
const MC_32_WITHOUT_SOURCES =
  'Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.';
const MC_33_MODEL_KNOWLEDGE = 'из знаний модели, без источника';

/** Texts of agent-quality UXRD, Microcopy: the group words, the summary caption and the causal label. */
const MC_1_CONFIDENCE: Record<ResearchAnswerConfidence, string> = {
  very_high: 'уверенность очень высокая',
  high: 'уверенность высокая',
  medium: 'уверенность средняя',
  low: 'уверенность низкая',
};
const MC_2_SUMMARY_CAPTION = 'Главное из установленного';
const MC_3_CAUSAL = 'причинная связь не доказана';

/**
 * Pages the answer cites, in the order of first appearance: groups `established`, `assumed`, `unknown`, claims in their
 * order, each claim's pages in their order. Empty without sources: the answer cites nothing then (DC-13).
 */
export function citedEvidenceIds(answer: AnswerToBuild, sourceMode: SourceMode): string[] {
  if (sourceMode === 'model_knowledge') return [];
  const ids = GROUPS.flatMap((group) => claimsOf(answer, group).flatMap((claim) => claim.evidenceIds));
  return [...new Set(ids)];
}

/**
 * Builds the answer message from one answer (design-engine.md, «Как строится сообщение ответа», invariant 9): the text
 * and the metadata carry the same sections, summary items, groups and labels. Footnote numbers follow the first
 * appearance of a page; the `removed` section stays out. The summary is the caption MC-2 and the summary items with
 * their group words MC-1, and nothing at all without items; an established claim carries its group words after its
 * footnotes, a causal one the label MC-3, an unverified one «не проверено». The summary string of an answer written
 * before agent-quality is never shown, and `summary` is null (UXRD KD-7): such an answer has no items, groups or causal
 * flags, so its message has none of the new texts either. Without sources the text opens with MC-32 and marks each
 * claim with MC-33 instead of footnotes. A cited page without details is an error, never a dropped footnote.
 */
export function buildResearchAnswer({ answer, goal, launchKey, sourceMode, pages }: BuildResearchAnswerInput): AnswerMessage {
  const cited = citedEvidenceIds(answer, sourceMode);
  const numberOf = new Map(cited.map((evidenceId, index) => [evidenceId, index + 1]));
  const sources = cited.map((evidenceId, index) => ({ number: index + 1, ...pageOf(pages, evidenceId) }));
  const toClaim = (claim: AnswerClaim): ResearchAnswerClaim => ({
    text: claim.text,
    footnotes: [...new Set(claim.evidenceIds)].flatMap((evidenceId) => numberOf.get(evidenceId) ?? []),
    verified: claim.verified,
    confidence: ('confidence' in claim ? claim.confidence : null) ?? null,
    causal: ('causal' in claim ? claim.causal : false) ?? false,
  });
  const metadata = ResearchAnswerBodySchema.parse({
    launchKey,
    goal,
    summary: null,
    summaryItems: (answer.summaryItems ?? []).map(({ claimId, text, confidence }) => ({ claimId, text, confidence })),
    outcome: answer.outcome,
    stopReason: answer.stopReason,
    established: claimsOf(answer, 'established').map(toClaim),
    assumed: claimsOf(answer, 'assumed').map(toClaim),
    unknown: claimsOf(answer, 'unknown').map(toClaim),
    sources,
    sourceMode,
  });
  return { text: answerText(metadata), metadata };
}

function answerText(answer: ResearchAnswerBody): string {
  const withoutSources = answer.sourceMode === 'model_knowledge';
  const header = [
    `**${MC_23_HEADER}** · ${MC_24_OUTCOME[answer.outcome]}`,
    `Цель: ${answer.goal}`,
    ...(answer.stopReason === null ? [] : [MC_25_STOP_REASON[answer.stopReason]]),
  ].join('\n');
  const summary =
    answer.summaryItems.length === 0
      ? []
      : [
          [
            `### ${MC_2_SUMMARY_CAPTION}`,
            ...answer.summaryItems.map((item) => `- ${markdownLine(item.text)} (${MC_1_CONFIDENCE[item.confidence]})`),
          ].join('\n'),
        ];
  const claimLine = (claim: ResearchAnswerClaim): string => {
    const text = markdownLine(claim.text);
    if (withoutSources) return `- ${text} (${MC_33_MODEL_KNOWLEDGE})`;
    const footnotes = claim.footnotes.map((number) => `[${number}]`).join('');
    return `- ${text}${footnotes === '' ? '' : ` ${footnotes}`}${claimLabels(claim)}`;
  };
  const groups = GROUPS.filter((group) => answer[group].length > 0).map((group) =>
    [`### ${MC_26_GROUP[group]}`, ...answer[group].map(claimLine)].join('\n'),
  );
  const sourceList =
    answer.sources.length === 0
      ? []
      : [
          [
            `### Источники (${answer.sources.length})`,
            ...answer.sources.map(
              (source) =>
                `${source.number}. ${source.sourceId} · ${source.toolName} · ${source.snapshot}` +
                (source.truncated ? ` · ${MC_28_TRUNCATED}` : ''),
            ),
          ].join('\n'),
        ];
  return [...(withoutSources ? [MC_32_WITHOUT_SOURCES] : []), header, ...summary, ...groups, ...sourceList].join('\n\n');
}

/**
 * A claim or summary-item text as one plain line of the list it stands in. The text comes from the investigation (a
 * worker or synthesis wrote it), so it must not fake the message's own structure: line breaks and other control
 * characters become one space, a leading block marker (`#`, `-`, `*`, `+`, `>`, a number with `.` or `)`) is escaped,
 * and so are a footnote-like `[n]`, an image `![` and a link `](`. Formatting only: the metadata keeps the text as
 * stored, and web shows it as text.
 */
function markdownLine(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim()
    .replace(/^([#>*+-])/, '\\$1')
    .replace(/^(\d+)([.)])/, '$1\\$2')
    .replace(/\[(\d+)\]/g, '\\[$1]')
    .replace(/!\[/g, '!\\[')
    .replace(/\]\(/g, '\\](');
}

/** The labels after a claim's footnotes: its group words, the causal label, «не проверено» — from its fields only. */
function claimLabels(claim: ResearchAnswerClaim): string {
  const labels = [
    ...(claim.confidence === null ? [] : [MC_1_CONFIDENCE[claim.confidence]]),
    ...(claim.causal ? [MC_3_CAUSAL] : []),
    ...(claim.verified ? [] : [MC_27_UNVERIFIED]),
  ];
  return labels.map((label) => ` (${label})`).join('');
}

function claimsOf(answer: AnswerToBuild, group: Group): readonly AnswerClaim[] {
  return answer[group] ?? [];
}

function pageOf(pages: ReadonlyMap<string, AnswerPage>, evidenceId: string): AnswerPage {
  const page = pages.get(evidenceId);
  if (page === undefined) {
    throw new Error(`page ${evidenceId} cited by the answer has no details`);
  }
  const { sourceId, toolName, snapshot, truncated } = page;
  return { sourceId, toolName, snapshot, truncated };
}
