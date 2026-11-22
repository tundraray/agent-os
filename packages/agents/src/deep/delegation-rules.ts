import { TRACKER_MAX_TASKS } from '@agent-os/runtime';

import { descriptionLine } from '../chat-listing';
import { decideTaskChange, type TaskListState } from '../tools/system/task-list-rules';

/** The longest result table of a list delegation, in characters (deep-agents/design-task.md KD-5). */
export const TASK_TABLE_MAX_CHARS = 20_000;

/** The longest item a row of a cut table shows: the full table keeps every item whole. */
const CUT_ITEM_MAX_CHARS = 100;

/** A field of the answer a delegation asks for (KD-7). */
export interface AnswerField {
  readonly name: string;
  readonly description: string;
}

/** The arguments of a `task` call, as its schema checked them. */
export interface TaskArgs {
  readonly subagentType: string;
  readonly description?: string | undefined;
  readonly instruction?: string | undefined;
  readonly items?: readonly string[] | undefined;
  readonly answerFields?: readonly AnswerField[] | undefined;
  readonly taskId?: number | undefined;
}

/** A `task` call of the model's answer. */
export interface DelegationCall {
  readonly callId: string;
  readonly args: TaskArgs;
}

/** What one `task` call hands its subagents: one assignment, or one instruction with an item per subagent. */
export type DelegationForm =
  | { readonly kind: 'single'; readonly description: string }
  | { readonly kind: 'list'; readonly instruction: string; readonly items: readonly string[] };

/** A subagent the deep agent may call, with the most single assignments it may get. */
export interface DelegationTeamMember {
  readonly name: string;
  readonly maxRuns: number;
}

export interface DelegationInput {
  /** The `task` calls of one answer, in answer order. */
  readonly calls: readonly DelegationCall[];
  /** The deep agent's subagents and `general-purpose`. */
  readonly team: readonly DelegationTeamMember[];
  /** Single assignments each subagent got before this answer; list items do not count (KD-6). */
  readonly singleRuns: ReadonlyMap<string, number>;
  /** The deep agent's task list; `null` — it keeps none. */
  readonly tasks: TaskListState | null;
  /** A subagent would be deeper than `AGENT_MAX_DEPTH`. */
  readonly childTooDeep: boolean;
}

/** An accepted call: whom it starts, with what, and the task of the list it names. */
export interface AcceptedDelegation {
  readonly callId: string;
  readonly subagent: string;
  readonly form: DelegationForm;
  readonly answerFields: readonly AnswerField[];
  /** The number of the task of the list the subagents work on; `null` — none named. */
  readonly listTask: number | null;
}

/** A refused call: nothing starts; the text names the field and the rule, `rule` goes to the log. */
export interface RefusedDelegation {
  readonly callId: string;
  readonly reason: 'not_allowed' | 'run_limit' | 'invalid_arguments' | 'depth_limit';
  readonly rule: string;
  readonly text: string;
}

export interface DelegationDecision {
  readonly accepted: readonly AcceptedDelegation[];
  readonly refused: readonly RefusedDelegation[];
}

/** How many subagents an accepted form starts. */
function taskCountOf(form: DelegationForm): number {
  return form.kind === 'single' ? 1 : form.items.length;
}

function refusal(
  callId: string,
  reason: RefusedDelegation['reason'],
  rule: string,
  text: string,
): RefusedDelegation {
  return { callId, reason, rule, text };
}

/** The form the arguments give, or the refusal of forms mixed, missing or half given. */
function formOf(call: DelegationCall): DelegationForm | RefusedDelegation {
  const { description, instruction, items } = call.args;
  if (description !== undefined && (instruction !== undefined || items !== undefined)) {
    return refusal(
      call.callId,
      'invalid_arguments',
      'forms_mixed',
      'description: give either description for one assignment, or instruction with items for a list, not both.',
    );
  }
  if (description !== undefined) return { kind: 'single', description };
  if (instruction === undefined || items === undefined) {
    return refusal(
      call.callId,
      'invalid_arguments',
      'no_form',
      instruction === undefined && items === undefined
        ? 'description: give description for one assignment, or instruction with items for a list.'
        : 'instruction: instruction and items go together.',
    );
  }
  if (items.length === 0) {
    return refusal(call.callId, 'invalid_arguments', 'list_empty', 'items: the list is empty.');
  }
  if (items.length > TRACKER_MAX_TASKS) {
    return refusal(
      call.callId,
      'invalid_arguments',
      'list_too_long',
      `items: ${items.length} items, more than the limit of ${TRACKER_MAX_TASKS} items in one call.`,
    );
  }
  return { kind: 'list', instruction, items };
}

/** A field name given twice, if any. */
function repeatedField(fields: readonly AnswerField[]): string | undefined {
  const names = fields.map((field) => field.name);
  return names.find((name, index) => names.indexOf(name) !== index);
}

/** The refusal of a task of the list the call may not work on, or `null`. */
function listTaskRefusal(
  call: DelegationCall,
  taskId: number,
  tasks: TaskListState | null,
  namedTwice: boolean,
  subagent: string,
): RefusedDelegation | null {
  const refuse = (rule: string, text: string) => refusal(call.callId, 'invalid_arguments', rule, `taskId: ${text}`);
  if (tasks === null) return refuse('no_task_list', 'you keep no task list.');
  if (namedTwice) return refuse('task_named_twice', `task ${taskId} is named by another task call of this answer.`);
  const task = tasks.tasks.find((candidate) => candidate.number === taskId);
  if (task?.status === 'completed') return refuse('task_completed', `task ${taskId} is completed already.`);
  const change = decideTaskChange(tasks, {
    tool: 'update',
    args: { taskId, status: 'in_progress', owner: subagent },
  });
  return change.kind === 'refused' ? refuse(change.rule, change.text) : null;
}

/**
 * The `task` calls of one answer, checked together (deep-agents/design-task.md KD-4 – KD-6, KD-8, Contract
 * «Инструмент `task`»; pure-decision.md). Each call is refused with a text that names the field and the rule —
 * a subagent outside the team (`not_allowed`), its `maxRuns` of single assignments spent (`run_limit`; list
 * items never count), forms mixed or missing, a list empty or longer than `TRACKER_MAX_TASKS`, a repeated
 * answer field, a task of the list that is missing, completed, blocked or named by another call of the answer,
 * the calls of the answer together over `TRACKER_MAX_TASKS`, a subagent past `AGENT_MAX_DEPTH`
 * (`depth_limit`) — or accepted with what it starts. A refused call starts nothing.
 */
export function decideDelegations(input: DelegationInput): DelegationDecision {
  const accepted: AcceptedDelegation[] = [];
  const refused: RefusedDelegation[] = [];
  const singleRuns = new Map(input.singleRuns);
  const named = input.calls.flatMap((call) => (call.args.taskId === undefined ? [] : [call.args.taskId]));
  let tasksStarted = 0;

  for (const call of input.calls) {
    const decision = decideOne(call);
    if ('reason' in decision) refused.push(decision);
    else {
      accepted.push(decision);
      tasksStarted += taskCountOf(decision.form);
      if (decision.form.kind === 'single') {
        singleRuns.set(decision.subagent, (singleRuns.get(decision.subagent) ?? 0) + 1);
      }
    }
  }
  return { accepted, refused };

  function decideOne(call: DelegationCall): AcceptedDelegation | RefusedDelegation {
    const { subagentType: subagent, taskId } = call.args;
    if (input.childTooDeep) {
      return refusal(call.callId, 'depth_limit', 'depth_limit', 'A subagent here would be deeper than agents may go.');
    }
    const member = input.team.find((candidate) => candidate.name === subagent);
    if (member === undefined) {
      const names = input.team.map((candidate) => candidate.name).join(', ');
      return refusal(
        call.callId,
        'not_allowed',
        'unknown_subagent',
        `subagentType: there is no subagent "${descriptionLine(subagent)}"; call one of: ${names}.`,
      );
    }
    const form = formOf(call);
    if ('reason' in form) return form;
    const runs = singleRuns.get(subagent) ?? 0;
    if (form.kind === 'single' && runs >= member.maxRuns) {
      return refusal(
        call.callId,
        'run_limit',
        'max_runs',
        `subagentType: ${subagent} got ${runs} single assignments, the most it may get (${member.maxRuns}); give the work to another subagent.`,
      );
    }
    const answerFields = call.args.answerFields ?? [];
    const repeated = repeatedField(answerFields);
    if (repeated !== undefined) {
      return refusal(
        call.callId,
        'invalid_arguments',
        'field_repeated',
        `answerFields: the field "${descriptionLine(repeated)}" is named twice.`,
      );
    }
    if (taskId !== undefined) {
      const namedTwice = named.filter((number) => number === taskId).length > 1;
      const listRefusal = listTaskRefusal(call, taskId, input.tasks, namedTwice, subagent);
      if (listRefusal !== null) return listRefusal;
    }
    if (tasksStarted + taskCountOf(form) > TRACKER_MAX_TASKS) {
      return refusal(
        call.callId,
        'invalid_arguments',
        'answer_too_many_tasks',
        `items: the task calls of one answer start at most ${TRACKER_MAX_TASKS} subagents together; this one would make ${tasksStarted + taskCountOf(form)}.`,
      );
    }
    return { callId: call.callId, subagent, form, answerFields, listTask: taskId ?? null };
  }
}

/** How one subagent of a list ended, as its row shows it. */
export interface TableRow {
  readonly item: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  /** The subagent's last message of a completed task. */
  readonly answer: string | null;
  /** Why a task failed. */
  readonly reason: string | null;
}

/** A table cell: one line, without the column bar. */
function cell(text: string): string {
  return descriptionLine(text).replaceAll('|', '¦');
}

/** A cell cut to `max` characters, the cut marked. */
function cutCell(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 0 ? '' : `${text.slice(0, max - 1)}…`;
}

/** A field's value as a cell reads it: a string as is, anything else as JSON. */
function valueText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The answer's cells: the whole answer, or the value of each field of its JSON object. */
function answerCells(row: TableRow, fields: readonly string[]): string[] {
  if (fields.length === 0) return [cell(row.answer ?? row.reason ?? '')];
  if (row.answer === null) return [...fields.map(() => ''), cell(row.reason ?? '')];
  try {
    const parsed: unknown = JSON.parse(row.answer);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const values = parsed as Record<string, unknown>;
      return [...fields.map((field) => cell(valueText(values[field]))), ''];
    }
  } catch {
    // Not an object of the fields: the whole answer stands in the first field's cell.
  }
  return [cell(row.answer), ...fields.slice(1).map(() => ''), ''];
}

function line(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function render(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

/**
 * The result of a list delegation (KD-5, Contract «Инструмент `task`»; pure-decision.md): a table of number,
 * item, status and the answer or the reason — with answer fields, a column per field and one for the reason.
 * A table longer than `maxChars` keeps every row: each answer cell is cut to an equal share and the items to
 * a line, and a last line says the full table is read with `read_tool_result` by the call's id. `full` is the
 * whole table, stored when it is cut.
 */
export function resultTable(input: {
  readonly rows: readonly TableRow[];
  readonly answerFields: readonly string[];
  readonly callId: string;
  readonly maxChars: number;
}): { readonly text: string; readonly full: string; readonly cut: boolean } {
  const { rows, answerFields, callId, maxChars } = input;
  const header = [
    '#',
    'Item',
    'Status',
    ...(answerFields.length === 0 ? ['Answer or reason'] : [...answerFields.map(cell), 'Reason']),
  ];
  const lead = (row: TableRow, index: number, item: string) => [String(index + 1), item, row.status];
  const answers = rows.map((row) => answerCells(row, answerFields));
  const full = render(
    header,
    rows.map((row, index) => [...lead(row, index, cell(row.item)), ...(answers[index] ?? [])]),
  );
  if (full.length <= maxChars) return { text: full, full, cut: false };

  const footer = `The table is cut to ${maxChars} characters: each answer is shortened. Read the full table with read_tool_result (callId "${callId}").`;
  const items = rows.map((row) => cutCell(cell(row.item), CUT_ITEM_MAX_CHARS));
  const skeleton = render(
    header,
    rows.map((row, index) => [...lead(row, index, items[index] ?? ''), ...(answers[index] ?? []).map(() => '')]),
  );
  const cells = answers.reduce((sum, row) => sum + row.length, 0);
  const share = Math.max(0, Math.floor((maxChars - skeleton.length - footer.length - 1) / Math.max(1, cells)));
  const table = render(
    header,
    rows.map((row, index) => [
      ...lead(row, index, items[index] ?? ''),
      ...(answers[index] ?? []).map((text) => cutCell(text, share)),
    ]),
  );
  return { text: `${table}\n${footer}`, full, cut: true };
}
