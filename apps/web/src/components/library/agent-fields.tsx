"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, ChevronRightIcon, X } from "lucide-react";
import { useStore } from "zustand";
import {
  ALL_SERVERS,
  CreateRecordBodySchema,
  RECORD_DESCRIPTION_MAX_LENGTH,
  RECORD_MAX_TURNS_MAX,
  RECORD_MAX_TURNS_MIN,
  RECORD_NAME_MAX_LENGTH,
  RECORD_PROMPT_MAX_LENGTH,
  type AgentContent,
  type RecordSummary,
} from "@agent-os/contracts";
import { CAPTION, FormWarning } from "@/components/admin/admin-form";
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "@/components/assistant-ui/elements/collapsible-root";
import { useShellServices } from "@/components/shell/shell-actions";
import { StateBadge } from "@/components/state-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatModel } from "@/lib/agents/format";
import type { RecordDefinition } from "@/lib/library/record-rules";
import { cn } from "cn";
import { RecordLabel } from "./record-label";

/** UXRD MC-7 (fields), MC-8 (errors), MC-9 (marks and the model banner). */
const TEXT = {
  name: "Имя",
  description: "Описание",
  descriptionHint: "По описанию чат решает, когда звать агента.",
  prompt: "Инструкция",
  promptHint: "Что агент делает и как. Он видит только этот текст и своё поручение.",
  servers: "Системы",
  serversHint: "Агент получит инструменты только тех систем, к которым есть доступ у запустившего.",
  lostServer: "у вас недоступна",
  lostServerRest: "останется и будет работать у тех, у кого есть доступ",
  // MC-9, the administrator on a company record.
  allServers: "Все системы",
  allServersHint: "Агент получит все системы, в том числе подключённые позже.",
  advanced: "Дополнительно: модель, максимум шагов, кого может запускать",
  model: "Модель",
  modelHint: "Сильнее модель — дольше и дороже. Для большинства задач хватит модели по умолчанию.",
  lostModel: "у вас недоступна",
  maxTurns: "Максимум шагов",
  maxTurnsHint: "Сколько шагов агент делает за один запуск. Дойдя до предела, он останавливается и отдаёт то, что успел.",
  agents: "Может запускать",
  findAgent: "Найти агента",
  noAgents: "Агентов не нашли",
  agentGone: "агент недоступен",
  modelGone: (model: string) => `Модель ${formatModel(model)} вам больше недоступна — агент не запустится`,
  noModels: (model: string) => `Модель ${formatModel(model)} вам недоступна, а других моделей у вас нет — агент не запустится`,
  replaceModel: (model: string) => `Заменить на ${formatModel(model)}`,
  enterName: "Введите имя",
  // Not in MC-8: the contract's name rule refuses control characters, which MC-8 has no text for.
  oneLineName: "Имя — одной строкой, без управляющих символов",
  // Not in MC-8: the contract requires a description, and MC-8 names only its length.
  enterDescription: "Введите описание",
  descriptionTooLong: `Описание длиннее ${RECORD_DESCRIPTION_MAX_LENGTH} знаков`,
  enterPrompt: "Введите инструкцию",
  wholeNumber: `Нужно целое число от ${RECORD_MAX_TURNS_MIN} до ${RECORD_MAX_TURNS_MAX}`,
} as const;

export type AgentDefinition = Extract<RecordDefinition, { kind: "agent" }>;

export type AgentField = "name" | "description" | "prompt" | "servers" | "model" | "maxTurns" | "agents";

export type AgentFieldErrors = Partial<Record<AgentField, string>>;

/**
 * `employee` — the owner in the library; `system` — the administrator on a company record in the panel:
 * the whole registry with «Все системы», the whole model catalogue, no owner's phrases (record-editor.md).
 */
export type EditorMode = "employee" | "system";

/**
 * What the author may choose from: their systems and models, and the model and «Максимум шагов» of a new
 * record. In mode `system` — the registry, the catalogue and the platform's default model.
 */
export type EditorChoices = {
  servers: readonly string[];
  /** The author's models by name; `undefined` while they are not read (or the read failed). */
  models: readonly { model: string; name: string }[] | undefined;
  defaultModel: string;
  /** Set by an administrator in the panel's «Агенты и workflow». */
  defaultMaxTurns: number;
};

/** What a new record or a new executor starts with (`GET /api/library/choices`). */
export type RecordDefaults = Pick<EditorChoices, "defaultModel" | "defaultMaxTurns">;

/** The name rule is the contract's own schema of a record name, never an expression of the web. */
const RecordNameSchema = CreateRecordBodySchema.options[0].shape.name;

/** Fields the advanced part holds: an error at one of them unfolds it. */
const ADVANCED_FIELDS: readonly AgentField[] = ["model", "maxTurns", "agents"];

/** The checks of a record's name and description, the same for both kinds (MC-8). */
export function validateRecordText(values: { name: string; description: string }): Partial<Record<"name" | "description", string>> {
  const errors: Partial<Record<"name" | "description", string>> = {};
  if (values.name.trim() === "") errors.name = TEXT.enterName;
  else if (!RecordNameSchema.safeParse(values.name).success) errors.name = TEXT.oneLineName;
  const description = values.description.trim();
  if (description === "") errors.description = TEXT.enterDescription;
  else if (description.length > RECORD_DESCRIPTION_MAX_LENGTH) errors.description = TEXT.descriptionTooLong;
  return errors;
}

/** The checks before sending (MC-8); limits are the contract's named constants. */
export function validateAgent(values: AgentDefinition): AgentFieldErrors {
  const errors: AgentFieldErrors = validateRecordText(values);
  if (values.content.prompt.trim() === "") errors.prompt = TEXT.enterPrompt;
  const { maxTurns } = values.content;
  if (!Number.isInteger(maxTurns) || maxTurns < RECORD_MAX_TURNS_MIN || maxTurns > RECORD_MAX_TURNS_MAX) {
    errors.maxTurns = TEXT.wholeNumber;
  }
  return errors;
}

/** The form of a new agent with the defaults already set (UXRD ED-01). */
export function blankAgent({ defaultModel, defaultMaxTurns }: RecordDefaults): AgentDefinition {
  return {
    name: "",
    description: "",
    kind: "agent",
    content: { prompt: "", servers: [], model: defaultModel, maxTurns: defaultMaxTurns, agents: [], tools: [] },
  };
}

/** The model a lost one is replaced with: the default when the author has it, otherwise their first. */
function replacementModel(choices: EditorChoices): string | null {
  const models = choices.models ?? [];
  if (models.some((option) => option.model === choices.defaultModel)) return choices.defaultModel;
  return models[0]?.model ?? null;
}

export type AgentFieldsProps = {
  mode: EditorMode;
  /** The record being edited; `null` while new. It is left out of «Может запускать». */
  recordId: string | null;
  /** The definition as saved: a system lost since then stays listed after it is unticked. */
  base: AgentDefinition;
  values: AgentDefinition;
  onChange: (values: AgentDefinition, field: AgentField) => void;
  errors: AgentFieldErrors;
  choices: EditorChoices;
};

/**
 * The agent's fields of the record editor (record-editor.md, parts 4–8; UXRD ED-01, MC-7): name, description
 * and instruction with counters by the contract's limits; the systems of the author's rights, a lost one
 * marked and kept; under «Дополнительно» the model, the maximum of steps and the agents it may start.
 */
export function AgentFields({ mode, recordId, base, values, onChange, errors, choices }: AgentFieldsProps) {
  const id = useId();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const content = values.content;
  const setContent = (next: Partial<AgentContent>, field: AgentField): void =>
    onChange({ ...values, content: { ...content, ...next } }, field);
  // An error inside unfolds the part in the same render, so the editor can focus the field at once.
  const advancedError = ADVANCED_FIELDS.some((field) => errors[field] !== undefined);

  return (
    <>
      <ModelBanner model={content.model} choices={choices} onReplace={(model) => setContent({ model }, "model")} />
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
      <TextField
        id={`${id}-prompt`}
        label={TEXT.prompt}
        hint={TEXT.promptHint}
        value={content.prompt}
        max={RECORD_PROMPT_MAX_LENGTH}
        multiline
        long
        error={errors.prompt}
        onChange={(prompt) => setContent({ prompt }, "prompt")}
      />
      <ServersField
        id={`${id}-servers`}
        saved={base.content.servers}
        chosen={content.servers}
        choices={choices.servers}
        allowAll={mode === "system"}
        error={errors.servers}
        onChange={(servers) => setContent({ servers }, "servers")}
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
            id={`${id}-model`}
            model={content.model}
            choices={choices}
            error={errors.model}
            onChange={(model) => setContent({ model }, "model")}
          />
          <MaxTurnsField
            id={`${id}-max-turns`}
            value={content.maxTurns}
            error={errors.maxTurns}
            onChange={(maxTurns) => setContent({ maxTurns }, "maxTurns")}
          />
          <AgentsField
            id={`${id}-agents`}
            recordId={recordId}
            chosen={content.agents}
            error={errors.agents}
            onChange={(agents) => setContent({ agents }, "agents")}
          />
        </CollapsibleContent>
      </CollapsibleRoot>
    </>
  );
}

const LABEL = "text-sm leading-5 font-medium text-foreground";
const HINT = cn(CAPTION, "text-muted-foreground");

const describedBy = (...ids: (string | null)[]): string | undefined => {
  const joined = ids.filter((part) => part !== null).join(" ");
  return joined === "" ? undefined : joined;
};

type TextFieldProps = {
  id: string;
  label: string;
  hint?: string;
  value: string;
  /** The contract's limit, shown as «{знаков} / {предел}». */
  max: number;
  /** `false` — the limit is only counted and checked on save; otherwise the field stops at it. */
  enforceMax?: boolean;
  multiline?: boolean;
  /** The instruction: Body 16 / 26, from eight lines high, scrolling inside from 768 px. */
  long?: boolean;
  error: string | undefined;
  onChange: (value: string) => void;
};

/** One text field with a counter (settings-form field; record-editor.md, parts 5 and 6). */
export function TextField({ id, label, hint, value, max, enforceMax = true, multiline = false, long = false, error, onChange }: TextFieldProps) {
  const hintId = hint === undefined ? null : `${id}-hint`;
  const errorId = `${id}-error`;
  const control = {
    id,
    name: id,
    value,
    maxLength: enforceMax ? max : undefined,
    "aria-invalid": error !== undefined,
    "aria-describedby": describedBy(hintId, error === undefined ? null : errorId),
  };
  return (
    <Field data-invalid={error !== undefined} className="gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <FieldLabel htmlFor={id} className={LABEL}>
          {label}
        </FieldLabel>
        {/* The counter is not announced: going past the limit is announced by the field's error. */}
        <span aria-hidden className={cn(CAPTION, "text-muted-foreground tabular-nums")}>
          {`${value.length} / ${max}`}
        </span>
      </div>
      {multiline ? (
        <Textarea
          {...control}
          className={cn(
            "pointer-coarse:text-base",
            long ? "min-h-52 text-base leading-6.5 md:max-h-[60vh] md:overflow-y-auto md:text-base" : "min-h-16",
          )}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          {...control}
          autoComplete="off"
          className="pointer-coarse:h-11"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hintId !== null && (
        <FieldDescription id={hintId} className={HINT}>
          {hint}
        </FieldDescription>
      )}
      <FieldError id={errorId} className={CAPTION}>
        {error}
      </FieldError>
    </Field>
  );
}

type ServersFieldProps = {
  id: string;
  saved: readonly string[];
  chosen: readonly string[];
  choices: readonly string[];
  /** The administrator on a company record: «Все системы» above the list (MC-9). */
  allowAll?: boolean;
  error: string | undefined;
  onChange: (servers: string[]) => void;
};

/**
 * «Системы» (KD-8): a checkbox per system of the author's rights, by its registry name. A system the author
 * has lost comes first, ticked and marked; it does not stop a save, and once unticked it cannot come back.
 */
export function ServersField({ id, saved, chosen, choices, allowAll = false, error, onChange }: ServersFieldProps) {
  // «Все системы» is a mark of the list, not a system: it is never listed as a lost one.
  const all = chosen.includes(ALL_SERVERS);
  const lost = [...new Set([...saved, ...chosen])].filter((server) => server !== ALL_SERVERS && !choices.includes(server));
  const rows = [...lost.map((server) => ({ server, lost: true })), ...choices.map((server) => ({ server, lost: false }))];
  const hintId = `${id}-hint`;
  const allHintId = `${id}-all-hint`;
  const errorId = `${id}-error`;
  const toggle = (server: string, checked: boolean): void =>
    onChange(checked ? [...chosen, server] : chosen.filter((item) => item !== server));

  return (
    <FieldSet data-invalid={error !== undefined} className="gap-2">
      <FieldLegend variant="label" className={cn(LABEL, "mb-0")}>
        {TEXT.servers}
      </FieldLegend>
      <FieldDescription id={hintId} className={HINT}>
        {TEXT.serversHint}
      </FieldDescription>
      {allowAll && (
        <div className="flex flex-col gap-0.5">
          <Label className="flex w-fit items-center gap-2 text-sm leading-5 font-normal text-foreground pointer-coarse:min-h-11">
            <Switch
              checked={all}
              aria-describedby={allHintId}
              // On — the record holds «all» alone; off — no system is chosen, the list is open to tick.
              onCheckedChange={(next) => onChange(next ? [ALL_SERVERS] : [])}
            />
            {TEXT.allServers}
          </Label>
          <p id={allHintId} className={HINT}>
            {TEXT.allServersHint}
          </p>
        </div>
      )}
      {rows.map(({ server, lost: isLost }, index) => {
        const checked = all || chosen.includes(server);
        const noteId = `${id}-${index}-lost`;
        return (
          <div key={server} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Label className="flex w-fit items-center gap-2 text-sm leading-5 font-normal text-foreground pointer-coarse:min-h-11">
              <Checkbox
                checked={checked}
                // A lost system, once unticked, cannot come back: the author has no right to it.
                disabled={all || (isLost && !checked)}
                aria-invalid={index === 0 && error !== undefined}
                aria-describedby={describedBy(hintId, isLost ? noteId : null, error === undefined ? null : errorId)}
                onCheckedChange={(next) => toggle(server, next)}
              />
              {server}
            </Label>
            {isLost && (
              // The mark and its consequence are the checkbox's description (record-editor.md, Accessibility).
              <span id={noteId} className="flex flex-wrap items-center gap-x-1.5">
                <StateBadge state="off">{TEXT.lostServer}</StateBadge>
                <span className={HINT}>{`— ${TEXT.lostServerRest}`}</span>
              </span>
            )}
          </div>
        );
      })}
      <FieldError id={errorId} className={CAPTION}>
        {error}
      </FieldError>
    </FieldSet>
  );
}

/**
 * MC-9: the record's model is not among the author's models. With models to choose from, one press puts
 * the replacement; with none, the banner stands without an action. Nothing shows until the models are read.
 */
function ModelBanner({
  model,
  choices,
  onReplace,
}: {
  model: string;
  choices: EditorChoices;
  onReplace: (model: string) => void;
}) {
  if (choices.models === undefined || choices.models.some((option) => option.model === model)) return null;
  const replacement = replacementModel(choices);
  return (
    // The banner is announced but takes no focus (record-editor.md, Accessibility).
    <div role="alert">
      <FormWarning>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>{replacement === null ? TEXT.noModels(model) : TEXT.modelGone(model)}</p>
          {replacement !== null && (
            <Button type="button" variant="outline" size="sm" className="pointer-coarse:h-11" onClick={() => onReplace(replacement)}>
              {TEXT.replaceModel(replacement)}
            </Button>
          )}
        </div>
      </FormWarning>
    </div>
  );
}

type ModelFieldProps = {
  id: string;
  /** «Модель» by default; a workflow's coordinator names its own. */
  label?: string;
  model: string;
  choices: EditorChoices;
  error: string | undefined;
  onChange: (model: string) => void;
};

/** «Модель»: the author's models; a lost one stays chosen with its mark, and a save with it is refused. */
export function ModelField({ id, label = TEXT.model, model, choices, error, onChange }: ModelFieldProps) {
  const models = choices.models ?? [];
  const lost = !models.some((option) => option.model === model);
  const options = [
    ...(lost ? [{ value: model, label: formatModel(model), lost: true }] : []),
    ...models.map((option) => ({ value: option.model, label: option.name, lost: false })),
  ];
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <Field data-invalid={error !== undefined} className="gap-1.5">
      <FieldLabel htmlFor={id} className={LABEL}>
        {label}
      </FieldLabel>
      <Select
        value={model}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next);
        }}
        items={options.map((option) => ({ value: option.value, label: option.label }))}
      >
        <SelectTrigger
          id={id}
          className="w-full max-w-90 pointer-coarse:h-11"
          aria-invalid={error !== undefined}
          aria-describedby={describedBy(hintId, error === undefined ? null : errorId)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.lost} className="pointer-coarse:min-h-11">
              <span>{option.label}</span>
              {option.lost && <StateBadge state="off">{TEXT.lostModel}</StateBadge>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription id={hintId} className={HINT}>
        {TEXT.modelHint}
      </FieldDescription>
      <FieldError id={errorId} className={CAPTION}>
        {error}
      </FieldError>
    </Field>
  );
}

/**
 * «Максимум шагов»: typed as text, so an emptied field stays empty; anything but a whole number is `NaN`
 * in the form and is refused before sending.
 */
export function MaxTurnsField({
  id,
  label = TEXT.maxTurns,
  hint = TEXT.maxTurnsHint,
  value,
  error,
  onChange,
}: {
  id: string;
  /** «Максимум шагов» by default; also the coordinator's maximum and an executor's «Сколько раз можно звать». */
  label?: string;
  /** `null` — no hint. */
  hint?: string | null;
  value: number;
  error: string | undefined;
  onChange: (value: number) => void;
}) {
  const hintId = hint === null ? null : `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <Field data-invalid={error !== undefined} className="gap-1.5">
      <FieldLabel htmlFor={id} className={LABEL}>
        {label}
      </FieldLabel>
      <Input
        id={id}
        name={id}
        inputMode="numeric"
        autoComplete="off"
        className="w-24 tabular-nums pointer-coarse:h-11"
        value={Number.isNaN(value) ? "" : String(value)}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(hintId, error === undefined ? null : errorId)}
        onChange={(event) => {
          const text = event.target.value.trim();
          onChange(text === "" ? Number.NaN : Number(text));
        }}
      />
      {hintId !== null && (
        <FieldDescription id={hintId} className={HINT}>
          {hint}
        </FieldDescription>
      )}
      <FieldError id={errorId} className={CAPTION}>
        {error}
      </FieldError>
    </Field>
  );
}

const byName = (a: RecordSummary, b: RecordSummary): number => a.name.localeCompare(b.name, "ru");

type AgentsFieldProps = {
  id: string;
  recordId: string | null;
  chosen: readonly string[];
  error: string | undefined;
  onChange: (agents: string[]) => void;
};

/**
 * «Может запускать»: a search over the agents the author sees (`libraryIndex`) and the chosen ones as record
 * label chips. A chosen agent missing from the read list is unavailable to the author; it stays until removed.
 */
function AgentsField({ id, recordId, chosen, error, onChange }: AgentsFieldProps) {
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = `${id}-error`;

  const candidates = useMemo(
    () =>
      records === null
        ? []
        : [...records.values()].filter((record) => record.kind === "agent" && record.id !== recordId).sort(byName),
    [records, recordId],
  );
  const selected = candidates.filter((record) => chosen.includes(record.id));

  const choose = (next: RecordSummary[]): void => {
    const known = new Set(candidates.map((record) => record.id));
    onChange([...chosen.filter((agentId) => !known.has(agentId)), ...next.map((record) => record.id)]);
  };
  const remove = (agentId: string): void => {
    onChange(chosen.filter((item) => item !== agentId));
    inputRef.current?.focus();
  };

  return (
    <Field data-invalid={error !== undefined} className="gap-1.5">
      <FieldLabel htmlFor={id} className={LABEL}>
        {TEXT.agents}
      </FieldLabel>
      <Combobox.Root
        multiple
        items={candidates}
        value={selected}
        onValueChange={choose}
        isItemEqualToValue={(item: RecordSummary, value: RecordSummary) => item.id === value.id}
        itemToStringLabel={(record: RecordSummary) => record.name}
      >
        <Combobox.Input
          id={id}
          ref={inputRef}
          render={<Input className="max-w-90 pointer-coarse:h-11" />}
          placeholder={`${TEXT.findAgent}…`}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
        />
        <Combobox.Portal>
          <Combobox.Positioner sideOffset={4} className="isolate z-50">
            <Combobox.Popup className="max-h-[min(var(--available-height),16rem)] w-(--anchor-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
              <Combobox.Empty className={cn(CAPTION, "px-2 py-1.5 text-muted-foreground empty:hidden")}>
                {TEXT.noAgents}
              </Combobox.Empty>
              <Combobox.List>
                {(record: RecordSummary) => (
                  <Combobox.Item
                    key={record.id}
                    value={record}
                    className="flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground pointer-coarse:min-h-11"
                  >
                    <span className="min-w-0 flex-1 truncate">{record.name}</span>
                    <Combobox.ItemIndicator>
                      <CheckIcon className="size-4" aria-hidden />
                    </Combobox.ItemIndicator>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {chosen.map((agentId) => {
            const summary = records?.get(agentId);
            return (
              <li key={agentId}>
                {summary !== undefined ? (
                  <RecordLabel variant="chip" summary={summary} onRemove={() => remove(agentId)} />
                ) : (
                  <GoneChip loading={records === null} onRemove={() => remove(agentId)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <FieldError id={errorId} className={CAPTION}>
        {error}
      </FieldError>
    </Field>
  );
}

/** A chosen agent the read list does not hold: unavailable to the author, or the list is still being read. */
function GoneChip({ loading, onRemove }: { loading: boolean; onRemove: () => void }): ReactNode {
  if (loading) return <Skeleton aria-hidden className="h-7 w-28" />;
  return (
    <span role="group" aria-label={TEXT.agentGone} className="flex items-center gap-1 rounded-md border border-border bg-muted py-0.5 pr-0.5 pl-2">
      <StateBadge state="off">{TEXT.agentGone}</StateBadge>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Убрать: ${TEXT.agentGone}`} onClick={onRemove}>
        <X aria-hidden />
      </Button>
    </span>
  );
}
