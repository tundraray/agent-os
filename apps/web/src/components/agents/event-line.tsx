"use client";

import { useEffect, useState } from "react";
import type { AgentStatus as AgentStatusValue, HistoryEvent, MyModel } from "@agent-os/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { ArchiveIcon, HistoryIcon, type LucideIcon } from "lucide-react";
import { AgentStatus, StatusGlyph } from "@/components/agents/agent-status";
import { accessApi } from "@/lib/access/access-api";
import { quotaFailureAnnouncement, quotaFailureText, quotaRowOf } from "@/lib/access/access-texts";
import {
  failureReasonText,
  formatModel,
  isProviderFailureReason,
  providerFailureHint,
  providerFailureText,
  type ModelNames,
  type ProviderFailureReason,
} from "@/lib/agents/format";
import { describeApiError } from "@/lib/api/api-request";
import { formatListTime } from "@/lib/i18n/formats";
import type { EventPartData } from "@/lib/feed/to-feed";
import { logger } from "@/lib/logger";

type StatusEvent = Exclude<HistoryEvent, "continued" | "compacted">;

/** The status an event leaves the agent in: the icon and colour of its line. */
const EVENT_STATUS: Record<StatusEvent, AgentStatusValue> = {
  interrupted: "interrupted",
  stopped: "stopped",
  stopped_with_parent: "stopped",
  failed: "failed",
};

/** MC-14 texts of the events that carry no reason. */
const EVENT_TEXT: Record<Exclude<HistoryEvent, "failed">, string> = {
  interrupted: "Прервано вами",
  stopped: "Остановлен вами",
  stopped_with_parent: "Остановлен вместе с родителем",
  continued: "Продолжен с историей",
  compacted: "История сжата для модели",
};

/**
 * Lines that mark a moment rather than a status: a static muted icon, so a past «Продолжен с историей»
 * does not spin in the feed after the agent has finished.
 */
const MARK_ICON: Record<"continued" | "compacted", LucideIcon> = {
  continued: HistoryIcon,
  compacted: ArchiveIcon,
};

/**
 * A status change without a model reply (UXRD MC-14): `AgentStatus` «Строка события». A failure reason
 * MC-14 does not name reads «Сбой: ошибка платформы» with its code as the hint (KD-6).
 */
export function EventLine({ data }: { data: EventPartData }) {
  const { event, reason, createdAt } = data;
  const format = useFormatter();
  const t = useTranslations("errors");

  if (event === "continued" || event === "compacted") {
    return (
      <p
        data-slot="agent-status-event"
        className="text-muted-foreground flex h-5 min-w-0 items-center gap-1 text-xs leading-4"
      >
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <StatusGlyph Icon={MARK_ICON[event]} spinning={false} />
        </span>
        <span className="min-w-0 truncate">{EVENT_TEXT[event]}</span>
        <span aria-hidden className="shrink-0">
          ·
        </span>
        <time dateTime={createdAt} className="shrink-0 tabular-nums">
          {formatListTime(format, createdAt)}
        </time>
      </p>
    );
  }

  if (event === "failed" && reason === "quota_exhausted") return <QuotaFailureLine data={data} />;

  if (event === "failed" && isProviderFailureReason(reason)) return <ProviderFailureLine data={data} reason={reason} />;

  if (event === "failed") {
    const { text, hint } = failureReasonText(t, reason);
    return <AgentStatus variant="event" status="failed" text={t("failedEvent", { reason: text })} at={createdAt} hint={hint} />;
  }

  return <AgentStatus variant="event" status={EVENT_STATUS[event]} text={EVENT_TEXT[event]} at={createdAt} />;
}

type QuotaRead = { status: "loading" } | { status: "ready"; row: MyModel | null; month: string };

/**
 * QS-01 (enterprise-access UXRD, KD-4): the quota failure with the model, the spend and the quota of the
 * month from the employee's row of that model, read when the line is shown (one read for the lines of a
 * feed shown together), and the hint under it.
 * Without the row, or when the read fails, the line reads «Сбой: квота исчерпана». The line announces
 * itself politely where it stands (MC-17), once the text is known.
 */
function QuotaFailureLine({ data }: { data: EventPartData }) {
  const { createdAt, model } = data;
  const format = useFormatter();
  const t = useTranslations("errors");
  const [read, setRead] = useState<QuotaRead>({ status: "loading" });

  useEffect(() => {
    let current = true;
    accessApi.modelsForFeed().then(
      (models) => {
        if (!current) return;
        const row = quotaRowOf(models, model, createdAt);
        if (row === null) logger.warn("feed: quota failure without the model's spent row", { model, at: createdAt });
        setRead({ status: "ready", row, month: models.month });
      },
      (error: unknown) => {
        if (!current) return;
        logger.error("feed: access models read failed for a quota failure", { model, ...describeApiError(error) });
        setRead({ status: "ready", row: null, month: "" });
      },
    );
    return () => {
      current = false;
    };
  }, [model, createdAt]);

  const row = read.status === "ready" ? read.row : null;
  const text = read.status === "ready" ? quotaFailureText(t, format, row, read.month) : quotaFailureText(t, format, null, "");
  return (
    <div data-slot="quota-failure" className="flex min-w-0 flex-col">
      <AgentStatus variant="event" status="failed" text={text} at={createdAt} />
      <p className="text-muted-foreground pl-5 text-xs leading-4 font-medium">{t("quota.hint")}</p>
      <span aria-live="polite" className="sr-only">
        {read.status === "ready" ? quotaFailureAnnouncement(t, row) : ""}
      </span>
    </div>
  );
}

type NamesRead = { status: "loading" } | { status: "ready"; names: ModelNames | undefined };

/**
 * A provider failure (model-providers UXRD MP-09, MC-9, MC-10): «Сбой: {причина}» naming the model by its
 * title from the employee's models (the same read as the quota lines), the hint under it, and the polite
 * announcement once the text is known. Until the read settles, and when it fails, the model reads by its ID label.
 */
function ProviderFailureLine({ data, reason }: { data: EventPartData; reason: ProviderFailureReason }) {
  const { createdAt, model } = data;
  const t = useTranslations("errors");
  const [read, setRead] = useState<NamesRead>({ status: "loading" });

  useEffect(() => {
    let current = true;
    accessApi.modelsForFeed().then(
      (models) => {
        if (current) setRead({ status: "ready", names: { models: models.models } });
      },
      (error: unknown) => {
        if (!current) return;
        logger.error("feed: access models read failed for a provider failure", { model, failure: reason, ...describeApiError(error) });
        setRead({ status: "ready", names: undefined });
      },
    );
    return () => {
      current = false;
    };
  }, [model, reason]);

  const label = formatModel(model, read.status === "ready" ? read.names : undefined);
  const text = providerFailureText(t, reason, label);
  return (
    <div data-slot="provider-failure" className="flex min-w-0 flex-col">
      <AgentStatus variant="event" status="failed" text={t("failedEvent", { reason: text })} at={createdAt} />
      <p className="text-muted-foreground pl-5 text-xs leading-4 font-medium">{providerFailureHint(t, reason)}</p>
      <span aria-live="polite" className="sr-only">
        {read.status === "ready" ? t("failedAnnouncement", { reason: text }) : ""}
      </span>
    </div>
  );
}
