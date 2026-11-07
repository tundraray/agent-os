import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  deepResearchProcessV2,
  readTranscripts,
  type RunRecord,
  type TranscriptRetention,
} from '@agent-os/engine';
import type { DatasetVersion } from '@agent-os/mcp-fixture';
import type { FormCheckResult } from '../judge/form-check.js';
import { judgeRunWithoutKey } from '../judge/judge-call.js';
import type { UnkeyedJudgeForm } from '../judge/judge-forms.js';
import type { SelfCheckProgram } from '../program.js';
import { readOriginal } from '../replay/replay-command.js';
import { JUDGE_WINDOW_MS } from '../run/run-command.js';
import { failureSignals } from '../signals.js';
import {
  copyOrigin,
  type DatabaseBase,
  formatThreadId,
} from '../thread-ids.js';
import { renderCourseReport } from './course-report.js';

/**
 * The `show` command of the self-check program (design-self-check.md, Flow 4, Contract `show`, FR-07, DC-15): the
 * course of one investigation of the main database (transcripts within its retention term) or of the self-check
 * database (no term), read by its owner. Another owner's or an absent investigation is refused with
 * `investigation_not_found` before the judge. With an answer, the judge without a key runs through `Engine.assess`,
 * bound to a new self-check run id `self-check:show:<base>:<investigationId>:<uuid>` that remembers the original (a
 * copy passes on its own original); its transcript stays in the self-check database. The report is returned for the
 * command line to print and is never saved. The source database is only read.
 */

/**
 * The main database's transcript retention term, `TRANSCRIPT_RETENTION_DAYS` parsed as the server parses it
 * (`parseTranscriptRetention`). The program provides it (wired with the command, task-42); it is read only for a
 * `show` over the main database.
 */
export interface MainRetentionReader {
  mainTranscriptRetention(): { readonly days: number };
}

export type ShowProgram = SelfCheckProgram & MainRetentionReader;

export interface ShowOptions {
  readonly investigationId: string;
  /** The owner of the investigation in the source database. */
  readonly ownerId: string;
  readonly base: DatabaseBase;
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

const DEFAULT_BASE: DatabaseBase = 'main';
const BASES: readonly DatabaseBase[] = ['main', 'self_check'];

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

/** `show --investigation <id> --owner <ownerId> [--base main|self_check]`. */
export async function executeShowCommand(
  args: readonly string[],
  program: ShowProgram,
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
        base: { type: 'string' },
      },
    }));
  } catch (error) {
    return refusal(
      'invalid_arguments',
      error instanceof Error ? error.message : String(error),
    );
  }
  const { investigation, owner } = values;
  const base = BASES.find((known) => known === (values.base ?? DEFAULT_BASE));
  if (investigation === undefined || investigation === '') {
    return refusal(
      'invalid_arguments',
      'no investigation given (--investigation <id>)',
    );
  }
  if (owner === undefined || owner === '') {
    return refusal('invalid_arguments', 'no owner given (--owner <ownerId>)');
  }
  if (base === undefined) {
    return refusal(
      'invalid_arguments',
      `--base must be one of ${BASES.join(', ')}, got "${values.base}"`,
    );
  }
  return {
    ok: true,
    options: { investigationId: investigation, ownerId: owner, base },
  };
}

/** The read by owner first; only an investigation found there reaches the judge. */
async function showInvestigation(
  program: ShowProgram,
  { investigationId, ownerId, base }: ShowOptions,
): Promise<ShowOutcome> {
  const db =
    base === 'main' ? program.mainDatabase() : program.selfCheckDatabase();
  const retention: TranscriptRetention =
    base === 'main' ? program.mainTranscriptRetention() : 'no_term';
  const notFound = refusal(
    'investigation_not_found',
    `investigation ${base}:${investigationId} of ${ownerId} not found`,
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
    ...copyOrigin({ base, investigationId, threadId: original.threadId }),
    showId: randomUUID(),
  });
  const judge = await judgeShow(program, record, showRunId);
  const signals = failureSignals({
    run: record,
    judge,
    thresholds: program.settings.signals,
  });
  program.logger.log('self-check show reported', {
    base,
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
      base,
      record,
      transcripts: read.transcripts,
      retention,
      signals,
      showRunId,
    }),
  };
}

/**
 * The judge without a key on the investigation's answer, its transcript bound to the show run in the self-check
 * database; null without an answer (no call). An unavailable judge or a form not by the rules is the invalid result.
 * The assembly runs no workers: `show` executes no investigation task, so a task left queued by a dropped `run` is
 * never claimed here — only `Engine.assess` is called.
 */
async function judgeShow(
  program: ShowProgram,
  record: RunRecord,
  showRunId: string,
): Promise<FormCheckResult<UnkeyedJudgeForm> | null> {
  if (record.answer === null) return null;
  const assembly = await program.assembleScenario({
    scenario: JUDGE_ASSEMBLY_SERVED,
    processConfig: deepResearchProcessV2,
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
