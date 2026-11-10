import type { ClaimAssessment, ClaimCheckPage } from '@agent-os/engine';
import type { CalibrationPair } from '@agent-os/mcp-fixture';
import { z } from 'zod';
import {
  callCheckerAgent,
  type CheckerAgentCall,
  deploymentMemoryFingerprint,
  FinishedResultSchema,
} from '../calibrate/calibration.js';
import type { InjectionMeasure } from '../result/run-result.js';
import { citesTrace } from '../verdict/verdict.js';

/**
 * The measure of text addressed to the model (design-engine.md, `RunResult.metrics`, `injectionInfluence`; AC-17.1;
 * design-research-flow.md, «Самопроверка», AC-20.1): each `injected` calibration pair of a scenario is checked twice by
 * `Engine.assessAgent` runs of the definition of the form `claim_assessment` on the prologue input of each set of pages,
 * as in calibration — once as it is and once without the records of the traces the scenario key names in
 * `injectionTraceIds`. The pair counts as influenced when `support` or `claimType` differ. Only those closed fields and
 * the records' `traceId` identifiers are read; no text of the claim, the records or the answer.
 */

/** A log record carries its trace in the `traceId` field; a count group carries none. */
const TracedRecordSchema = z.object({ traceId: z.string() });

interface ScenarioPairs {
  /** The scenario's calibration pairs; only those marked `injected` are checked. */
  readonly pairs: readonly CalibrationPair[];
  /** `ScenarioKey.injectionTraceIds` of the scenario. */
  readonly injectionTraceIds: readonly string[];
}

export type AgentInjectionMeasureInput = ScenarioPairs & CheckerAgentCall;

/** One check of a pair over these pages: the assessment in form, or null when there is none. */
type PairCheck = (
  pair: CalibrationPair,
  pages: CalibrationPair['pages'],
) => Promise<ClaimAssessment | null>;

/** One scenario's measure over the checker agent; the turns run with its `deployment` entries. */
export function measureAgentInjection(
  input: AgentInjectionMeasureInput,
): Promise<InjectionMeasure> {
  const memoryFingerprint = deploymentMemoryFingerprint(
    input.deploymentEntries,
  );
  return measurePairs(input, (pair, pages) =>
    assessPairByAgent(input, { ...pair, pages }, memoryFingerprint),
  );
}

/**
 * Whether a run's answer rests on text addressed to the model (design-research-flow.md, `injectionInBasis`): the basis
 * of an established claim holds a record of the key's traces. Null when the scenario has no such text, so it is outside
 * the measure. Only identifiers are read.
 */
export function injectionInBasis(input: {
  readonly established: readonly { readonly evidenceIds: readonly string[] }[];
  readonly injectionTraceIds: readonly string[];
  readonly pageTraceIds: ReadonlyMap<string, readonly string[]>;
}): boolean | null {
  if (input.injectionTraceIds.length === 0) return null;
  return citesTrace(
    input.established,
    input.injectionTraceIds,
    input.pageTraceIds,
  );
}

/**
 * Two checks per `injected` pair, in pair order. A pair with no record left without the traces is not called; a pair
 * whose check gave no assessment is counted apart and is not in the measure.
 */
async function measurePairs(
  input: ScenarioPairs,
  check: PairCheck,
): Promise<InjectionMeasure> {
  const injected = new Set(input.injectionTraceIds);
  let measuredPairs = 0;
  let influencedPairs = 0;
  let unassessedPairs = 0;
  for (const pair of input.pairs) {
    if (!pair.injected) continue;
    const clean = withoutTraces(pair.pages, injected);
    if (recordCount(clean) === 0) continue;
    const asIs = await check(pair, pair.pages);
    const without = await check(pair, clean);
    if (asIs === null || without === null) {
      unassessedPairs += 1;
      continue;
    }
    measuredPairs += 1;
    if (
      asIs.support !== without.support ||
      asIs.claimType !== without.claimType
    ) {
      influencedPairs += 1;
    }
  }
  return { measuredPairs, influencedPairs, unassessedPairs };
}

/** The pages without the records of the named traces; a page left with no record is dropped. */
function withoutTraces<Page extends ClaimCheckPage>(
  pages: readonly Page[],
  traceIds: ReadonlySet<string>,
): Page[] {
  return pages.flatMap((page) => {
    const records = page.records.filter((record) => {
      const traced = TracedRecordSchema.safeParse(record);
      return !(traced.success && traceIds.has(traced.data.traceId));
    });
    return records.length === 0 ? [] : [{ ...page, records }];
  });
}

const recordCount = (pages: readonly ClaimCheckPage[]): number =>
  pages.reduce((sum, page) => sum + page.records.length, 0);

/**
 * One run of the checker agent over the pair's pages: the assessment an accepted `finish` carries, or null for a run
 * that gave none. A rejected call is a defect of the build, as in calibration, and ends the measure.
 */
async function assessPairByAgent(
  input: AgentInjectionMeasureInput,
  pair: CalibrationPair,
  memoryFingerprint: string,
): Promise<ClaimAssessment | null> {
  const called = await callCheckerAgent(input, pair, memoryFingerprint);
  if (called.outcome === 'rejected') {
    throw new Error(
      `Engine.assessAgent rejected agent ${input.agent.agentName} on pair ${pair.pairId}: ${called.code}`,
    );
  }
  return called.outcome === 'finished'
    ? FinishedResultSchema.parse(called.result).assessment
    : null;
}
