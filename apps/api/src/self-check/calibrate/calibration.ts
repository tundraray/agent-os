import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type AssessAgentRequest,
  type AssessAgentResult,
  type AssessUsage,
  type Atom,
  type AtomCheck,
  checkAtoms,
  ClaimAssessmentSchema,
  type ClaimAssessmentAgent,
  type ClaimAssessmentPrologueInput,
  type ClaimCheckPage,
  type ClaimProfile,
  decideClaim,
  definitionMemoryFingerprint,
  type GroupTable,
  GroupTableSchema,
  pointerOverAll,
} from '@agent-os/engine';
import type {
  CalibrationPair,
  CalibrationPairSet,
} from '@agent-os/mcp-fixture';
import type { Clock } from '@agent-os/runtime';
import { z } from 'zod';

/**
 * Calibration of the checker agent (design-research-flow.md, «Калибровка проверяющего агента», Flow 4; design-engine.md,
 * KD-3, «Как калибровка ставит таблицу групп»): each pair goes through the checker agent's turns by `Engine.assessAgent`
 * on the prologue input built from the pair's records, then `decideClaim` over a pointer to all those records, and is
 * compared with its key by enums only (support, type, established or not); no text of the claim, the records or the
 * answer is read. The established pairs' profiles are ranked by the lower bound of the 90 % Wilson interval of their
 * share correct and cut into 3 or 4 consecutive groups of about equal established pairs, a profile never split (plan
 * Notes 1, decision 1). The table is keyed by the agent's two fingerprints.
 */

export type GroupCount = 3 | 4;
type GroupName = GroupTable['groups'][number]['group'];

/** Group names from the top, by the number of groups; `very_high` exists only with four. */
const GROUP_NAMES: Readonly<Record<GroupCount, readonly GroupName[]>> = {
  3: ['high', 'medium', 'low'],
  4: ['very_high', 'high', 'medium', 'low'],
};

/** z of the two-sided 90 % interval (plan Notes 1, decision 1). */
const WILSON_Z = 1.645;
/** How long after it is asked a verifier call of calibration or of the influence measure may still start. */
const CALL_WINDOW_MS = 10 * 60_000;
/** Group sizes closer than this are equal: their targets are fractions. */
const SIZE_EPSILON = 1e-9;

/** What calibration is given besides its call. */
interface CalibrationRun {
  readonly pairSet: CalibrationPairSet;
  readonly scenarioSet: string;
  readonly groupCount: GroupCount;
  /** `self-check:run:<runId>` of this calibration: every call's transcript is bound to it. */
  readonly selfCheckRunId: string;
  readonly clock: Clock;
}

/** What one `Engine.assessAgent` of the checker agent needs, in calibration and in the influence measure. */
export interface CheckerAgentCall {
  /** The agents-form configuration as data, for `Engine.assessAgent`. */
  readonly config: unknown;
  /** The configuration's checker agent. */
  readonly agent: ClaimAssessmentAgent;
  /** The agent's current `deployment` entries: the turns run with them and the table is keyed by them. */
  readonly deploymentEntries: AssessAgentRequest['deploymentEntries'];
  readonly assessAgent: (
    request: AssessAgentRequest,
  ) => Promise<AssessAgentResult>;
  /** `self-check:run:<runId>`: every call's transcript is bound to it. */
  readonly selfCheckRunId: string;
  readonly clock: Clock;
}

export type AgentCalibrationInput = CalibrationRun & CheckerAgentCall;

/**
 * A pair the call could not judge: the provider was unavailable, the answer was not in form (DC-7), the packet was over
 * the prologue's limit (`needs_narrowing`), or the agent's call failed with its code (Flow 4).
 */
type PairFailure =
  | 'invalid_assessment'
  | 'needs_narrowing'
  | Extract<AssessAgentResult, { outcome: 'failed' }>['code'];

/** One pair compared with its key. */
export interface PairOutcome {
  readonly pairId: string;
  readonly pairKind: string;
  readonly failure: PairFailure | null;
  readonly supportMatch: boolean;
  readonly typeMatch: boolean;
  /** The key: records support it and it is not causal — the engine's rule, in which the values do not decide. */
  readonly shouldBeEstablished: boolean;
  /** `decideClaim` gave `supported`. */
  readonly established: boolean;
  /** The algorithm's decision matches the key; a failed pair is never right. */
  readonly decisionCorrect: boolean;
  /**
   * The old veto «value check `unmatched` — not established» over the same decision matches the key (AC-13.2); a
   * failed pair is never right. Shown in the report only, never written to the table.
   */
  readonly vetoCorrect: boolean;
  /** Set only for an established pair. */
  readonly profile: ClaimProfile | null;
}

/** A profile of established pairs in the ranked row. */
export interface RankedProfile {
  readonly profile: ClaimProfile;
  readonly pairs: number;
  readonly correct: number;
  readonly lowerBound: number;
  readonly group: GroupName;
}

/** A group of the report: the table's line plus the H-03 check against the next non-empty group below. */
export interface GroupLine {
  readonly group: GroupName;
  readonly establishedPairs: number;
  readonly correctShare: number;
  readonly notMoreAccurateThanBelow: boolean;
}

export interface CalibrationReport {
  readonly table: GroupTable;
  readonly pairs: readonly PairOutcome[];
  readonly ranked: readonly RankedProfile[];
  readonly groups: readonly GroupLine[];
  readonly usage: AssessUsage;
}

export type CalibrationResult =
  | { readonly ok: true; readonly report: CalibrationReport }
  | {
      readonly ok: false;
      /** `calibration_empty`, or the code of a call rejected by the engine: a defect of the build (Flow 4). */
      readonly code:
        | 'calibration_empty'
        | Extract<AssessAgentResult, { outcome: 'rejected' }>['code'];
      readonly reason: string;
    };

interface JudgedPair {
  readonly outcome: PairOutcome;
  readonly usage: AssessUsage;
}

/** What identifies the calibrated checker in the table: its model and the agent's two fingerprints. */
type TableKey = Pick<
  GroupTable,
  'model' | 'agentFingerprint' | 'definitionMemoryFingerprint'
>;

/**
 * One `Engine.assessAgent` per pair, in pair order, then the table; no established pair refuses with `calibration_empty`.
 * A pair that fails is listed and the next is judged; a rejected call ends the calibration with its code.
 */
export async function calibrateAgent(
  input: AgentCalibrationInput,
): Promise<CalibrationResult> {
  const memoryFingerprint = deploymentMemoryFingerprint(
    input.deploymentEntries,
  );
  const judged: JudgedPair[] = [];
  for (const pair of input.pairSet.pairs) {
    const called = await judgeAgentPair(input, pair, memoryFingerprint);
    if ('rejected' in called) {
      return {
        ok: false,
        code: called.rejected,
        reason: `Engine.assessAgent rejected agent ${input.agent.agentName} on pair ${pair.pairId}: ${called.rejected}`,
      };
    }
    judged.push(called);
  }
  return tableOf(input, judged, {
    model: input.agent.model,
    agentFingerprint: input.agent.agentFingerprint,
    definitionMemoryFingerprint: memoryFingerprint,
  });
}

/** The fingerprint of the checker's `deployment` entries, as the prologue input and the table name it. */
export function deploymentMemoryFingerprint(
  entries: CheckerAgentCall['deploymentEntries'],
): string {
  return definitionMemoryFingerprint(
    entries.map((entry) => ({ ...entry, scope: 'deployment' as const })),
  );
}

function tableOf(
  input: CalibrationRun,
  judged: readonly JudgedPair[],
  key: TableKey,
): CalibrationResult {
  const pairs = judged.map((item) => item.outcome);
  const usage = judged.reduce<AssessUsage>(
    (total, item) => addUsage(total, item.usage),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
  );
  const established = pairs.filter((pair) => pair.profile !== null);
  if (established.length === 0) {
    return {
      ok: false,
      code: 'calibration_empty',
      reason: `no pair of ${pairs.length} was established; the table is not written`,
    };
  }
  const ranked = rankProfiles(established, input.groupCount);
  const groups = groupLines(ranked, input.groupCount);
  const table = GroupTableSchema.parse({
    ...key,
    scenarioSet: input.scenarioSet,
    pairsFingerprint: input.pairSet.fingerprint,
    calibratedAt: input.clock.now().toISOString(),
    groupCount: input.groupCount,
    profiles: ranked.map(({ profile, group }) => ({ profile, group })),
    groups: groups.map(({ group, establishedPairs, correctShare }) => ({
      group,
      establishedPairs,
      correctShare,
    })),
    pairKinds: pairKindShares(pairs),
  });
  return { ok: true, report: { table, pairs, ranked, groups, usage } };
}

/**
 * `checkAtoms` over every record of the pages, numbered across the pages in order as `buildClaimCheck` and
 * `pointerOverAll` number them.
 */
export function atomCheckOf(
  atoms: readonly Atom[],
  pages: readonly ClaimCheckPage[],
): AtomCheck {
  return checkAtoms({
    atoms,
    records: pages.flatMap((page) => page.records),
  });
}

/** The answer an accepted `finish` carries under `Engine.assessAgent`; the decision is taken from it. */
export const FinishedResultSchema = z.object({
  assessment: ClaimAssessmentSchema,
});

/** The prologue's input from the pair's records, of the kind `collect` reads in an investigation (AC-16.3). */
function prologueInputOf(
  pair: CalibrationPair,
  fingerprints: Pick<
    ClaimAssessmentPrologueInput,
    'agentFingerprint' | 'definitionMemoryFingerprint'
  >,
): ClaimAssessmentPrologueInput {
  return {
    kind: 'claim',
    claimId: pair.pairId,
    text: pair.claimText,
    atoms: pair.claimAtoms,
    pages: pair.pages.map((page, index) => ({
      pageId: `${pair.pairId}/page-${index}`,
      source: page.source,
      tool: page.tool,
      args: page.args,
      snapshot: page.snapshot,
      complete: page.complete,
      records: page.records,
    })),
    ...fingerprints,
  };
}

/** One `Engine.assessAgent` of the checker agent over the pair's records. */
export function callCheckerAgent(
  input: CheckerAgentCall,
  pair: CalibrationPair,
  memoryFingerprint: string,
): Promise<AssessAgentResult> {
  return input.assessAgent({
    config: input.config,
    agentName: input.agent.agentName,
    prologueInput: prologueInputOf(pair, {
      agentFingerprint: input.agent.agentFingerprint,
      definitionMemoryFingerprint: memoryFingerprint,
    }),
    deploymentEntries: input.deploymentEntries,
    binding: { selfCheckRunId: input.selfCheckRunId },
    notAfter: new Date(input.clock.now().getTime() + CALL_WINDOW_MS),
  });
}

async function judgeAgentPair(
  input: AgentCalibrationInput,
  pair: CalibrationPair,
  memoryFingerprint: string,
): Promise<
  | JudgedPair
  | {
      readonly rejected: Extract<
        AssessAgentResult,
        { outcome: 'rejected' }
      >['code'];
    }
> {
  const called = await callCheckerAgent(input, pair, memoryFingerprint);
  if (called.outcome === 'rejected') return { rejected: called.code };
  const assessment =
    called.outcome === 'finished'
      ? FinishedResultSchema.parse(called.result).assessment
      : null;
  return {
    usage: called.usage,
    outcome: comparedWithKey({
      pair,
      atomCheck: atomCheckOf(pair.claimAtoms, pair.pages),
      assessment,
      callFailure: agentCallFailure(called),
    }),
  };
}

/** Why no assessment came back; only an accepted `finish` carries one. The only accepted prologue end is `needs_narrowing`. */
function agentCallFailure(
  called: Exclude<AssessAgentResult, { outcome: 'rejected' }>,
): PairFailure | null {
  switch (called.outcome) {
    case 'finished':
      return null;
    case 'ended':
      return 'needs_narrowing';
    case 'invalid_result':
      return 'invalid_assessment';
    case 'failed':
      return called.code;
  }
}

/** The rule of the engine over one answer, compared with the pair's key by enums only. */
function comparedWithKey(input: {
  readonly pair: CalibrationPair;
  readonly atomCheck: AtomCheck;
  readonly assessment: unknown;
  readonly callFailure: PairFailure | null;
}): PairOutcome {
  const { pair, atomCheck, assessment, callFailure } = input;
  const { pointer, pages } = pointerOverAll(pair.pages);
  const decision = decideClaim({
    assessment,
    pointer,
    atomCheck,
    pages,
    // Without a table every established claim is in the lowest group; calibration reads only the profile.
    groupTable: undefined,
  });
  // Step 2 of «Как калибровка ставит таблицу групп»: the status rests on the assessment only, so the key does too.
  const shouldBeEstablished =
    pair.expectedSupport === 'yes' && pair.expectedType !== 'causal';
  const failure: PairFailure | null =
    callFailure ??
    (decision.reason === 'invalid_assessment' ? 'invalid_assessment' : null);
  // A decision other than `invalid_assessment` means the assessment passed the form rule, so it parses.
  const inForm =
    failure === null ? ClaimAssessmentSchema.parse(assessment) : null;
  const established = decision.status === 'supported';
  const establishedByVeto = established && atomCheck.valueCheck !== 'unmatched';
  return {
    pairId: pair.pairId,
    pairKind: pair.pairKind,
    failure,
    supportMatch: inForm?.support === pair.expectedSupport,
    typeMatch: inForm?.claimType === pair.expectedType,
    shouldBeEstablished,
    established,
    decisionCorrect: failure === null && established === shouldBeEstablished,
    vetoCorrect: failure === null && establishedByVeto === shouldBeEstablished,
    profile: established ? decision.profile : null,
  };
}

const profileKey = (profile: ClaimProfile): string =>
  JSON.stringify([
    profile.claimType,
    profile.valueCheck,
    profile.independentRecords,
    profile.contradictions,
  ]);

/** Lower bound of the Wilson score interval of `correct` in `total` at z = 1.645. */
function wilsonLowerBound(correct: number, total: number): number {
  const share = correct / total;
  const z2 = WILSON_Z * WILSON_Z;
  const centre = share + z2 / (2 * total);
  const spread =
    WILSON_Z *
    Math.sqrt((share * (1 - share)) / total + z2 / (4 * total * total));
  return (centre - spread) / (1 + z2 / total);
}

/** The established pairs by profile, ranked from the best lower bound down, each with its group. */
function rankProfiles(
  established: readonly PairOutcome[],
  groupCount: GroupCount,
): RankedProfile[] {
  const byProfile = new Map<
    string,
    { profile: ClaimProfile; pairs: number; correct: number }
  >();
  for (const pair of established) {
    const profile = pair.profile!;
    const key = profileKey(profile);
    const entry = byProfile.get(key) ?? { profile, pairs: 0, correct: 0 };
    entry.pairs += 1;
    if (pair.decisionCorrect) entry.correct += 1;
    byProfile.set(key, entry);
  }
  const row = [...byProfile.values()]
    .map((entry) => ({
      ...entry,
      lowerBound: wilsonLowerBound(entry.correct, entry.pairs),
    }))
    .sort(
      (left, right) =>
        right.lowerBound - left.lowerBound ||
        profileKey(left.profile).localeCompare(profileKey(right.profile)),
    );
  const groupIndex = splitIntoGroups(
    row.map((entry) => entry.pairs),
    groupCount,
  );
  const names = GROUP_NAMES[groupCount];
  return row.map((entry, index) => ({
    ...entry,
    group: names[groupIndex[index]!]!,
  }));
}

/**
 * The group index of each profile of a ranked row, from 0 at the top: the row is cut into `groupCount` consecutive
 * non-empty parts whose largest deviation from «pairs / groups» is the smallest; on a tie, the part sizes from the top
 * compared in order, the smaller first — so the smaller top group wins. With fewer profiles than groups each profile
 * is a group of its own from the top and the lower groups stay empty.
 */
export function splitIntoGroups(
  sizes: readonly number[],
  groupCount: number,
): number[] {
  if (sizes.length <= groupCount) return sizes.map((_, index) => index);
  const target = sizes.reduce((sum, size) => sum + size, 0) / groupCount;
  let best: { cuts: number[]; parts: number[]; deviation: number } | null =
    null;
  for (const cuts of cutPoints(sizes.length, groupCount - 1)) {
    const parts = partSizes(sizes, cuts);
    const deviation = Math.max(...parts.map((part) => Math.abs(part - target)));
    if (best === null || isBetter({ parts, deviation }, best)) {
      best = { cuts, parts, deviation };
    }
  }
  const bounds = [...best!.cuts, sizes.length];
  return sizes.map((_, index) => bounds.findIndex((bound) => index < bound));
}

function isBetter(
  candidate: { parts: number[]; deviation: number },
  best: { parts: number[]; deviation: number },
): boolean {
  if (candidate.deviation < best.deviation - SIZE_EPSILON) return true;
  if (candidate.deviation > best.deviation + SIZE_EPSILON) return false;
  const differing = candidate.parts.findIndex(
    (part, index) => part !== best.parts[index],
  );
  return (
    differing !== -1 && candidate.parts[differing]! < best.parts[differing]!
  );
}

/** Every increasing choice of `count` cut positions in 1..length-1: a cut at i starts a part at profile i. */
function* cutPoints(
  length: number,
  count: number,
  from = 1,
): Generator<number[]> {
  if (count === 0) {
    yield [];
    return;
  }
  for (let cut = from; cut <= length - count; cut += 1) {
    for (const rest of cutPoints(length, count - 1, cut + 1)) {
      yield [cut, ...rest];
    }
  }
}

function partSizes(
  sizes: readonly number[],
  cuts: readonly number[],
): number[] {
  const bounds = [0, ...cuts, sizes.length];
  return bounds
    .slice(1)
    .map((end, index) =>
      sizes.slice(bounds[index], end).reduce((sum, size) => sum + size, 0),
    );
}

/** Every group of the count from the top, an empty one with 0 pairs; H-03 compares each with the next non-empty below. */
function groupLines(
  ranked: readonly RankedProfile[],
  groupCount: GroupCount,
): GroupLine[] {
  const counted = GROUP_NAMES[groupCount].map((group) => {
    const members = ranked.filter((entry) => entry.group === group);
    const establishedPairs = members.reduce(
      (sum, entry) => sum + entry.pairs,
      0,
    );
    const correct = members.reduce((sum, entry) => sum + entry.correct, 0);
    return {
      group,
      establishedPairs,
      correctShare: establishedPairs === 0 ? 0 : correct / establishedPairs,
    };
  });
  return counted.map((line, index) => {
    const below = counted
      .slice(index + 1)
      .find((other) => other.establishedPairs > 0);
    return {
      ...line,
      notMoreAccurateThanBelow:
        line.establishedPairs > 0 &&
        below !== undefined &&
        line.correctShare <= below.correctShare,
    };
  });
}

/** Per pair kind, in order of first appearance, the shares of pairs matching the key on support, type and decision. */
function pairKindShares(
  pairs: readonly PairOutcome[],
): GroupTable['pairKinds'] {
  const kinds = [...new Set(pairs.map((pair) => pair.pairKind))];
  return kinds.map((pairKind) => {
    const ofKind = pairs.filter((pair) => pair.pairKind === pairKind);
    const share = (matches: (pair: PairOutcome) => boolean): number =>
      ofKind.filter(matches).length / ofKind.length;
    return {
      pairKind,
      supportMatch: share((pair) => pair.supportMatch),
      typeMatch: share((pair) => pair.typeMatch),
      decisionMatch: share((pair) => pair.decisionCorrect),
    };
  });
}

function addUsage(left: AssessUsage, right: AssessUsage): AssessUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    costUsd: left.costUsd + right.costUsd,
  };
}

/** Writes the table as JSON, replacing whatever the file held: a new calibration overwrites the old table. */
export async function writeGroupTable(
  path: string,
  table: GroupTable,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
}

const percent = (share: number): string => `${(share * 100).toFixed(1)} %`;

const VALUE_CHECK_LABELS: Readonly<Record<ClaimProfile['valueCheck'], string>> =
  {
    matched: 'значения совпали',
    unmatched: 'значения не совпали',
    not_applicable: 'без атомов',
  };

const profileLabel = (profile: ClaimProfile): string =>
  [
    profile.claimType,
    VALUE_CHECK_LABELS[profile.valueCheck],
    profile.independentRecords === 'two_or_more'
      ? 'две и больше записей'
      : 'одна запись',
    profile.contradictions ? 'с противоречиями' : 'без противоречий',
  ].join(', ');

const tableKeyLabel = (table: GroupTable): string =>
  `отпечаток агента: ${table.agentFingerprint}; отпечаток памяти определения: ${table.definitionMemoryFingerprint}`;

/** The calibration report for the developer: printed, the table itself is the file at `outPath`. */
export function renderCalibrationReport(
  report: CalibrationReport,
  outPath: string,
): string {
  const { table, usage } = report;
  const failed = report.pairs.filter((pair) => pair.failure !== null);
  const vetoShare = (pairKind: string): number => {
    const ofKind = report.pairs.filter((pair) => pair.pairKind === pairKind);
    return ofKind.filter((pair) => pair.vetoCorrect).length / ofKind.length;
  };
  return [
    `# Калибровка проверяющего вызова`,
    '',
    `- Модель: ${table.model}; ${tableKeyLabel(table)}`,
    `- Набор: ${table.scenarioSet}; отпечаток пар: ${table.pairsFingerprint}; пар: ${report.pairs.length}`,
    `- Время калибровки: ${table.calibratedAt}; групп: ${table.groupCount}`,
    `- Расход: вход ${usage.inputTokens}, выход ${usage.outputTokens} токенов, $${usage.costUsd.toFixed(4)}`,
    `- Таблица групп: ${outPath}`,
    '',
    '## Совпадения с ключом по видам пар',
    '',
    '| Вид пары | «Подтверждают ли» | Тип | Решение алгоритма | Прежнее вето «значения не совпали — не установлено» |',
    '|---|---|---|---|---|',
    ...table.pairKinds.map(
      (kind) =>
        `| ${kind.pairKind} | ${percent(kind.supportMatch)} | ${percent(kind.typeMatch)} | ${percent(kind.decisionMatch)} | ${percent(vetoShare(kind.pairKind))} |`,
    ),
    '',
    '## Профили по нижней границе 90-процентного интервала',
    '',
    '| Профиль | Пар | Верных | Нижняя граница | Группа |',
    '|---|---|---|---|---|',
    ...report.ranked.map(
      (entry) =>
        `| ${profileLabel(entry.profile)} | ${entry.pairs} | ${entry.correct} | ${entry.lowerBound.toFixed(3)} | ${entry.group} |`,
    ),
    '',
    '## Группы',
    '',
    '| Группа | Установленных пар | Доля верных | H-03 |',
    '|---|---|---|---|',
    ...report.groups.map(
      (group) =>
        `| ${group.group} | ${group.establishedPairs} | ${percent(group.correctShare)} | ${group.notMoreAccurateThanBelow ? 'не точнее группы ниже' : '—'} |`,
    ),
    '',
    '## Пары без оценки (неверное решение)',
    '',
    ...(failed.length === 0
      ? ['Нет.']
      : failed.map((pair) => `- ${pair.pairId} — ${pair.failure}`)),
    '',
  ].join('\n');
}
