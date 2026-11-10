import { investigationMemoryRepository, type NoteFilter, type NoteRow } from '../investigation-memory.repository.js';
import { fitItems, type ImmediateTool } from './tool-context.js';

/** At most 50 notes per call (Contract `memory_read`). */
const NOTES_PER_CALL = 50;

/** A note as the model reads it: number, kind, text, references, the authoring agent and run. */
const noteView = (note: NoteRow) => ({
  seq: note.seq,
  kind: note.kind,
  text: note.text,
  refs: note.refs,
  agent: note.agentName,
  run: note.runTaskId,
});

/**
 * `memory_read` (`read`): the notes of this investigation by kind, author and `after`, up to 50, the newest last. Only
 * this investigation's notes are read: the call names no investigation. `more` tells that notes are left after the last
 * one returned (read them with `after`), whether the count or the result's size stopped the list.
 */
export function memoryReadTool(resultMaxBytes: number): ImmediateTool {
  return {
    name: 'memory_read',
    async run({ tx, run, args }) {
      const filter = args as NoteFilter;
      const notes = (await investigationMemoryRepository.read(tx, run.investigationId, filter, NOTES_PER_CALL + 1)).map(
        noteView,
      );
      const listed = notes.slice(0, NOTES_PER_CALL);
      const taken = fitItems(listed, resultMaxBytes, (items) => ({ notes: items, more: true }));
      const result = { notes: taken, more: taken.length < notes.length };
      return { to: 'done', outcome: taken.length === 0 ? 'empty' : 'success', result };
    },
  };
}
