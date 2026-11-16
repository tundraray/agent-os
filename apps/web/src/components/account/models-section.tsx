"use client";

import { Fragment, useEffect, useId, useState } from "react";
import { RotateCwIcon, TriangleAlert } from "lucide-react";
import type { MyModel, MyModels } from "@agent-os/contracts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { accessApi } from "@/lib/access/access-api";
import { NO_MODELS_ALLOWED } from "@/lib/access/access-texts";
import { formatQuotaUsd, formatUsd, monthName, utcMonthOf } from "@/lib/access/money";
import { describeApiError } from "@/lib/api/api-request";
import { logger } from "@/lib/logger";

/** UXRD MC-7 and MC-9. */
const TEXT = {
  title: (month: string) => `Модели и расход за ${monthName(month)}`,
  model: "Модель",
  spent: "Расход",
  quota: "Квота",
  remaining: "Остаток",
  noLimit: "без предела",
  exhausted: "Квота исчерпана",
  empty: NO_MODELS_ALLOWED,
  // Not in MC-9: the read failure follows the shell's «Не удалось …» texts, as in «Подключения».
  loadFailed: "Не удалось загрузить модели",
  retry: "Повторить",
} as const;

const EMPTY_VALUE = "—";
const SKELETON_WIDTHS = ["w-full", "w-5/6", "w-2/3", "w-3/4", "w-1/2", "w-4/5"] as const;

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: MyModels };

/** Cells after the name, in column order; an exhausted quota reads remaining «0,00 $» whatever the API rounds to. */
function valuesOf(row: MyModel): { spent: string; quota: string; remaining: string } {
  return {
    spent: formatUsd(row.spentUsd),
    quota: row.quotaUsd === null ? TEXT.noLimit : formatQuotaUsd(row.quotaUsd),
    remaining: row.exhausted ? formatUsd(0) : row.remainingUsd === null ? EMPTY_VALUE : formatUsd(row.remainingUsd),
  };
}

/**
 * MA-02 of UXRD Screen 3: a row per model allowed to the employee with this month's spend, quota and
 * remaining, read when the page opens (read-on-open, without the shared hook, as «Подключения»).
 * A data table at comfortable density; below 768 px its «Две строки» variant.
 */
export function ModelsSection() {
  const headingId = useId();
  const mobile = useIsMobile();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // `attempt` grows with «Повторить», which shows Loading itself; an answer after leaving the page or after a
  // newer attempt is dropped.
  useEffect(() => {
    let current = true;
    accessApi.models().then(
      (data) => {
        if (current) setLoad({ status: "ready", data });
      },
      (error: unknown) => {
        if (!current) return;
        logger.error("account: access models read failed", describeApiError(error));
        setLoad({ status: "error" });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const title = TEXT.title(load.status === "ready" ? load.data.month : utcMonthOf(new Date()));

  return (
    <section aria-labelledby={headingId} className="flex max-w-160 flex-col gap-4">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {title}
      </h2>

      {load.status === "loading" && (
        <div role="status" aria-label={title} className="flex flex-col gap-3">
          {SKELETON_WIDTHS.map((width) => (
            <Skeleton key={width} className={`h-5 ${width}`} />
          ))}
        </div>
      )}

      {load.status === "error" && (
        <div className="flex flex-col items-center gap-3 text-sm leading-5">
          <p role="alert">{TEXT.loadFailed}</p>
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => {
              setLoad({ status: "loading" });
              setAttempt((count) => count + 1);
            }}
          >
            <RotateCwIcon aria-hidden />
            {TEXT.retry}
          </Button>
        </div>
      )}

      {load.status === "ready" && load.data.models.length === 0 && (
        <p className="text-sm leading-5 font-medium text-foreground">{TEXT.empty}</p>
      )}

      {load.status === "ready" &&
        load.data.models.length > 0 &&
        (mobile ? <ModelsTwoLines models={load.data.models} /> : <ModelsTable caption={title} models={load.data.models} />)}
    </section>
  );
}

function ExhaustedLabel() {
  return (
    <span className="inline-flex items-center gap-1 text-xs leading-4 font-medium text-warning">
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      {TEXT.exhausted}
    </span>
  );
}

const headClass = "border-b border-border px-3 py-2 text-xs leading-4 font-medium text-muted-foreground";
const cellClass = "border-b border-border px-3 py-2.5";
const numberClass = "text-right tabular-nums";

function ModelsTable({ caption, models }: { caption: string; models: MyModel[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm leading-5 text-foreground">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={`${headClass} text-left`}>
              {TEXT.model}
            </th>
            <th scope="col" className={`${headClass} text-right`}>
              {TEXT.spent}
            </th>
            <th scope="col" className={`${headClass} text-right`}>
              {TEXT.quota}
            </th>
            <th scope="col" className={`${headClass} text-right`}>
              {TEXT.remaining}
            </th>
          </tr>
        </thead>
        <tbody>
          {models.map((row) => {
            const values = valuesOf(row);
            return (
              <tr key={row.model}>
                <td className={`${cellClass} break-words`}>{row.name}</td>
                <td className={`${cellClass} ${numberClass}`}>{values.spent}</td>
                <td className={`${cellClass} ${numberClass}`}>{values.quota}</td>
                <td className={`${cellClass} ${numberClass}`}>
                  <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
                    {values.remaining}
                    {row.exhausted && <ExhaustedLabel />}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** data-table «Две строки»: no header; the name, under it the other cells through « · »; the column names stay for screen readers. */
function ModelsTwoLines({ models }: { models: MyModel[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {models.map((row) => {
        const values = valuesOf(row);
        const cells = [
          { label: TEXT.spent, value: values.spent },
          { label: TEXT.quota, value: values.quota },
          { label: TEXT.remaining, value: values.remaining },
        ];
        return (
          <li key={row.model} className="flex flex-col gap-0.5 py-3">
            <span className="text-sm leading-5 font-medium break-words text-foreground">{row.name}</span>
            <span className="flex flex-wrap items-center gap-x-2 text-xs leading-4 font-medium text-muted-foreground tabular-nums">
              <span>
                {cells.map((cell, index) => (
                  <Fragment key={cell.label}>
                    {index > 0 && " · "}
                    <span className="sr-only">{cell.label} </span>
                    {cell.value}
                  </Fragment>
                ))}
              </span>
              {row.exhausted && <ExhaustedLabel />}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
