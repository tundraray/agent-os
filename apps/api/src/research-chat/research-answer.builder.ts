import {
  type ResearchAnswerClaim,
  type ResearchAnswerMetadata,
  ResearchAnswerMetadataSchema,
  type ResearchAnswerSource,
} from '@agent-os/contracts';
import type { InvestigationView } from '@agent-os/engine';

/** The record of one cited evidence the answer lists: provenance and `coverage.truncated` from `EvidenceReader.get`. */
export type AnswerSourceRecord = Omit<ResearchAnswerSource, 'number'>;

/** The launch the answer belongs to, as its row stores it. */
interface AnswerLaunch {
  readonly launchKey: string;
  readonly goal: string;
  readonly launch: ResearchAnswerMetadata['launch'];
}

interface BuildResearchAnswerInput {
  /** A completed investigation: its `answer` is set. */
  readonly view: InvestigationView;
  readonly launch: AnswerLaunch;
  /** Records of every id `citedEvidenceIds(view)` returns; others are ignored. */
  readonly evidence: ReadonlyMap<string, AnswerSourceRecord>;
}

/** The answer message: the Markdown text the model and «Копировать» get, and its structure for the web (KD-5). */
interface ResearchAnswerMessage {
  /** `research-answer-<investigationId>`: a retried write overwrites the same message (KD-4, invariant 4). */
  readonly id: string;
  readonly text: string;
  readonly researchAnswer: ResearchAnswerMetadata;
}

type AnswerView = NonNullable<InvestigationView['answer']>;
type AnswerClaim = NonNullable<AnswerView['established']>[number];

const GROUPS = ['established', 'assumed', 'unknown'] as const;
type Group = (typeof GROUPS)[number];

/** Texts of deep-research UXRD, Content and Microcopy. */
const MC_23_HEADER = 'Ответ ресерча';
const MC_24_OUTCOME: Record<AnswerView['outcome'], string> = {
  answered: 'Есть ответ',
  partial: 'Частичный ответ',
  inconclusive: 'Вывода нет',
};
const MC_25_STOP_REASON: Record<
  NonNullable<AnswerView['stopReason']>,
  string
> = {
  budget_exhausted: 'Остановлен: исчерпан бюджет',
  step_limit: 'Остановлен: достигнут лимит шагов',
  controller_invalid: 'Остановлен: агент не смог выбрать следующий шаг',
  model_unavailable: 'Остановлен: модель недоступна',
  deadline: 'Остановлен: истёк срок расследования',
  context_overflow: 'Остановлен: материала больше, чем агент может учесть',
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
const MC_34_SUMMARY_BASIS = 'Краткий пересказ — основания в утверждениях ниже';

/**
 * Evidence the answer cites, in the order of first appearance: groups `established`, `assumed`, `unknown`, claims in
 * their order, each claim's evidence in its order. Empty without sources — the loop reads no evidence then (KD-8).
 */
export function citedEvidenceIds(view: InvestigationView): string[] {
  if (view.sourceMode === 'model_knowledge') return [];
  const answer = completedAnswer(view);
  const ids = GROUPS.flatMap((group) =>
    claimsOf(answer, group).flatMap((claim) => claim.evidenceIds),
  );
  return [...new Set(ids)];
}

/**
 * Builds the answer message of a completed investigation (design-chat-entry.md, KD-5, KD-8, DC-9). Footnote numbers
 * follow the first appearance of a source; the `removed` section stays out. The synthesis's summary follows the
 * header and goal as its own paragraph, then MC-34 as the next one (DC-10, KD-11). A summary with no claim in
 * `established`, `assumed` or `unknown` retells nothing, so it is dropped: `summary` is null and neither paragraph
 * appears. Without sources the text opens with MC-32 and marks each claim with MC-33 instead of footnotes, and lists
 * no sources.
 */
export function buildResearchAnswer({
  view,
  launch,
  evidence,
}: BuildResearchAnswerInput): ResearchAnswerMessage {
  const answer = completedAnswer(view);
  const cited = citedEvidenceIds(view);
  const numberOf = new Map(
    cited.map((evidenceId, index) => [evidenceId, index + 1]),
  );
  const sources = cited.map((evidenceId, index) => ({
    number: index + 1,
    ...recordOf(evidence, evidenceId),
  }));
  const toClaim = (claim: AnswerClaim): ResearchAnswerClaim => ({
    text: claim.text,
    footnotes: [...new Set(claim.evidenceIds)].flatMap(
      (evidenceId) => numberOf.get(evidenceId) ?? [],
    ),
    verified: claim.verified,
  });
  const established = claimsOf(answer, 'established').map(toClaim);
  const assumed = claimsOf(answer, 'assumed').map(toClaim);
  const unknown = claimsOf(answer, 'unknown').map(toClaim);
  const hasClaims = established.length + assumed.length + unknown.length > 0;
  const researchAnswer = ResearchAnswerMetadataSchema.parse({
    launchKey: launch.launchKey,
    goal: launch.goal,
    summary: hasClaims ? (answer.summary ?? null) : null,
    outcome: answer.outcome,
    stopReason: answer.stopReason,
    launch: launch.launch,
    established,
    assumed,
    unknown,
    sources,
    sourceMode: view.sourceMode,
  });
  return {
    id: `research-answer-${view.investigationId}`,
    text: answerText(researchAnswer),
    researchAnswer,
  };
}

function answerText(answer: ResearchAnswerMetadata): string {
  const withoutSources = answer.sourceMode === 'model_knowledge';
  const header = [
    `**${MC_23_HEADER}** · ${MC_24_OUTCOME[answer.outcome]}`,
    `Цель: ${answer.goal}`,
    ...(answer.stopReason === null
      ? []
      : [MC_25_STOP_REASON[answer.stopReason]]),
  ].join('\n');
  const claimLine = (claim: ResearchAnswerClaim): string => {
    if (withoutSources) return `- ${claim.text} (${MC_33_MODEL_KNOWLEDGE})`;
    const footnotes = claim.footnotes.map((number) => `[${number}]`).join('');
    const cites = footnotes === '' ? '' : ` ${footnotes}`;
    return `- ${claim.text}${cites}${claim.verified ? '' : ` (${MC_27_UNVERIFIED})`}`;
  };
  const groups = GROUPS.filter((group) => answer[group].length > 0).map(
    (group) =>
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
  return [
    ...(withoutSources ? [MC_32_WITHOUT_SOURCES] : []),
    header,
    ...(answer.summary === null ? [] : [answer.summary, MC_34_SUMMARY_BASIS]),
    ...groups,
    ...sourceList,
  ].join('\n\n');
}

function completedAnswer(view: InvestigationView): AnswerView {
  if (view.answer === null) {
    throw new Error(
      `Investigation ${view.investigationId} has no answer to deliver`,
    );
  }
  return view.answer;
}

function claimsOf(answer: AnswerView, group: Group): readonly AnswerClaim[] {
  return answer[group] ?? [];
}

function recordOf(
  evidence: ReadonlyMap<string, AnswerSourceRecord>,
  evidenceId: string,
): AnswerSourceRecord {
  const record = evidence.get(evidenceId);
  if (record === undefined) {
    throw new Error(`Evidence ${evidenceId} cited by the answer was not read`);
  }
  const { sourceId, toolName, snapshot, truncated } = record;
  return { sourceId, toolName, snapshot, truncated };
}
