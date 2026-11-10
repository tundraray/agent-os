import type {
  AgentTree,
  AgentTreeRun,
  RunRecord,
  Transcript,
  TranscriptRetention,
} from '@agent-os/engine';
import { SIGNAL_LABELS } from '../result/report.js';
import {
  DISCARDED_STATUSES,
  type FailureSignals,
  rejectedCalls,
  unverifiedByRefusal,
} from '../signals.js';

/**
 * The report of the `show` command (design-self-check.md, Flow 4, Contract `show`, DC-15): the four failure signals,
 * every model call of the investigation by time with its transcript, its agent tree, the refused calls, the claims left
 * unverified by a refusal (design-research-flow.md, «Самопроверка на v3», AC-18.3) and the discarded claims. It is printed for the developer who opened it and never saved; it is the only output of the
 * program that may carry prompts, records and model answers.
 */

export interface CourseReportInput {
  readonly record: RunRecord;
  /** The investigation's transcripts in call order, those past the retention term left out. */
  readonly transcripts: readonly Transcript[];
  readonly retention: TranscriptRetention;
  readonly signals: FailureSignals;
  /** `self-check:show:<investigationId>:<uuid>`: the judge transcript of this report is bound to it. */
  readonly showRunId: string;
}

const NONE = '—';
const MARK = (fired: boolean): string => (fired ? 'сработал' : 'не сработал');

export function renderCourseReport(input: CourseReportInput): string {
  const { record } = input;
  return [
    `# Ход расследования ${record.investigationId}`,
    '',
    `- Владелец: ${record.ownerId}`,
    `- Статус: ${record.status}`,
    `- Вопрос: ${record.query}`,
    `- Конфигурация: ${record.config.fingerprint}`,
    `- Исход ответа: ${record.answer?.outcome ?? NONE}; stopReason: ${record.answer?.stopReason ?? NONE}`,
    `- Срок хранения транскриптов: ${retentionLabel(input.retention)}`,
    `- Запуск show: ${input.showRunId}`,
    '',
    '## Сигналы сбоя',
    '',
    ...signalLines(input.signals),
    '',
    '## Вызовы модели по времени',
    '',
    ...callSections(record, input.transcripts),
    ...agentSections(record, record.agentTree),
    '## Отсеянные утверждения',
    '',
    ...discardedClaimLines(record),
    '',
  ].join('\n');
}

function retentionLabel(retention: TranscriptRetention): string {
  return retention === 'no_term' ? 'без срока' : `${retention.days} дн.`;
}

function signalLines(signals: FailureSignals): string[] {
  const { lowJudgeScore, discardedClaims, stopReason } = signals;
  const judge =
    lowJudgeScore === null
      ? 'не ставится: ответа нет, судья не вызывался'
      : lowJudgeScore.judgeInvalid
        ? `${MARK(lowJudgeScore.fired)}; judge_invalid`
        : `${MARK(lowJudgeScore.fired)}; answersQuestion: ${lowJudgeScore.answersQuestion ?? NONE}`;
  const share =
    discardedClaims.share === null ? NONE : discardedClaims.share.toFixed(2);
  return [
    `- ${SIGNAL_LABELS.lowJudgeScore}: ${judge}`,
    `- ${SIGNAL_LABELS.discardedClaims}: ${MARK(discardedClaims.fired)}; ${discardedClaims.discarded} из ${discardedClaims.total}, доля ${share}`,
    `- ${SIGNAL_LABELS.rejectedCalls}: ${MARK(signals.rejectedCalls.fired)}; отклонено ${signals.rejectedCalls.rejected}`,
    `- ${SIGNAL_LABELS.stopReason}: ${MARK(stopReason.fired)}; ${stopReason.stopReason ?? NONE}`,
  ];
}

/** One model call: its transcript when it is kept, otherwise the ledger row alone. */
interface CallEntry {
  readonly callId: string;
  readonly createdAt: Date;
  readonly ledger: RunRecord['calls'][number] | null;
  readonly transcript: Transcript | null;
}

/**
 * The ledger rows and the transcripts joined by call id, by time then by id: a call whose transcript is past the term
 * still shows its ledger row, and a judge call bound to the investigation has a transcript without a ledger row.
 */
function callEntries(
  record: RunRecord,
  transcripts: readonly Transcript[],
): CallEntry[] {
  const byId = new Map<string, CallEntry>();
  for (const ledger of record.calls) {
    byId.set(ledger.callId, {
      callId: ledger.callId,
      createdAt: ledger.createdAt,
      ledger,
      transcript: null,
    });
  }
  for (const transcript of transcripts) {
    const known = byId.get(transcript.callId);
    byId.set(transcript.callId, {
      callId: transcript.callId,
      createdAt: known?.createdAt ?? transcript.createdAt,
      ledger: known?.ledger ?? null,
      transcript,
    });
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.callId.localeCompare(right.callId),
  );
}

function callSections(
  record: RunRecord,
  transcripts: readonly Transcript[],
): string[] {
  const entries = callEntries(record, transcripts);
  if (entries.length === 0) return [NONE, ''];
  return entries.flatMap((entry, index) => callSection(entry, index + 1));
}

function callSection(entry: CallEntry, position: number): string[] {
  const { ledger, transcript } = entry;
  const role = transcript?.role ?? ledger?.role ?? NONE;
  const model = transcript?.model ?? ledger?.model ?? NONE;
  const header = [
    `### ${position}. ${role} · ${model} · ${entry.createdAt.toISOString()}`,
    '',
    `- callId: ${entry.callId}`,
    `- Запись журнала: ${ledger === null ? NONE : ledger.status}`,
  ];
  if (transcript === null) {
    return [
      ...header,
      '- Транскрипт: нет (старше срока хранения или не записан)',
      '',
    ];
  }
  const usage = transcript.usage;
  return [
    ...header,
    `- Задача: ${transcript.taskId ?? NONE}; попытка: ${transcript.attempt ?? NONE}`,
    `- Версия промпта: ${transcript.promptVersion}`,
    `- Исход: ${transcript.outcome}; закрыт: ${transcript.closedAt?.toISOString() ?? NONE}`,
    `- Расход: ${
      usage === null
        ? NONE
        : `вход ${usage.inputTokens} (кэш: прочитано ${usage.cacheReadTokens}, записано ${usage.cacheWriteTokens}), выход ${usage.outputTokens}, ${usage.costUsd} USD`
    }`,
    '',
    'Вход:',
    '',
    ...jsonBlock(transcript.input),
    'Ответ:',
    '',
    ...jsonBlock(transcript.response),
  ];
}

function jsonBlock(value: unknown): string[] {
  return [
    '```json',
    value === null || value === undefined
      ? 'null'
      : JSON.stringify(value, null, 2),
    '```',
    '',
  ];
}

function agentSections(record: RunRecord, tree: AgentTree): string[] {
  const refused = rejectedCalls(tree).map(
    ({ agent, tool, reason }) => `- ${agent} · ${tool}: ${reason ?? NONE}`,
  );
  const unverified = unverifiedByRefusal({
    claims: record.claims,
    agentTree: tree,
    processConfig: record.config.processConfig,
  }).map(({ claimId, text }) => `- ${claimId}: ${text}`);
  return [
    '## Дерево агентов',
    '',
    ...tree.runs.flatMap(agentRunSection),
    '## Отклонённые вызовы',
    '',
    ...(refused.length === 0 ? [NONE] : refused),
    '',
    '## Утверждения без проверки из-за отказа',
    '',
    ...(unverified.length === 0 ? [NONE] : unverified),
    '',
  ];
}

/** One run of the tree; its transcripts stand under their call ids in «Вызовы модели по времени». */
function agentRunSection(run: AgentTreeRun): string[] {
  const parent =
    run.parent === null
      ? 'корень'
      : `родитель ${run.parent.taskId}, вызов ${run.parent.callIndex}`;
  const ending =
    run.failure === null
      ? `Результат: ${JSON.stringify(run.result)}`
      : `Причина сбоя: ${JSON.stringify(run.failure)}`;
  return [
    `### ${run.agentName} · ${run.runTaskId}`,
    '',
    `- ${parent}; глубина ${run.depth}; статус ${run.status}`,
    `- Задание: ${run.assignment ?? run.prologueFirstMessage ?? NONE}`,
    `- ${ending}`,
    `- Расход: доля ${run.shareTokens}, потрачено ${run.spentTokens}, с поддеревом ${run.subtreeSpentTokens}`,
    `- Транскрипты ходов: ${
      run.turns.length === 0
        ? NONE
        : run.turns
            .map(({ turn, llmCallId, transcriptCallId }) =>
              transcriptCallId === null
                ? `ход ${turn}: ${llmCallId} (транскрипт удалён)`
                : `ход ${turn}: ${llmCallId}`,
            )
            .join(', ')
    }`,
    '',
  ];
}

/** By the same statuses as the signal «много отсеянных утверждений», then the claims the answer gateway removed. */
function discardedClaimLines(record: RunRecord): string[] {
  const checked = record.claims
    .filter((claim) => DISCARDED_STATUSES.has(claim.status))
    .map((claim) => `- ${claim.claimId} · ${claim.status}: ${claim.text}`);
  const removed = (record.answer?.removed ?? []).map(
    (claim) =>
      `- ${claim.claimId} · снято ответом (${claim.reason}): ${claim.text}`,
  );
  const lines = [...checked, ...removed];
  return lines.length === 0 ? [NONE] : lines;
}
