import { investigationMemoryRepository, type NoteKind, type NoteRef } from '../investigation-memory.repository.js';
import { refsBelong } from '../investigation-refs.js';
import type { ImmediateTool } from './tool-context.js';

interface MemoryWriteArgs {
  readonly kind: NoteKind;
  readonly text: string;
  readonly refs: readonly NoteRef[];
}

/**
 * `memory_write` (`write`): a new note of this investigation, written in the call's guarded transaction together with
 * its outcome (KD-3). Refused with `foreign_ref` when a reference leads to another investigation or nowhere; the note is
 * then not written. Returns the note's number.
 */
export const memoryWriteTool: ImmediateTool = {
  name: 'memory_write',
  async run({ tx, run, args }) {
    const note = args as MemoryWriteArgs;
    if (!(await refsBelong(tx, run.investigationId, note.refs))) {
      return { to: 'rejected', outcome: 'rejected', reason: 'foreign_ref' };
    }
    const seq = await investigationMemoryRepository.append(tx, {
      investigationId: run.investigationId,
      runTaskId: run.runTaskId,
      agentName: run.agentName,
      kind: note.kind,
      text: note.text,
      refs: note.refs,
    });
    return { to: 'done', outcome: 'success', result: { seq } };
  },
};
