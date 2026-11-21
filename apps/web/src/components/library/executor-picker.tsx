"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, LoaderCircle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useStore } from "zustand";
import { CHAT_BUILTIN_KEY, EXECUTOR_MAX_RUNS_MIN, type RecordSummary, type WorkflowExecutor } from "@agent-os/contracts";
import { CAPTION, FormError } from "@/components/admin/admin-form";
import { failedText } from "@/components/i18n/server-text";
import { useShellServices } from "@/components/shell/shell-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { describeApiError } from "@/lib/api/api-request";
import { builtinName } from "@/lib/i18n/builtin-name";
import { libraryApi } from "@/lib/library/library-api";
import { executorFromSource } from "@/lib/library/update-workflows";
import { logger } from "@/lib/logger";
import { cn } from "cn";

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
  const t = useTranslations("library");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full-narrow">
        <DialogHeader>
          <DialogTitle>{t("picker.title")}</DialogTitle>
        </DialogHeader>
        {open && <PickerBody allowedServers={allowedServers} onPicked={onPicked} />}
      </DialogContent>
    </Dialog>
  );
}

function PickerBody({ allowedServers, onPicked }: Pick<ExecutorPickerProps, "allowedServers" | "onPicked">) {
  const t = useTranslations("library");
  const tErrors = useTranslations("errors");
  const locale = useLocale();
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const [chosen, setChosen] = useState<RecordSummary | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ReactNode>(null);

  // Built-in agents are listed, searched and sorted by their name in the page's language.
  const agents = useMemo(
    () =>
      [...(records?.values() ?? [])]
        .filter((record) => record.kind === "agent" && record.builtinKey !== CHAT_BUILTIN_KEY)
        .map((record) => ({ ...record, name: builtinName(record, locale) }))
        .sort((a, b) => a.name.localeCompare(b.name, locale)),
    [records, locale],
  );

  const add = async (): Promise<void> => {
    if (chosen === null || pending) return;
    setPending(true);
    setError(null);
    try {
      const agent = await libraryApi.get(chosen.id);
      if (agent.kind !== "agent") {
        logger.warn("library: a picked record is no longer an agent", { recordId: chosen.id, kind: agent.kind });
        setError(tErrors("library.unavailable", { kind: "agent" }));
        return;
      }
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
      // Not in MC-12: the agent's read failed, and MC-12 has no text for it.
      setError(failedText(tErrors, "add", cause));
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
          aria-label={t("picker.find")}
          placeholder={t("agentFields.findAgent")}
        />
        <Combobox.Portal>
          <Combobox.Positioner sideOffset={4} className="isolate z-50">
            <Combobox.Popup className="max-h-[min(var(--available-height),16rem)] w-(--anchor-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
              <Combobox.Empty className={cn(CAPTION, "px-2 py-1.5 text-muted-foreground empty:hidden")}>
                {t("picker.noAgents")}
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
        <DialogClose render={<Button type="button" variant="outline" className="pointer-coarse:h-11" />}>{t("cancel")}</DialogClose>
        <Button type="button" disabled={chosen === null || pending} className="pointer-coarse:h-11" onClick={() => void add()}>
          {pending && <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />}
          {t("workflowFields.add")}
        </Button>
      </DialogFooter>
    </>
  );
}
