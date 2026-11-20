"use client";

import { useMemo, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, LoaderCircle } from "lucide-react";
import { useStore } from "zustand";
import { CHAT_BUILTIN_KEY, EXECUTOR_MAX_RUNS_MIN, type RecordSummary, type WorkflowExecutor } from "@agent-os/contracts";
import { CAPTION, FormError } from "@/components/admin/admin-form";
import { useShellServices } from "@/components/shell/shell-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { describeApiError } from "@/lib/api/api-request";
import { libraryApi } from "@/lib/library/library-api";
import { failureReason } from "@/lib/library/library-errors";
import { executorFromSource } from "@/lib/library/update-workflows";
import { logger } from "@/lib/logger";
import { cn } from "cn";

/** UXRD MC-12 (the dialog). */
const TEXT = {
  title: "Добавить из библиотеки",
  find: "Найти агента",
  add: "Добавить",
  cancel: "Отмена",
  noAgents: "Агентов в библиотеке нет",
  // Not in MC-12: the agent's read failed, and MC-12 has no text for it.
  addFailed: (reason: string) => `Не удалось добавить: ${reason}`,
} as const;

const byName = (a: RecordSummary, b: RecordSummary): number => a.name.localeCompare(b.name, "ru");

export type ExecutorPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The author's systems: the agent's other systems do not come into the copy. */
  allowedServers: readonly string[];
  /** The picked agent as an executor copy and the systems that did not come in. */
  onPicked: (executor: WorkflowExecutor, dropped: string[]) => void;
};

/**
 * WF-02 «Из библиотеки…»: a search over the agents the author sees (`libraryIndex`). The chosen agent is read
 * (`libraryApi.get`) and becomes an executor copied from it: its description is the first draft of the
 * responsibility line, its source is the agent at the version read. Whether its name is taken in the team is
 * the caller's decision (it opens the panel with the name's error).
 */
export function ExecutorPicker({ open, onOpenChange, allowedServers, onPicked }: ExecutorPickerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full-narrow">
        <DialogHeader>
          <DialogTitle>{TEXT.title}</DialogTitle>
        </DialogHeader>
        {open && <PickerBody allowedServers={allowedServers} onPicked={onPicked} />}
      </DialogContent>
    </Dialog>
  );
}

function PickerBody({ allowedServers, onPicked }: Pick<ExecutorPickerProps, "allowedServers" | "onPicked">) {
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const [chosen, setChosen] = useState<RecordSummary | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agents = useMemo(
    () =>
      [...(records?.values() ?? [])]
        .filter((record) => record.kind === "agent" && record.builtinKey !== CHAT_BUILTIN_KEY)
        .sort(byName),
    [records],
  );

  const add = async (): Promise<void> => {
    if (chosen === null || pending) return;
    setPending(true);
    setError(null);
    try {
      const agent = await libraryApi.get(chosen.id);
      if (agent.kind !== "agent") throw new Error(TEXT.noAgents);
      const blank: WorkflowExecutor = {
        name: agent.name,
        role: agent.description,
        prompt: "",
        servers: [],
        model: agent.content.model,
        maxTurns: agent.content.maxTurns,
        maxRuns: EXECUTOR_MAX_RUNS_MIN,
        tools: [],
        source: null,
      };
      const { executor, dropped } = executorFromSource(blank, agent, allowedServers);
      onPicked(executor, dropped);
    } catch (cause) {
      logger.warn("library: agent read for a new executor failed", { recordId: chosen.id, ...describeApiError(cause) });
      setError(TEXT.addFailed(failureReason(cause)));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Combobox.Root
        items={agents}
        value={chosen}
        onValueChange={(value: RecordSummary | null) => setChosen(value)}
        isItemEqualToValue={(item: RecordSummary, value: RecordSummary) => item.id === value.id}
        itemToStringLabel={(record: RecordSummary) => record.name}
      >
        <Combobox.Input
          render={<Input className="pointer-coarse:h-11" />}
          aria-label={TEXT.find}
          placeholder={`${TEXT.find}…`}
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
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{record.name}</span>
                      <span className={cn(CAPTION, "truncate text-muted-foreground")}>{record.description}</span>
                    </span>
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
      {error !== null && <FormError>{error}</FormError>}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" className="pointer-coarse:h-11" />}>{TEXT.cancel}</DialogClose>
        <Button type="button" disabled={chosen === null || pending} className="pointer-coarse:h-11" onClick={() => void add()}>
          {pending && <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />}
          {TEXT.add}
        </Button>
      </DialogFooter>
    </>
  );
}
