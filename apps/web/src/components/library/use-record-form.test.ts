import type { RecordDetail, WorkflowExecutor } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';
import type { LibraryErrorText } from '@/lib/library/library-errors';
import { changedFieldLabel, type RecordDefinition } from '@/lib/library/record-rules';
import { agentContent, fixtureId, recordDetail, workflowContent } from '@/test/fixtures';
import { testTranslator } from '@/test/intl';
import {
  initialRecordForm,
  recordFormReducer,
  recordFormView,
  type RecordFormAction,
  type RecordFormInit,
  type RecordFormStatus,
} from './use-record-form';

const t = testTranslator('library');
const RECORD_ID = fixtureId(11);
const SOURCE_ID = fixtureId(12);
const DESCRIPTION = 'Ищет причины ошибок в логах';

const agent = (name: string, description = DESCRIPTION): RecordDefinition => ({
  name,
  description,
  kind: 'agent',
  content: agentContent(),
});

/** Version 3 — the edit starts from it; version 4 — saved elsewhere with another description. */
const startV3 = recordDetail({ id: RECORD_ID, version: 3 });
const theirsV4 = recordDetail({ id: RECORD_ID, version: 4, description: 'Разбирает логи и метрики' });
const savedV4 = recordDetail({ id: RECORD_ID, version: 4, name: 'Разбор логов и метрик' });

const START = agent('Разбор логов');
const TYPED = agent('Разбор логов и метрик');
const THEIRS = agent('Разбор логов', 'Разбирает логи и метрики');

const workflowV2 = recordDetail({ id: RECORD_ID, kind: 'workflow', version: 2 });
const WORKFLOW: RecordDefinition = { name: 'Разбор логов', description: DESCRIPTION, kind: 'workflow', content: workflowContent() };
const [analyst] = workflowContent().executors as [WorkflowExecutor];
const analystNewVersion: WorkflowExecutor = {
  ...analyst,
  prompt: 'Найди причины ошибок и их частоту.',
  source: { recordId: SOURCE_ID, version: 2 },
};
const WORKFLOW_NEW_EXECUTOR: RecordDefinition = {
  ...WORKFLOW,
  kind: 'workflow',
  content: workflowContent({ executors: [analystNewVersion] }),
};

const NAME_TAKEN: LibraryErrorText = {
  place: { at: 'field', field: 'name' },
  text: 'У вас уже есть агент «Разбор логов и метрик»',
  open: false,
};

const edited: RecordFormInit = { saved: startV3 };
const input = (values: RecordDefinition): RecordFormAction => ({ type: 'input', values });
const conflictWith = (saved: RecordDetail | null): RecordFormAction => ({ type: 'conflict', saved });

type Row = {
  name: string;
  init: RecordFormInit;
  actions: RecordFormAction[];
  status: RecordFormStatus;
  values: RecordDefinition;
  version: number | null;
  /** MC-10: the saved version and the changed fields' labels; `null` — no conflict block. */
  conflict?: { saved: number | null; fields: string[] } | null;
  error?: LibraryErrorText | null;
};

// Transitions of the editor's form (design-web.md, «State Transitions and Invariants»; Invariants 1, 2; DC-3, DC-4).
const rows: Row[] = [
  { name: 'opens clean on the saved record', init: edited, actions: [], status: 'clean', values: START, version: 3 },
  {
    name: 'typing the saved value back is no change',
    init: edited,
    actions: [input(TYPED), input(START)],
    status: 'clean',
    values: START,
    version: 3,
  },
  {
    name: 'save carries the version the edit started from',
    init: edited,
    actions: [input(TYPED), { type: 'save' }],
    status: 'saving',
    values: TYPED,
    version: 3,
  },
  {
    name: 'typing a new value is a change, and a field error keeps the typed values (Invariant 1)',
    init: edited,
    actions: [input(TYPED), { type: 'save' }, { type: 'failed', error: NAME_TAKEN }],
    status: 'changed',
    values: TYPED,
    version: 3,
    error: NAME_TAKEN,
  },
  {
    name: 'a conflict keeps the typed values and names the fields version 4 changed against version 3 (Flow 1)',
    init: edited,
    actions: [input(TYPED), { type: 'save' }, conflictWith(theirsV4)],
    status: 'conflict',
    values: TYPED,
    version: 3,
    conflict: { saved: 4, fields: ['Описание'] },
  },
  {
    name: 'a conflict whose saved record was not read has no fields',
    init: edited,
    actions: [input(TYPED), { type: 'save' }, conflictWith(null)],
    status: 'conflict',
    values: TYPED,
    version: 3,
    conflict: { saved: null, fields: [] },
  },
  {
    name: '«Сохранить мои правки» saves the typed values with the version accepted in the conflict (Invariant 2)',
    init: edited,
    actions: [input(TYPED), { type: 'save' }, conflictWith(theirsV4), { type: 'saveMine' }],
    status: 'saving',
    values: TYPED,
    version: 4,
    conflict: null,
  },
  {
    name: '«Сохранить мои правки» without the saved record sends the edit\'s own version again',
    init: edited,
    actions: [input(TYPED), { type: 'save' }, conflictWith(null), { type: 'saveMine' }],
    status: 'saving',
    values: TYPED,
    version: 3,
  },
  {
    name: '«Взять сохранённое» puts version 4 into the form (DC-3)',
    init: edited,
    actions: [input(TYPED), { type: 'save' }, conflictWith(theirsV4), { type: 'takeSaved' }],
    status: 'clean',
    values: THEIRS,
    version: 4,
    conflict: null,
  },
  {
    name: '«Вернуть» puts the typed values back over version 4 (DC-3)',
    init: edited,
    actions: [input(TYPED), { type: 'save' }, conflictWith(theirsV4), { type: 'takeSaved' }, { type: 'restore' }],
    status: 'changed',
    values: TYPED,
    version: 4,
  },
  {
    name: 'a saved answer makes its version the saved one',
    init: edited,
    actions: [input(TYPED), { type: 'save' }, { type: 'saved', record: savedV4 }],
    status: 'saved',
    values: TYPED,
    version: 4,
  },
  {
    name: 'typing after «Сохранено» is a change again',
    init: edited,
    actions: [input(TYPED), { type: 'save' }, { type: 'saved', record: savedV4 }, input(START)],
    status: 'changed',
    values: START,
    version: 4,
  },
  {
    name: '«Отменить изменения» returns the saved values',
    init: edited,
    actions: [input(TYPED), { type: 'discard' }],
    status: 'clean',
    values: START,
    version: 3,
  },
  {
    name: '«Вернуть» after «Отменить изменения» brings the typed values back',
    init: edited,
    actions: [input(TYPED), { type: 'discard' }, { type: 'restore' }],
    status: 'changed',
    values: TYPED,
    version: 3,
  },
  {
    name: '«Взять новую версию» changes only the form (DC-4)',
    init: { saved: workflowV2 },
    actions: [{ type: 'takeNewVersion', index: 0, executor: analystNewVersion }],
    status: 'changed',
    values: WORKFLOW_NEW_EXECUTOR,
    version: 2,
  },
  {
    name: 'a new record opened from a draft has changes and no version',
    init: { blank: agent(''), values: TYPED },
    actions: [],
    status: 'changed',
    values: TYPED,
    version: null,
  },
];

describe('recordFormReducer', () => {
  it.each(rows)('$name', ({ init, actions, status, values, version, conflict, error }) => {
    const state = actions.reduce(recordFormReducer, initialRecordForm(init));
    const view = recordFormView(state);

    expect(view.status).toBe(status);
    expect(state.values).toEqual(values);
    expect(view.version).toBe(version);
    if (conflict !== undefined) {
      const shown = view.conflict && {
        saved: view.conflict.saved?.version ?? null,
        fields: view.conflict.fields.map((field) => changedFieldLabel(t, field)),
      };
      expect(shown).toEqual(conflict);
    }
    if (error !== undefined) expect(state.error).toEqual(error);
  });
});
