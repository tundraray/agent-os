"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon, Info, Plus } from "lucide-react";
import {
  EXECUTOR_MAX_RUNS_MAX,
  EXECUTOR_MAX_RUNS_MIN,
  RECORD_DESCRIPTION_MAX_LENGTH,
  RECORD_MAX_TURNS_MAX,
  RECORD_MAX_TURNS_MIN,
  RECORD_NAME_MAX_LENGTH,
  WORKFLOW_EXECUTORS_MAX,
  COORDINATOR_RULES_MAX_LENGTH,
  type RecordDetail,
  type WorkflowContent,
  type WorkflowExecutor,
} from "@agent-os/contracts";
import { CAPTION } from "@/components/admin/admin-form";
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "@/components/assistant-ui/elements/collapsible-root";
import { useShellServices } from "@/components/shell/shell-actions";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FieldDescription, FieldError, FieldLabel, Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { RecordDefinition } from "@/lib/library/record-rules";
import { executorFromSource, type AgentRecord } from "@/lib/library/update-workflows";
import { adminKnowledgePath, knowledgePath } from "@/lib/shell-route";
import { cn } from "cn";
import {
  MaxTurnsField,
  ModelField,
  TextField,
  validateRecordText,
  type EditorChoices,
  type EditorMode,
  type RecordDefaults,
} from "./agent-fields";
import { ExecutorItem } from "./executor-item";
import { ExecutorPanel, executorNameError, type ExecutorEditing } from "./executor-panel";
import { ExecutorPicker } from "./executor-picker";
import { SelfLearningField } from "./self-learning-field";
import { useInChat } from "./use-in-chat";

/** UXRD MC-12 (the editor of a workflow), MC-13 (the executor), MC-7 (name and description), MC-8, MC-19. */
const TEXT = {
  name: "Имя",
  description: "Описание",
  descriptionHint: "По описанию чат решает, когда звать workflow.",
  task: "Workflow получает только задание, которое вы подтверждаете перед запуском: вопрос, границы и результат. Беседу он не видит.",
  startInChat: "Проще начать в чате: опишите, что должен делать workflow, — чат соберёт команду.",
  describeInChat: "Описать в чате",
  // MC-1: the template of «Создать в чате» for a workflow.
  template: "Сделай workflow, который ",
  team: (count: number) => `Команда · ${count}`,
  teamHint: "Кого и когда звать, решает координатор по строкам команды.",
  teamLabel: "Команда",
  add: "Добавить",
  newExecutor: "Новый исполнитель",
  fromLibrary: "Из библиотеки…",
  emptyTitle: "Команды пока нет",
  // MC-8: a save with an empty team.
  addOne: "Добавьте хотя бы одного исполнителя",
  emptyText: "Добавьте исполнителей и у каждого напишите, за что он отвечает и когда его звать. Можно взять своего агента из библиотеки.",
  rules: "Как работает команда",
  optional: "необязательно",
  rulesHint: "Если важен порядок или кто кого ждёт — напишите здесь. Остальное координатор решит по строкам команды.",
  rulesPlaceholder: "Например: «Ответ» пишет сводку, когда вернутся «Сбор логов» и «Сбор тикетов».",
  notInTeam: (name: string) => `В команде нет «${name}»`,
  notMentioned: (name: string) => `«${name}» в правилах не упомянут — координатор позовёт его по строке команды`,
  oldName: (name: string) => `В правилах осталось старое имя «${name}»`,
  replaceInRules: "Заменить в правилах",
  finalExecutor: "Кто пишет ответ",
  coordinator: "Координатор сам",
  finalHint: "Отчёт этого исполнителя станет ответом workflow.",
  finalRemoved: (name: string) => `${name} убран из команды — ответ пишет координатор`,
  advanced: "Дополнительно: модель и максимум шагов координатора",
  coordinatorModel: "Модель координатора",
  coordinatorMaxTurns: "Максимум шагов координатора",
  enterRole: "Напишите, за что отвечает исполнитель и когда его звать",
  enterPrompt: "Введите инструкцию — откройте исполнителя",
  wholeNumber: (min: number, max: number) => `Нужно целое число от ${min} до ${max}`,
} as const;

export type WorkflowDefinition = Extract<RecordDefinition, { kind: "workflow" }>;

/** A field of the workflow's form; an executor's line and card are named by the executor. */
export type WorkflowField =
  | "name"
  | "description"
  | "team"
  | "rules"
  | "finalExecutor"
  | "coordinatorModel"
  | "coordinatorMaxTurns"
  | `role:${string}`
  | `executor:${string}`;

export type WorkflowFieldErrors = Partial<Record<WorkflowField, ReactNode>>;

const roleKey = (name: string): WorkflowField => `role:${name}`;
/** The key of an executor's card error. */
export const executorKey = (name: string): WorkflowField => `executor:${name}`;

const outside = (value: number, min: number, max: number): boolean => !Number.isInteger(value) || value < min || value > max;

/**
 * The checks before sending (MC-8, MC-12, MC-13): name and description as an agent's; a team of at least one;
 * every executor with its responsibility line; the coordinator's maximum of steps. Limits are the contract's.
 */
export function validateWorkflow(values: WorkflowDefinition): WorkflowFieldErrors {
  const errors: WorkflowFieldErrors = { ...validateRecordText(values) };
  const { executors, coordinator } = values.content;
  if (executors.length === 0) errors.team = TEXT.addOne;
  executors.forEach((executor, index) => {
    if (executor.role.trim() === "") errors[roleKey(executor.name)] = TEXT.enterRole;
    const others = executors.filter((_, other) => other !== index);
    const card =
      executorNameError(executor, others) ??
      (executor.prompt.trim() === "" ? TEXT.enterPrompt : undefined) ??
      (outside(executor.maxTurns, RECORD_MAX_TURNS_MIN, RECORD_MAX_TURNS_MAX)
        ? TEXT.wholeNumber(RECORD_MAX_TURNS_MIN, RECORD_MAX_TURNS_MAX)
        : undefined) ??
      (outside(executor.maxRuns, EXECUTOR_MAX_RUNS_MIN, EXECUTOR_MAX_RUNS_MAX)
        ? TEXT.wholeNumber(EXECUTOR_MAX_RUNS_MIN, EXECUTOR_MAX_RUNS_MAX)
        : undefined);
    if (card !== undefined) errors[executorKey(executor.name)] = card;
  });
  if (outside(coordinator.maxTurns, RECORD_MAX_TURNS_MIN, RECORD_MAX_TURNS_MAX)) {
    errors.coordinatorMaxTurns = TEXT.wholeNumber(RECORD_MAX_TURNS_MIN, RECORD_MAX_TURNS_MAX);
  }
  return errors;
}

/** The form of a new workflow (UXRD WF-01): an empty team, the coordinator on the author's default model. */
export function blankWorkflow({ defaultModel, defaultMaxTurns }: RecordDefaults): WorkflowDefinition {
  return {
    name: "",
    description: "",
    kind: "workflow",
    content: {
      coordinator: { rules: "", model: defaultModel, maxTurns: defaultMaxTurns },
      executors: [],
      finalExecutor: null,
      selfLearning: false,
    },
  };
}

/** A new executor from scratch, with the defaults of a new record. */
function blankExecutor({ defaultModel, defaultMaxTurns }: RecordDefaults): WorkflowExecutor {
  return {
    name: "",
    role: "",
    prompt: "",
    servers: [],
    model: defaultModel,
    maxTurns: defaultMaxTurns,
    maxRuns: EXECUTOR_MAX_RUNS_MIN,
    tools: [],
    source: null,
  };
}

export type WorkflowFieldsProps = {
  /** In mode `system` there is no «Описать в чате»: the chat never creates company records (AL-02). */
  mode: EditorMode;
  /** The saved record: its `executorSources` give each executor's source state; `null` while new. */
  saved: RecordDetail | null;
  values: WorkflowDefinition;
  onChange: (values: WorkflowDefinition, field: WorkflowField | null) => void;
  /** «Взять новую версию»: the form takes the executor's new copy; the record waits for «Сохранить» (DC-4). */
  onTakeNewVersion: (index: number, executor: WorkflowExecutor) => void;
  errors: WorkflowFieldErrors;
  choices: EditorChoices;
};

/** A rename made in the panel: the rules may still name the old one. */
type Rename = { from: string; to: string };

/**
 * The workflow's fields of the record editor (UXRD WF-01; record-editor.md, variant «Workflow»): name and
 * description, the MC-12 phrase about the task, the team in alphabetical order, «Как работает команда» with the
 * team's names marked, «Кто пишет ответ», «Самообучение» and the coordinator's settings under «Дополнительно». The team is a set:
 * no numbers, arrows or dragging. Text written by other employees is rendered as text only.
 */
export function WorkflowFields({ mode, saved, values, onChange, onTakeNewVersion, errors, choices }: WorkflowFieldsProps) {
  const id = useId();
  const { announcer } = useShellServices();
  const inChat = useInChat();
  const content = values.content;
  const { executors } = content;
  const [editing, setEditing] = useState<ExecutorEditing | null>(null);
  const [picking, setPicking] = useState(false);
  const [renames, setRenames] = useState<Rename[]>([]);
  const [removedFinal, setRemovedFinal] = useState<string | null>(null);
  const [dropped, setDropped] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const nameRefs = useRef(new Map<string, HTMLButtonElement>());
  const addRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const setContent = (next: Partial<WorkflowContent>, field: WorkflowField | null): void =>
    onChange({ ...values, content: { ...content, ...next } }, field);

  const sorted = executors
    .map((executor, index) => ({ executor, index }))
    .sort((a, b) => a.executor.name.localeCompare(b.executor.name, "ru"));
  const others = editing === null ? executors : executors.filter((_, index) => index !== editing.index);
  const advancedError = errors.coordinatorMaxTurns !== undefined || errors.coordinatorModel !== undefined;
  const offerChat = mode === "employee" && saved === null && executors.length === 0;

  const focusName = (name: string): void => {
    requestAnimationFrame(() => nameRefs.current.get(name)?.focus());
  };

  const openEditor = (index: number): void => {
    const executor = executors[index];
    if (executor === undefined) return;
    returnFocus.current = nameRefs.current.get(executor.name) ?? null;
    setEditing({ executor, index });
  };

  const openNew = (executor: WorkflowExecutor, nameError?: string): void => {
    returnFocus.current = addRef.current;
    setEditing({ executor, index: null, nameError });
  };

  const done = (executor: WorkflowExecutor): void => {
    if (editing === null) return;
    if (editing.index === null) {
      setContent({ executors: [...executors, executor] }, "team");
    } else {
      const previous = editing.executor.name;
      const renamed = previous !== executor.name;
      const next = executors.map((item, index) => (index === editing.index ? executor : item));
      setContent(
        {
          executors: next,
          finalExecutor: renamed && content.finalExecutor === previous ? executor.name : content.finalExecutor,
        },
        executorKey(previous),
      );
      if (renamed) setRenames((current) => [...current.filter((item) => item.to !== previous), { from: previous, to: executor.name }]);
      returnFocus.current = null;
      focusName(executor.name);
    }
    setEditing(null);
  };

  const remove = (index: number): void => {
    const executor = executors[index];
    if (executor === undefined) return;
    const wasFinal = content.finalExecutor === executor.name;
    setContent(
      { executors: executors.filter((_, other) => other !== index), finalExecutor: wasFinal ? null : content.finalExecutor },
      executorKey(executor.name),
    );
    if (wasFinal) setRemovedFinal(executor.name);
    addRef.current?.focus();
  };

  const takeNewVersion = (index: number, agent: AgentRecord): void => {
    const current = executors[index];
    if (current === undefined) return;
    const taken = executorFromSource(current, agent, choices.servers);
    onTakeNewVersion(index, taken.executor);
    setDropped((map) => new Map(map).set(current.name, taken.dropped));
    announcer.getState().announce("announce.tookNewVersion", { name: current.name });
    focusName(current.name);
  };

  const picked = (executor: WorkflowExecutor, droppedServers: string[]): void => {
    setPicking(false);
    setDropped((map) => new Map(map).set(executor.name, droppedServers));
    const nameError = executorNameError(executor, executors);
    // WF-02: a taken name opens the panel with the name's error; otherwise the copy joins the team at once.
    if (nameError !== undefined) {
      openNew(executor, nameError);
      return;
    }
    setContent({ executors: [...executors, executor] }, "team");
    focusName(executor.name);
  };

  return (
    <>
      <TextField
        id={`${id}-name`}
        label={TEXT.name}
        value={values.name}
        max={RECORD_NAME_MAX_LENGTH}
        error={errors.name}
        onChange={(name) => onChange({ ...values, name }, "name")}
      />
      <TextField
        id={`${id}-description`}
        label={TEXT.description}
        hint={TEXT.descriptionHint}
        value={values.description}
        max={RECORD_DESCRIPTION_MAX_LENGTH}
        // MC-8 names an over-long description, so it may be typed past the limit and is refused on save.
        enforceMax={false}
        multiline
        error={errors.description}
        onChange={(description) => onChange({ ...values, description }, "description")}
      />
      <p className={cn(CAPTION, "flex items-start gap-1.5 text-foreground")}>
        <Info aria-hidden className="mt-px size-3.5 shrink-0 text-info" />
        {TEXT.task}
      </p>
      {offerChat && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-info-border bg-info-subtle px-3 py-2">
          <p className="text-sm leading-5 text-foreground">{TEXT.startInChat}</p>
          <Button type="button" variant="outline" size="sm" className="pointer-coarse:h-11" onClick={() => inChat({ text: TEXT.template })}>
            {TEXT.describeInChat}
          </Button>
        </div>
      )}
      <section aria-labelledby={`${id}-team`} className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 id={`${id}-team`} className="text-sm leading-5 font-medium">
            {TEXT.team(executors.length)}
          </h2>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  ref={addRef}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={executors.length >= WORKFLOW_EXECUTORS_MAX}
                  aria-invalid={errors.team !== undefined}
                  aria-describedby={errors.team === undefined ? undefined : `${id}-team-error`}
                  className="pointer-coarse:h-11"
                />
              }
            >
              <Plus aria-hidden />
              {TEXT.add}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-45">
              <DropdownMenuItem onClick={() => openNew(blankExecutor(choices))}>{TEXT.newExecutor}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPicking(true)}>{TEXT.fromLibrary}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p className={cn(CAPTION, "text-muted-foreground")}>{TEXT.teamHint}</p>
        {executors.length === 0 ? (
          <div
            id={`${id}-team-error`}
            role={errors.team === undefined ? undefined : "alert"}
            className={cn(
              "flex flex-col gap-1 rounded-lg border border-dashed px-3 py-3",
              errors.team === undefined ? "border-border" : "border-destructive",
            )}
          >
            <p className="text-sm leading-5 font-medium">{TEXT.emptyTitle}</p>
            <p className={cn(CAPTION, "text-muted-foreground")}>{TEXT.emptyText}</p>
            {errors.team !== undefined && <p className={cn(CAPTION, "text-destructive")}>{errors.team}</p>}
          </div>
        ) : (
          <ul aria-label={TEXT.teamLabel} className="flex flex-col gap-2">
            {sorted.map(({ executor, index }) => (
              <ExecutorItem
                key={`${index}-${executor.name}`}
                executor={executor}
                final={content.finalExecutor === executor.name}
                sourceState={saved?.executorSources.find(
                  (state) => state.executor === executor.name && state.recordId === executor.source?.recordId,
                )}
                allowedServers={choices.servers}
                roleError={errors[roleKey(executor.name)]}
                cardError={errors[executorKey(executor.name)]}
                dropped={dropped.get(executor.name) ?? []}
                nameRef={(element) => {
                  if (element === null) nameRefs.current.delete(executor.name);
                  else nameRefs.current.set(executor.name, element);
                }}
                onEdit={() => openEditor(index)}
                onRemove={() => remove(index)}
                onTakeNewVersion={(agent) => takeNewVersion(index, agent)}
                onRoleChange={(role) =>
                  setContent(
                    { executors: executors.map((item, other) => (other === index ? { ...item, role } : item)) },
                    roleKey(executor.name),
                  )
                }
              />
            ))}
          </ul>
        )}
      </section>
      <RulesField
        id={`${id}-rules`}
        rules={content.coordinator.rules}
        names={executors.map((executor) => executor.name)}
        renames={renames}
        error={errors.rules}
        onChange={(rules) => setContent({ coordinator: { ...content.coordinator, rules } }, "rules")}
        onReplaced={(rename) => setRenames((current) => current.filter((item) => item !== rename))}
      />
      <FinalExecutorField
        id={`${id}-final`}
        value={content.finalExecutor}
        names={sorted.map(({ executor }) => executor.name)}
        removed={content.finalExecutor === null ? removedFinal : null}
        onChange={(finalExecutor) => {
          setRemovedFinal(null);
          setContent({ finalExecutor }, "finalExecutor");
        }}
      />
      <SelfLearningField
        checked={content.selfLearning}
        savedOn={saved?.kind === "workflow" && saved.content.selfLearning}
        knowledgeHref={saved === null ? null : mode === "employee" ? knowledgePath(saved.id) : adminKnowledgePath(saved.id)}
        onChange={(selfLearning) => setContent({ selfLearning }, null)}
      />
      <CollapsibleRoot open={advancedOpen || advancedError} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="group/advanced -ml-2.5 h-auto min-h-7 text-left whitespace-normal text-sm pointer-coarse:min-h-11"
            />
          }
        >
          <ChevronRightIcon
            aria-hidden
            className="transition-transform duration-150 group-aria-expanded/advanced:rotate-90 motion-reduce:transition-none"
          />
          {TEXT.advanced}
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-5 pt-3">
          <ModelField
            id={`${id}-coordinator-model`}
            label={TEXT.coordinatorModel}
            model={content.coordinator.model}
            choices={choices}
            error={errors.coordinatorModel}
            onChange={(model) => setContent({ coordinator: { ...content.coordinator, model } }, "coordinatorModel")}
          />
          <MaxTurnsField
            id={`${id}-coordinator-max-turns`}
            label={TEXT.coordinatorMaxTurns}
            hint={null}
            value={content.coordinator.maxTurns}
            error={errors.coordinatorMaxTurns}
            onChange={(maxTurns) => setContent({ coordinator: { ...content.coordinator, maxTurns } }, "coordinatorMaxTurns")}
          />
        </CollapsibleContent>
      </CollapsibleRoot>
      <ExecutorPanel
        editing={editing}
        others={others}
        choices={choices}
        returnFocus={returnFocus}
        onDone={done}
        onClose={() => setEditing(null)}
      />
      <ExecutorPicker open={picking} onOpenChange={setPicking} allowedServers={choices.servers} onPicked={picked} />
    </>
  );
}

const lower = (text: string): string => text.toLocaleLowerCase("ru");
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Segment = { text: string; name: boolean };

/** The rules split into plain text and the team's names, so the names can be marked behind the field. */
function segmentsOf(text: string, names: readonly string[]): Segment[] {
  const needles = names.filter((name) => name.trim() !== "").sort((a, b) => b.length - a.length);
  if (needles.length === 0) return [{ text, name: false }];
  const pattern = new RegExp(`(${needles.map(escapeRegExp).join("|")})`, "giu");
  return text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part) => ({ text: part, name: needles.some((name) => lower(name) === lower(part)) }));
}

/** Names the rules quote in «…». */
function quotedNames(text: string): string[] {
  return [...new Set([...text.matchAll(/«([^«»\n]+)»/gu)].map((match) => match[1].trim()).filter((name) => name !== ""))];
}

type RulesFieldProps = {
  id: string;
  rules: string;
  names: readonly string[];
  renames: readonly Rename[];
  error: ReactNode;
  onChange: (rules: string) => void;
  onReplaced: (rename: Rename) => void;
};

/**
 * «Как работает команда» (record-editor.md, «Правила команды»): optional text; the team's names are marked
 * behind the text (the marks change nothing for a screen reader), and the notes under the field name a quoted
 * name the team lacks, a member the rules never mention, and an old name after a rename with «Заменить в
 * правилах». The notes are the field's description; they never stop a save.
 */
function RulesField({ id, rules, names, renames, error, onChange, onReplaced }: RulesFieldProps) {
  const hintId = `${id}-hint`;
  const notesId = `${id}-notes`;
  const errorId = `${id}-error`;
  const team = names.map(lower);
  const mentions = lower(rules);
  const stale = renames.filter((rename) => mentions.includes(lower(rename.from)) && !team.includes(lower(rename.from)));
  const staleNames = stale.map((rename) => lower(rename.from));
  const strangers = quotedNames(rules).filter((name) => !team.includes(lower(name)) && !staleNames.includes(lower(name)));
  const unmentioned = rules.trim() === "" ? [] : names.filter((name) => name.trim() !== "" && !mentions.includes(lower(name)));
  const notes: ReactNode[] = [
    ...strangers.map((name) => <Note key={`stranger-${name}`}>{TEXT.notInTeam(name)}</Note>),
    ...unmentioned.map((name) => <Note key={`unmentioned-${name}`}>{TEXT.notMentioned(name)}</Note>),
    ...stale.map((rename) => (
      <Note key={`stale-${rename.from}`}>
        {TEXT.oldName(rename.from)}{" "}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs pointer-coarse:min-h-11"
          onClick={() => {
            onChange(rules.replace(new RegExp(escapeRegExp(rename.from), "giu"), rename.to));
            onReplaced(rename);
          }}
        >
          {TEXT.replaceInRules}
        </Button>
      </Note>
    )),
  ];
  // The text of a name stays where the field draws it: the marks lie behind the field, with the same box and font.
  const box = "rounded-lg border px-2.5 py-2 text-base md:text-sm pointer-coarse:text-base min-h-24 whitespace-pre-wrap break-words";

  return (
    <Field data-invalid={error !== undefined} className="gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <FieldLabel htmlFor={id} className="text-sm leading-5 font-medium text-foreground">
          {TEXT.rules} <span className="font-normal text-muted-foreground">· {TEXT.optional}</span>
        </FieldLabel>
        <span aria-hidden className={cn(CAPTION, "text-muted-foreground tabular-nums")}>
          {`${rules.length} / ${COORDINATOR_RULES_MAX_LENGTH}`}
        </span>
      </div>
      <div className="relative">
        <div aria-hidden className={cn(box, "pointer-events-none absolute inset-0 overflow-hidden border-transparent text-transparent")}>
          {segmentsOf(rules, names).map((segment, index) =>
            segment.name ? (
              <mark key={index} className="rounded-sm bg-muted text-transparent">
                {segment.text}
              </mark>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
          {/* A trailing line break needs a character after it to take its height. */}{" "}
        </div>
        <Textarea
          id={id}
          name={id}
          value={rules}
          maxLength={COORDINATOR_RULES_MAX_LENGTH}
          placeholder={TEXT.rulesPlaceholder}
          aria-invalid={error !== undefined}
          aria-describedby={[hintId, notes.length > 0 ? notesId : null, error === undefined ? null : errorId].filter((part) => part !== null).join(" ")}
          className={cn(box, "relative bg-transparent dark:bg-transparent")}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <FieldDescription id={hintId} className={cn(CAPTION, "text-muted-foreground")}>
        {TEXT.rulesHint}
      </FieldDescription>
      {notes.length > 0 && (
        <div id={notesId} className="flex flex-col gap-1">
          {notes}
        </div>
      )}
      <FieldError id={errorId} className={CAPTION}>
        {error}
      </FieldError>
    </Field>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className={cn(CAPTION, "flex flex-wrap items-center gap-x-1.5 text-foreground")}>
      <Info aria-hidden className="size-3.5 shrink-0 text-info" />
      {children}
    </p>
  );
}

/** «Координатор сам» in the select: executor names are never empty, so the empty value cannot be a name. */
const COORDINATOR_VALUE = "";

type FinalExecutorFieldProps = {
  id: string;
  value: string | null;
  names: readonly string[];
  /** The removed executor that wrote the answer: the field went to «Координатор сам» and says so. */
  removed: string | null;
  onChange: (finalExecutor: string | null) => void;
};

/** «Кто пишет ответ»: the one place where the last step is chosen; the card's mark only shows the choice. */
function FinalExecutorField({ id, value, names, removed, onChange }: FinalExecutorFieldProps) {
  const hintId = `${id}-hint`;
  const noteId = `${id}-note`;
  const items = [{ value: COORDINATOR_VALUE, label: TEXT.coordinator }, ...names.map((name) => ({ value: name, label: name }))];
  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={id} className="text-sm leading-5 font-medium text-foreground">
        {TEXT.finalExecutor}
      </FieldLabel>
      <Select
        value={value ?? COORDINATOR_VALUE}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next === COORDINATOR_VALUE ? null : next);
        }}
        items={items}
      >
        <SelectTrigger
          id={id}
          className="w-full max-w-90 pointer-coarse:h-11"
          aria-describedby={removed === null ? hintId : `${hintId} ${noteId}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} className="pointer-coarse:min-h-11">
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription id={hintId} className={cn(CAPTION, "text-muted-foreground")}>
        {TEXT.finalHint}
      </FieldDescription>
      {removed !== null && (
        <div id={noteId}>
          <Note>{TEXT.finalRemoved(removed)}</Note>
        </div>
      )}
    </Field>
  );
}
