import { useMemo, useReducer } from 'react';
import type { LibraryErrorText } from '@/lib/library/library-errors';
import {
  changedFields,
  definitionOf,
  type AgentDefinition,
  type AgentRecord,
  type ChangedField,
} from '@/lib/library/record-rules';

/**
 * State of the agent editor's form (design-web.md, KD-3, «State Transitions and Invariants»). The
 * saved record and the typed values are kept apart: "has changes", the conflict's fields and «Вернуть»
 * are comparisons of two values, never flags. No action but the author's own replaces the typed values
 * (Invariant 1), and a save carries only the version the edit started from or the one the author
 * accepted in a conflict (Invariant 2).
 */

type Phase = 'editing' | 'saving' | 'saved' | 'conflict';

export type RecordFormState = {
  /** The record as saved: the version the edit started from or the one accepted in a conflict; `null` while new. */
  readonly saved: AgentRecord | null;
  /** What the typed values are compared with: the saved record's definition, or a new record's blank one. */
  readonly base: AgentDefinition;
  readonly values: AgentDefinition;
  readonly phase: Phase;
  readonly error: LibraryErrorText | null;
  /** The record saved elsewhere after a 409; `null` when its read failed (MC-10 without fields). */
  readonly conflictSaved: AgentRecord | null;
  /** What «Вернуть» puts back after «Отменить изменения» or «Взять сохранённое». */
  readonly undo: AgentDefinition | null;
};

export type RecordFormInit = { saved: AgentRecord } | { blank: AgentDefinition };

export type RecordFormAction =
  | { type: 'input'; values: AgentDefinition }
  /** «Отменить изменения». */
  | { type: 'discard' }
  | { type: 'save' }
  | { type: 'saved'; record: AgentRecord }
  | { type: 'failed'; error: LibraryErrorText }
  | { type: 'conflict'; saved: AgentRecord | null }
  /** «Сохранить мои правки». */
  | { type: 'saveMine' }
  /** «Взять сохранённое». */
  | { type: 'takeSaved' }
  /** «Вернуть». */
  | { type: 'restore' };

export function initialRecordForm(init: RecordFormInit): RecordFormState {
  const saved = 'saved' in init ? init.saved : null;
  const base = 'saved' in init ? definitionOf(init.saved) : init.blank;
  return {
    saved,
    base,
    values: base,
    phase: 'editing',
    error: null,
    conflictSaved: null,
    undo: null,
  };
}

/** Saved as `record`: both the form and the comparison base become its definition. */
function settle(state: RecordFormState, record: AgentRecord, undo: AgentDefinition | null): RecordFormState {
  const base = definitionOf(record);
  return { ...state, saved: record, base, values: base, error: null, conflictSaved: null, undo };
}

export function recordFormReducer(state: RecordFormState, action: RecordFormAction): RecordFormState {
  switch (action.type) {
    case 'input':
      return { ...state, values: action.values, undo: null, phase: state.phase === 'saved' ? 'editing' : state.phase };
    case 'discard':
      return { ...state, values: state.base, undo: state.values, error: null, phase: 'editing' };
    case 'save':
      return { ...state, phase: 'saving', error: null };
    case 'saved':
      return { ...settle(state, action.record, null), phase: 'saved' };
    case 'failed':
      return { ...state, phase: 'editing', error: action.error };
    case 'conflict':
      return { ...state, phase: 'conflict', error: null, conflictSaved: action.saved };
    case 'saveMine': {
      // Without the saved record its version is unknown: the edit's own version goes again, and a new 409 re-reads it.
      const accepted = state.conflictSaved;
      if (accepted === null) return { ...state, phase: 'saving', error: null };
      return { ...state, saved: accepted, base: definitionOf(accepted), conflictSaved: null, phase: 'saving', error: null };
    }
    case 'takeSaved':
      if (state.conflictSaved === null) return state;
      return { ...settle(state, state.conflictSaved, state.values), phase: 'editing' };
    case 'restore':
      if (state.undo === null) return state;
      return { ...state, values: state.undo, undo: null };
  }
}

export type RecordFormStatus = 'clean' | 'changed' | 'saving' | 'saved' | 'conflict';

export type RecordFormView = {
  status: RecordFormStatus;
  /** Fields the typed values change against the saved record; empty — nothing to save. */
  changed: ChangedField[];
  /** The version a save carries; `null` for a new record. */
  version: number | null;
  /** MC-10: the record saved elsewhere and the fields it changed against the version the edit started from. */
  conflict: { saved: AgentRecord | null; fields: ChangedField[] } | null;
};

export function recordFormView(state: RecordFormState): RecordFormView {
  const changed = changedFields(state.base, state.values);
  const status: RecordFormStatus =
    state.phase === 'editing' ? (changed.length > 0 ? 'changed' : 'clean') : state.phase;
  const conflict =
    state.phase === 'conflict'
      ? {
          saved: state.conflictSaved,
          fields: state.conflictSaved === null ? [] : changedFields(state.base, definitionOf(state.conflictSaved)),
        }
      : null;
  return { status, changed, version: state.saved?.version ?? null, conflict };
}

/** The editor's form: its state, what it shows, and the actions above. */
export function useRecordForm(init: RecordFormInit) {
  const [state, dispatch] = useReducer(recordFormReducer, init, initialRecordForm);
  const view = useMemo(() => recordFormView(state), [state]);
  return { state, view, dispatch };
}
