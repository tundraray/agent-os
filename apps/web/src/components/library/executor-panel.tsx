"use client";

import { useId, useState, type RefObject } from "react";
import { Drawer } from "@base-ui/react/drawer";
import { ChevronRightIcon, XIcon } from "lucide-react";
import {
  EXECUTOR_MAX_RUNS_MAX,
  EXECUTOR_MAX_RUNS_MIN,
  EXECUTOR_NAME_MAX_LENGTH,
  EXECUTOR_ROLE_MAX_LENGTH,
  RECORD_MAX_TURNS_MAX,
  RECORD_MAX_TURNS_MIN,
  RECORD_PROMPT_MAX_LENGTH,
  WorkflowContentSchema,
  type WorkflowExecutor,
} from "@agent-os/contracts";
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "@/components/assistant-ui/elements/collapsible-root";
import { Button } from "@/components/ui/button";
import { MaxTurnsField, ModelField, ServersField, TextField, type EditorChoices } from "./agent-fields";

/** UXRD MC-13 (panel), MC-7 (fields), MC-8 (errors). */
const TEXT = {
  title: (name: string) => `Исполнитель «${name}»`,
  newTitle: "Новый исполнитель",
  done: "Готово",
  close: "Закрыть",
  name: "Имя",
  role: "За что отвечает и когда звать",
  prompt: "Инструкция",
  promptHint: "Что агент делает и как. Он видит только этот текст и своё поручение.",
  advanced: "Дополнительно: модель, максимум шагов, сколько раз можно звать",
  maxRuns: "Сколько раз можно звать",
  enterName: "Введите имя",
  // Not in MC-8: the contract's name rule refuses control characters, which MC-8 has no text for.
  oneLineName: "Имя — одной строкой, без управляющих символов",
  nameTaken: "Такое имя уже есть в команде",
  enterPrompt: "Введите инструкцию",
  wholeNumber: (min: number, max: number) => `Нужно целое число от ${min} до ${max}`,
} as const;

/** The executor-name rule is the contract's own schema, never an expression of the web. */
const ExecutorNameSchema = WorkflowContentSchema.shape.executors.element.shape.name;

/**
 * Whether two executor names repeat, as `WorkflowContentSchema` decides it (its `superRefine`, without regard to
 * case). The probe keeps the names and blanks what could stop the schema before its refinement runs: numbers
 * at the contract's minimum, no systems, tools or sources, so the only issue at `executors` itself is the repeat.
 */
function namesRepeat(executors: readonly WorkflowExecutor[]): boolean {
  const probe = {
    coordinator: { rules: "", model: executors[0]?.model ?? "", maxTurns: RECORD_MAX_TURNS_MIN },
    executors: executors.map((executor) => ({
      ...executor,
      servers: [],
      tools: [],
      maxTurns: RECORD_MAX_TURNS_MIN,
      maxRuns: EXECUTOR_MAX_RUNS_MIN,
      source: null,
    })),
    finalExecutor: null,
  };
  const issues = WorkflowContentSchema.safeParse(probe).error?.issues ?? [];
  return issues.some((issue) => issue.code === "custom" && issue.path.length === 1 && issue.path[0] === "executors");
}

/** The name check of the panel and of «Из библиотеки…»: required, one line, not taken in the team. */
export function executorNameError(executor: WorkflowExecutor, others: readonly WorkflowExecutor[]): string | undefined {
  if (executor.name.trim() === "") return TEXT.enterName;
  if (!ExecutorNameSchema.safeParse(executor.name).success) return TEXT.oneLineName;
  if (namesRepeat([...others, executor])) return TEXT.nameTaken;
  return undefined;
}

type PanelField = "name" | "role" | "prompt" | "maxTurns" | "maxRuns";
type PanelErrors = Partial<Record<PanelField, string>>;

const outside = (value: number, min: number, max: number): boolean => !Number.isInteger(value) || value < min || value > max;

/** The checks of «Готово»; the responsibility line is checked when the workflow is saved (executor-item.md). */
function validateExecutor(executor: WorkflowExecutor, others: readonly WorkflowExecutor[]): PanelErrors {
  const errors: PanelErrors = {};
  const name = executorNameError(executor, others);
  if (name !== undefined) errors.name = name;
  if (executor.prompt.trim() === "") errors.prompt = TEXT.enterPrompt;
  if (outside(executor.maxTurns, RECORD_MAX_TURNS_MIN, RECORD_MAX_TURNS_MAX)) {
    errors.maxTurns = TEXT.wholeNumber(RECORD_MAX_TURNS_MIN, RECORD_MAX_TURNS_MAX);
  }
  if (outside(executor.maxRuns, EXECUTOR_MAX_RUNS_MIN, EXECUTOR_MAX_RUNS_MAX)) {
    errors.maxRuns = TEXT.wholeNumber(EXECUTOR_MAX_RUNS_MIN, EXECUTOR_MAX_RUNS_MAX);
  }
  return errors;
}

/** What the panel edits: a copy of a team member, or a new one (from scratch or from the library). */
export type ExecutorEditing = {
  executor: WorkflowExecutor;
  /** The member's index in the form's team; `null` — a new one, added on «Готово». */
  index: number | null;
  /** WF-02: the name of the picked agent is taken — the panel opens with this error at the name. */
  nameError?: string;
};

export type ExecutorPanelProps = {
  editing: ExecutorEditing | null;
  /** The rest of the team: the edited name must not repeat theirs. */
  others: readonly WorkflowExecutor[];
  choices: EditorChoices;
  /** Where the focus goes when the panel closes: the card's name, or «Добавить». */
  returnFocus: RefObject<HTMLElement | null>;
  onDone: (executor: WorkflowExecutor) => void;
  onClose: () => void;
};

/**
 * WF-03 «Панель исполнителя» (executor-item.md): a `Drawer` on the right, 560 px wide, the whole screen below
 * 768 px. It edits a copy of the executor and gives it back on «Готово»; Esc and «✕» drop the copy. Nothing is
 * saved: the workflow's form changes, the record waits for «Сохранить».
 */
export function ExecutorPanel({ editing, others, choices, returnFocus, onDone, onClose }: ExecutorPanelProps) {
  return (
    <Drawer.Root
      open={editing !== null}
      swipeDirection="right"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Drawer.Portal>
        <Drawer.Backdrop className="fixed inset-0 z-50 bg-foreground/10 duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <Drawer.Viewport className="fixed inset-0 z-50 flex items-stretch justify-end">
          <Drawer.Popup
            finalFocus={returnFocus}
            className="flex h-full w-full flex-col border-l border-border bg-background text-foreground outline-none transition-transform duration-150 data-ending-style:translate-x-full data-starting-style:translate-x-full motion-reduce:transition-none md:w-140"
          >
            {editing !== null && (
              <PanelBody
                // A new copy for each opening: an edit dropped by Esc never comes back.
                key={`${editing.index ?? "new"}-${editing.executor.name}`}
                editing={editing}
                others={others}
                choices={choices}
                onDone={onDone}
              />
            )}
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function PanelBody({
  editing,
  others,
  choices,
  onDone,
}: {
  editing: ExecutorEditing;
  others: readonly WorkflowExecutor[];
  choices: EditorChoices;
  onDone: (executor: WorkflowExecutor) => void;
}) {
  const id = useId();
  const [executor, setExecutor] = useState(editing.executor);
  const [errors, setErrors] = useState<PanelErrors>(editing.nameError === undefined ? {} : { name: editing.nameError });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedError = errors.maxTurns !== undefined || errors.maxRuns !== undefined;

  const change = (next: Partial<WorkflowExecutor>, field: PanelField | null): void => {
    setExecutor((current) => ({ ...current, ...next }));
    if (field === null) return;
    setErrors((current) => {
      const rest = { ...current };
      delete rest[field];
      return rest;
    });
  };

  const done = (): void => {
    const found = validateExecutor(executor, others);
    setErrors(found);
    if (Object.keys(found).length === 0) {
      onDone(executor);
      return;
    }
    // After the errors render (and «Дополнительно» unfolds), the first invalid field takes the focus.
    requestAnimationFrame(() => document.getElementById(`${id}-panel`)?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
  };

  const title = editing.index === null ? TEXT.newTitle : TEXT.title(editing.executor.name);

  return (
    <Drawer.Content id={`${id}-panel`} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <Drawer.Title className="min-w-0 truncate text-base leading-6 font-medium">{title}</Drawer.Title>
        <Drawer.Close render={<Button type="button" variant="ghost" size="icon-sm" className="pointer-coarse:size-11" />}>
          <XIcon aria-hidden />
          <span className="sr-only">{TEXT.close}</span>
        </Drawer.Close>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 py-4">
        <TextField
          id={`${id}-name`}
          label={TEXT.name}
          value={executor.name}
          max={EXECUTOR_NAME_MAX_LENGTH}
          error={errors.name}
          onChange={(name) => change({ name }, "name")}
        />
        <TextField
          id={`${id}-role`}
          label={TEXT.role}
          value={executor.role}
          max={EXECUTOR_ROLE_MAX_LENGTH}
          multiline
          error={errors.role}
          onChange={(role) => change({ role }, "role")}
        />
        <TextField
          id={`${id}-prompt`}
          label={TEXT.prompt}
          hint={TEXT.promptHint}
          value={executor.prompt}
          max={RECORD_PROMPT_MAX_LENGTH}
          multiline
          long
          error={errors.prompt}
          onChange={(prompt) => change({ prompt }, "prompt")}
        />
        <ServersField
          id={`${id}-servers`}
          saved={editing.executor.servers}
          chosen={executor.servers}
          choices={choices.servers}
          error={undefined}
          onChange={(servers) => change({ servers }, null)}
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
              model={executor.model}
              choices={choices}
              error={undefined}
              onChange={(model) => change({ model }, null)}
            />
            <MaxTurnsField
              id={`${id}-max-turns`}
              value={executor.maxTurns}
              error={errors.maxTurns}
              onChange={(maxTurns) => change({ maxTurns }, "maxTurns")}
            />
            <MaxTurnsField
              id={`${id}-max-runs`}
              label={TEXT.maxRuns}
              hint={null}
              value={executor.maxRuns}
              error={errors.maxRuns}
              onChange={(maxRuns) => change({ maxRuns }, "maxRuns")}
            />
          </CollapsibleContent>
        </CollapsibleRoot>
      </div>
      <div className="flex shrink-0 justify-end border-t border-border px-4 py-3">
        <Button type="button" size="sm" className="pointer-coarse:h-11" onClick={done}>
          {TEXT.done}
        </Button>
      </div>
    </Drawer.Content>
  );
}
