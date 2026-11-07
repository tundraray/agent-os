import { ResearchAnswerBodySchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { EvidenceReader } from '@agent-os/runtime';
import { z } from 'zod';
import type { SourceMode } from '../config/source-check.js';
import { controllerRepository } from '../controller/decisions.repository.js';
import { engineRunsRepository as runs } from '../runs/engine-runs.repository.js';
import { InvestigationAnswerSchema } from './code-answer.js';
import { type AnswerMessage, type AnswerPage, type AnswerToBuild, buildResearchAnswer, citedEvidenceIds } from './research-answer.builder.js';

/** What the answer message is built from besides the answer: the investigation's engine row and the owner's pages. */
interface AnswerMessageDeps {
  readonly database: Database;
  readonly evidence: Pick<EvidenceReader, 'get'>;
}

/**
 * The stored answer with its message (design-engine.md, Data Model «Ответ движка»): an answer written before
 * agent-quality has none, and its message is built by {@link readAnswerMessage} only.
 */
const StoredAnswerSchema = InvestigationAnswerSchema.extend({
  message: z.object({ text: z.string().min(1), metadata: ResearchAnswerBodySchema }).nullable().default(null),
});

/** Builds the message of `answer` once its pages are known; nothing is read any more. */
export type BuildAnswerMessage = (answer: AnswerToBuild) => AnswerMessage;

/**
 * Reads what the message of an answer of the investigation needs (design-engine.md, C3 step 4): its question,
 * `launchKey` and recorded mode, and the details of each of `pageIds` through `EvidenceReader` for the owner — none
 * without sources. A page that cannot be read throws, so the caller's step fails before it writes the answer (Flow 2).
 * The pages the built answer cites must be among `pageIds`.
 */
export async function prepareAnswerMessage(
  deps: AnswerMessageDeps,
  investigationId: string,
  pageIds: Iterable<string>,
): Promise<BuildAnswerMessage> {
  const read = await controllerRepository.readRun(deps.database, investigationId);
  if (read === undefined) {
    throw new Error(`investigation ${investigationId} has no engine row`);
  }
  const { run, query } = read;
  const sourceMode = run.sourceMode as SourceMode;
  const pages = new Map<string, AnswerPage>();
  if (sourceMode === 'sources') {
    for (const evidenceId of new Set(pageIds)) {
      const { record } = await deps.evidence.get(evidenceId, run.resourceId);
      pages.set(evidenceId, {
        sourceId: record.provenance.sourceId,
        toolName: record.provenance.toolName,
        snapshot: record.provenance.snapshot,
        truncated: record.coverage.truncated,
      });
    }
  }
  return (answer) => buildResearchAnswer({ answer, goal: query, launchKey: run.launchKey, sourceMode, pages });
}

/** Every page any claim of the answer names: what a code-built answer cites. */
export function answerPages(answer: AnswerToBuild): string[] {
  return citedEvidenceIds(answer, 'sources');
}

export type ReadAnswerMessageResult =
  | { readonly outcome: 'found'; readonly message: AnswerMessage }
  | { readonly outcome: 'rejected'; readonly code: 'investigation_not_found' | 'no_answer' };

/**
 * `Engine.readAnswerMessage` (design-engine.md, Contract Definitions): the stored message of the owner's investigation
 * once it is completed with an answer; for an answer written before agent-quality, the message built now (UXRD KD-7) —
 * the stored row is left as it is. `investigation_not_found` for another owner's or an unknown investigation,
 * `no_answer` for one not completed with an answer. A database or page read that fails throws.
 */
export async function readAnswerMessage(
  deps: AnswerMessageDeps,
  { investigationId, resourceId }: { readonly investigationId: string; readonly resourceId: string },
): Promise<ReadAnswerMessageResult> {
  if (!z.uuid().safeParse(investigationId).success) {
    return { outcome: 'rejected', code: 'investigation_not_found' };
  }
  const status = await runs.readStatus(deps.database, investigationId, resourceId);
  if (status === undefined) {
    return { outcome: 'rejected', code: 'investigation_not_found' };
  }
  if (status.investigationStatus !== 'completed' || status.run.answer === null) {
    return { outcome: 'rejected', code: 'no_answer' };
  }
  const answer = StoredAnswerSchema.parse(status.run.answer);
  if (answer.message !== null) {
    return { outcome: 'found', message: answer.message };
  }
  const build = await prepareAnswerMessage(deps, investigationId, answerPages(answer));
  return { outcome: 'found', message: build(answer) };
}
