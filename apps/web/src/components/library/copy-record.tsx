"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import {
  ALL_SERVERS,
  type CopyResult,
  type MissingRight,
  type RecordDetail,
  type RecordSummary,
} from "@agent-os/contracts";
import { FormError } from "@/components/admin/admin-form";
import { useShellServices } from "@/components/shell/shell-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatModel } from "@/lib/agents/format";
import { describeApiError } from "@/lib/api/api-request";
import { builtinName } from "@/lib/i18n/builtin-name";
import type { LibraryTranslator } from "@/lib/i18n/messages";
import { libraryApi } from "@/lib/library/library-api";
import { copyFailed } from "@/lib/library/library-errors";
import { recordAction } from "@/lib/library/record-action";
import { logger } from "@/lib/logger";
import { recordPath } from "@/lib/shell-route";
import { useLeaveThenGo } from "./use-in-chat";

/** What a copy reads of a record: a library row, or a record page with its content. */
export type CopySource = RecordSummary | RecordDetail;

/** Systems of one part of the record: the agent itself (`executor` `null`) or an executor of a workflow. */
type PartServers = { executor: string | null; servers: readonly string[] };

type CopyPlan = {
  record: CopySource;
  /** Systems the copy loses: the copier has no access to them (from `missingRights`). */
  dropped: PartServers[];
  /** A company record with «Все системы»: the systems the copy gets instead; `null` — not such a record. */
  allServers: readonly string[] | null;
};

const droppedOf = (rights: readonly MissingRight[]): PartServers[] =>
  rights.filter((right) => right.servers.length > 0).map(({ executor, servers }) => ({ executor, servers }));

const hasAllServers = (record: RecordDetail): boolean =>
  record.kind === "agent"
    ? record.content.servers.includes(ALL_SERVERS)
    : record.content.executors.some((executor) => executor.servers.includes(ALL_SERVERS));

/**
 * What the dialog must name before the copy. Only a company record can hold «Все системы»; a library row
 * has no content, so such a record is read first, and the copier's own systems come from `choices`.
 */
async function planCopy(record: CopySource): Promise<CopyPlan> {
  const dropped = droppedOf(record.missingRights);
  if (record.author !== null) return { record, dropped, allServers: null };
  const detail = "content" in record ? record : await libraryApi.get(record.id);
  if (!hasAllServers(detail)) return { record, dropped, allServers: null };
  return { record, dropped, allServers: (await libraryApi.choices()).servers };
}

const partLine = (t: LibraryTranslator, { executor, servers }: PartServers): string =>
  executor === null ? servers.join(", ") : t("executorLine", { executor, text: servers.join(", ") });

/**
 * The notice of MC-4 (and MC-19): the copy's name, then the dropped systems in the wording of MC-13 and both
 * models of every replacement.
 */
function copiedNotice(t: LibraryTranslator, result: CopyResult): { title: string; description: string | undefined } {
  const { name } = result.record;
  const runsNowhere =
    result.replacedModels.length === 0 && result.record.missingRights.some((right) => right.model !== null);
  const replaced = (from: string, to: string): string =>
    t("copy.replaced", { from: formatModel(from), to: formatModel(to) });
  const details = [
    ...(result.removedServers.length === 0
      ? []
      : [t("droppedServers", { servers: result.removedServers.map((part) => partLine(t, part)).join("; ") })]),
    ...result.replacedModels.map(({ executor, from, to }) =>
      executor === null ? replaced(from, to) : t("executorLine", { executor, text: replaced(from, to) }),
    ),
  ];
  return {
    title: runsNowhere ? t("copy.noModels", { name }) : t("copy.saved", { name }),
    description: details.length === 0 ? undefined : `${details.join(". ")}.`,
  };
}

export type CopyRecord = {
  /** «Скопировать себе»: copies at once, or first opens the dialog that names what the copy will not get. */
  copy: (record: CopySource) => void;
  /** A copy or its preparation is running: the trigger shows `LoaderCircle` and is unavailable. */
  pending: boolean;
  /** MC-4 «Не удалось скопировать: {причина}» of the last direct copy, `null` — none; the dialog shows its own. */
  error: ReactNode;
  /** The dialog of LB-03; the caller renders it. */
  dialog: ReactNode;
};

/**
 * «Скопировать себе» (UXRD LB-03, MC-4): one `POST …/copy` through `recordAction`, then `libraryIndex` is
 * re-read (the copy joins «Мои»), the notice names the dropped systems and both models of a replacement,
 * and its «Открыть» leads to the copy's page.
 */
export function useCopyRecord(): CopyRecord {
  const { libraryIndex, announcer } = useShellServices();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("errors");
  const tLibrary = useTranslations("library");
  const leaveThenGo = useLeaveThenGo();
  const [plan, setPlan] = useState<CopyPlan | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ReactNode>(null);

  async function run(record: CopySource): Promise<void> {
    const result = await recordAction(
      { recordId: record.id, kind: record.kind, action: "copy", version: null },
      () => libraryApi.copy(record.id, locale),
    );
    void libraryIndex.refresh();
    const notice = copiedNotice(tLibrary, result);
    toast.success(notice.title, {
      description: notice.description,
      action: { label: tLibrary("open"), onClick: () => leaveThenGo(() => router.push(recordPath(result.record.id))) },
    });
    announcer.getState().announce("announce.copySaved", { name: result.record.name });
  }

  async function copy(record: CopySource): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    let next: CopyPlan;
    try {
      next = await planCopy(record);
    } catch (cause) {
      logger.warn("library: copy preparation read failed", { recordId: record.id, ...describeApiError(cause) });
      setError(copyFailed(t, cause));
      setPending(false);
      return;
    }
    if (next.dropped.length > 0 || next.allServers !== null) {
      setPlan(next);
      setPending(false);
      return;
    }
    try {
      await run(record);
    } catch (cause) {
      // `recordAction` has logged the refusal.
      setError(copyFailed(t, cause));
    } finally {
      setPending(false);
    }
  }

  async function confirm(): Promise<void> {
    if (plan === null || pending) return;
    setPending(true);
    setError(null);
    try {
      await run(plan.record);
      setPlan(null);
    } catch (cause) {
      setError(copyFailed(t, cause));
    } finally {
      setPending(false);
    }
  }

  const close = (open: boolean): void => {
    if (open || pending) return;
    setPlan(null);
    setError(null);
  };

  const dialog = (
    <Dialog open={plan !== null} onOpenChange={close}>
      {plan !== null && (
        <DialogContent size="full-narrow">
          <DialogHeader>
            <DialogTitle>{tLibrary("copy.title", { name: builtinName(plan.record, locale) })}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm leading-5">
            <p>{tLibrary("copy.onlyYou")}</p>
            <CopyLines heading={tLibrary("copy.dropped")} parts={plan.dropped} />
            {plan.allServers !== null && (
              <CopyLines heading={tLibrary("copy.allServers")} parts={[{ executor: null, servers: plan.allServers }]} />
            )}
            {error !== null && <FormError>{error}</FormError>}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" size="sm" />} disabled={pending}>
              {tLibrary("cancel")}
            </DialogClose>
            <Button type="button" size="sm" disabled={pending} onClick={() => void confirm()}>
              {pending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
              {tLibrary("copy.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );

  return { copy: (record) => void copy(record), pending, error: plan === null ? error : null, dialog };
}

/** «{системы}» of the agent itself in one line; a workflow's executors one line each. */
function CopyLines({ heading, parts }: { heading: string; parts: readonly PartServers[] }) {
  const t = useTranslations("library");
  if (parts.length === 0) return null;
  const single = parts.length === 1 && parts[0]?.executor === null ? parts[0] : null;
  if (single !== null) return <p>{`${heading} ${single.servers.join(", ")}`}</p>;
  return (
    <div className="flex flex-col gap-1">
      <p>{heading}</p>
      <ul className="flex flex-col gap-1 pl-4">
        {parts.map((part) => (
          <li key={part.executor ?? ""} className="list-disc">
            {partLine(t, part)}
          </li>
        ))}
      </ul>
    </div>
  );
}
