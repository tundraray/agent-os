import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  deepResearchProcessV3,
  readTranscripts,
  type RunRecord,
  type TranscriptRetention,
} from '@agent-os/engine';
import type { DatasetVersion } from '@agent-os/mcp-fixture';
import type { FormCheckResult } from '../judge/form-check.js';
import { judgeRunWithoutKey } from '../judge/judge-call.js';
import type { UnkeyedJudgeForm } from '../judge/judge-forms.js';
import { SELF_CHECK_OWNER } from '../../auth/system-owners.js';
import type { SelfCheckProgram } from '../program.js';
import { readOriginal } from '../replay/replay-command.js';
import { JUDGE_WINDOW_MS } from '../run/run-command.js';
import { failureSignals } from '../signals.js';
import { copyOrigin, formatThreadId } from '../thread-ids.js';
import { renderCourseReport } from './course-report.js';

/**
 * The `show` command of the self-check program (design-self-check.md, Flow 4, Contract `show`, FR-07, DC-15): the
 * course of one investigation read by its owner — an employee's within the retention term of `TRANSCRIPT_RETENTION_DAYS`,
 * one of `system:self-check` without a term. Another owner's or an absent investigation is refused with
 * `investigation_not_found` before the judge. With an answer, the judge without a key runs through `Engine.assess`,
 * bound to a new self-check run id `self-check:show:<investigationId>:<uuid>` that remembers the original (a repeat
 * passes on its own original). The report is returned for the command line to print and is never saved. The
 * investigation is only read.
 */

export interface ShowOptions {
  readonly investigationId: string;
  /** The owner of the investigation: an employee, or `system:self-check`. */
  readonly ownerId: string;
}

export interface ShowRefusal {
  readonly ok: false;
  readonly code: 'invalid_arguments' | 'investigation_not_found';
  readonly reason: string;
}

export type ShowOutcome =
  | {
      readonly ok: true;
      /** The report to print; it is not written anywhere. */
      readonly report: string;
      readonly showRunId: string;
    }
  | ShowRefusal;

/**
 * What the assembly for the judge serves. The judge reads no record and the assembly starts no fixture process (the
 * adapter starts it on the first call, and the judge makes none), so any known slice does.
 */
const JUDGE_ASSEMBLY_SERVED: DatasetVersion = 'v1';

const refusal = (code: ShowRefusal['code'], reason: string): ShowRefusal => ({
  ok: false,
  code,
  reason,
});

/** `show --investigation <id> --owner <ownerId>`. */
export async function executeShowCommand(
  args: readonly string[],
  program: SelfCheckProgram,
): Promise<ShowOutcome> {
  const parsed = parseShowArgs(args);
  return parsed.ok ? showInvestigation(program, parsed.options) : parsed;
}

function parseShowArgs(
  args: readonly string[],
): { readonly ok: true; readonly options: ShowOptions } | ShowRefusal {
  let values: { readonly [name: string]: string | undefined };
  try {
    ({ values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: {
        investigation: { type: 'string' },
        owner: { type: 'string' },
      },
    }));
  } catch (error) {
    return refusal(
      'invalid_arguments',
      error instanceof Error ? error.message : String(error),
    );
  }
  const { investigation, owner } = values;
  if (investigation === undefined || investigation === '') {
    return refusal(
      'invalid_arguments',
      'no investigation given (--investigation <id>)',
    );
  }
  if (owner === undefined || owner === '') {
    return refusal('invalid_arguments', 'no owner given (--owner <ownerId>)');
  }
  return {
    ok: true,
    options: { investigationId: investigation, ownerId: owner },
  };
}

/** The read by owner first; only an investigation found there reaches the judge. */
async function showInvestigation(
  program: SelfCheckProgram,
  { investigationId, ownerId }: ShowOptions,
): Promise<ShowOutcome> {
  const db = program.database();
  // The term is the employees' (FR-01): the program's own investigations are kept and read without one (AC-01.5).
  const retention: TranscriptRetention =
    ownerId === SELF_CHECK_OWNER ? 'no_term' : program.transcriptRetention();
  const notFound = refusal(
    'investigation_not_found',
    `investigation ${investigationId} of ${ownerId} not found`,
  );
  const original = await readOriginal(db, investigationId, ownerId);
  if (original === null) return notFound;
  const read = await readTranscripts(db, {
    investigationId,
    ownerId,
    retention,
  });
  if (read.outcome !== 'found') return notFound;

  const { record } = original;
  const showRunId = formatThreadId({
    kind: 'show',
    investigationId: copyOrigin({
      investigationId,
      ownerId,
      threadId: original.threadId,
    }),
    showId: randomUUID(),
  });
  const judge = await judgeShow(program, record, showRunId);
  const signals = failureSignals({
    run: record,
    judge,
    thresholds: program.settings.signals,
  });
  program.logger.log('self-check show reported', {
    investigationId,
    showRunId,
    judged: judge !== null,
    judgeInvalid: judge !== null && !judge.valid,
    transcripts: read.transcripts.length,
  });
  return {
    ok: true,
    showRunId,
    report: renderCourseReport({
      record,
      transcripts: read.transcripts,
      retention,
      signals,
      showRunId,
    }),
  };
}

/**
 * The judge without a key on the investigation's answer, its transcript bound to the show run and to no
 * investigation; null without an answer (no call). An unavailable judge or a form not by the rules is the invalid result.
 * The assembly runs no workers: `show` executes no investigation task, so a task left queued by a dropped `run` is
 * never claimed here — only `Engine.assess` is called.
 */
async function judgeShow(
  program: SelfCheckProgram,
  record: RunRecord,
  showRunId: string,
): Promise<FormCheckResult<UnkeyedJudgeForm> | null> {
  if (record.answer === null) return null;
  const assembly = await program.assembleScenario({
    scenario: JUDGE_ASSEMBLY_SERVED,
    processConfig: deepResearchProcessV3,
    workers: false,
  });
  try {
    const called = await judgeRunWithoutKey(
      { engine: assembly.engine, judge: program.settings.judge },
      {
        question: record.query,
        answer: record.answer,
        binding: { selfCheckRunId: showRunId },
        notAfter: new Date(program.clock.now().getTime() + JUDGE_WINDOW_MS),
      },
    );
    return called.checked;
  } finally {
    await assembly.close();
  }
}
