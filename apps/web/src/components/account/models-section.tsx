'use client';

import { Fragment, useEffect, useId, useState } from 'react';
import { RotateCwIcon, TriangleAlert } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  modelProvider,
  type MyModel,
  type MyModels,
} from '@agent-os/contracts';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useIsMobile } from '@/hooks/use-mobile';
import { accessApi } from '@/lib/access/access-api';
import { describeApiError } from '@/lib/api/api-request';
import { formatMonth, formatQuota, utcMonthOf } from '@/i18n/formats';
import { logger } from '@/lib/logger';

const EMPTY_VALUE = '—';
const SKELETON_WIDTHS = [
  'w-full',
  'w-5/6',
  'w-2/3',
  'w-3/4',
  'w-1/2',
  'w-4/5',
] as const;

type Load =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: MyModels };

type ModelValues = { spent: string; quota: string; remaining: string };

/** Cells after the name, in column order; an exhausted quota reads remaining «0,00 $» whatever the API rounds to. */
function useModelValues(): (row: MyModel) => ModelValues {
  const format = useFormatter();
  const t = useTranslations('account.models');
  const usd = (value: number): string => format.number(value, 'usd');
  return (row) => ({
    spent: usd(row.spentUsd),
    quota:
      row.quotaUsd === null ? t('noLimit') : formatQuota(format, row.quotaUsd),
    remaining: row.exhausted
      ? usd(0)
      : row.remainingUsd === null
        ? EMPTY_VALUE
        : usd(row.remainingUsd),
  });
}

/**
 * MA-02 of UXRD Screen 3: a row per model allowed to the employee with this month's spend, quota and
 * remaining, read when the page opens (read-on-open, without the shared hook, as «Подключения»).
 * A data table at comfortable density; below 768 px its «Две строки» variant.
 */
export function ModelsSection() {
  const headingId = useId();
  const mobile = useIsMobile();
  const format = useFormatter();
  const t = useTranslations('account');
  const tErrors = useTranslations('errors');
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // `attempt` grows with «Повторить», which shows Loading itself; an answer after leaving the page or after a
  // newer attempt is dropped.
  useEffect(() => {
    let current = true;
    accessApi.models().then(
      (data) => {
        if (current) setLoad({ status: 'ready', data });
      },
      (error: unknown) => {
        if (!current) return;
        logger.error(
          'account: access models read failed',
          describeApiError(error),
        );
        setLoad({ status: 'error' });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  // The month is named in UTC (`formats.dateTime.month`): the server's HTML and the hydrated page agree.
  const title = t('models.title', {
    month: formatMonth(
      format,
      load.status === 'ready' ? load.data.month : utcMonthOf(new Date()),
    ),
  });

  return (
    <section
      aria-labelledby={headingId}
      className="flex max-w-160 flex-col gap-4"
    >
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {title}
      </h2>

      {load.status === 'loading' && (
        <div role="status" aria-label={title} className="flex flex-col gap-3">
          {SKELETON_WIDTHS.map((width) => (
            <Skeleton key={width} className={`h-5 ${width}`} />
          ))}
        </div>
      )}

      {load.status === 'error' && (
        <div className="flex flex-col items-center gap-3 text-sm leading-5">
          <p role="alert">{t('models.loadFailed')}</p>
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => {
              setLoad({ status: 'loading' });
              setAttempt((count) => count + 1);
            }}
          >
            <RotateCwIcon aria-hidden />
            {t('retry')}
          </Button>
        </div>
      )}

      {load.status === 'ready' && load.data.models.length === 0 && (
        <p className="text-sm leading-5 font-medium text-foreground">
          {tErrors('noModelsAllowed')}
        </p>
      )}

      {load.status === 'ready' &&
        load.data.models.length > 0 &&
        (mobile ? (
          <ModelsTwoLines models={load.data.models} />
        ) : (
          <ModelsTable caption={title} models={load.data.models} />
        ))}
    </section>
  );
}

function ExhaustedLabel() {
  const t = useTranslations('account.models');
  return (
    <span className="inline-flex items-center gap-1 text-xs leading-4 font-medium text-warning">
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      {t('exhausted')}
    </span>
  );
}

/**
 * model-providers UXRD MP-08: the name with «не работает» («Выключено») when its provider does not work — the row
 * stays, its spend is real — and the provider as a Caption under it.
 */
function ModelName({ row }: { row: MyModel }) {
  const t = useTranslations('account.models');
  return (
    <span className="flex flex-col gap-0.5">
      <span className="inline-flex flex-wrap items-center gap-x-2">
        {row.name}
        {row.unavailableReason !== null && (
          <StateBadge state="off">{t('unavailable')}</StateBadge>
        )}
      </span>
      <span className="text-xs leading-4 font-medium text-muted-foreground">
        {modelProvider(row.model)}
      </span>
    </span>
  );
}

const headClass =
  'border-b border-border px-3 py-2 text-xs leading-4 font-medium text-muted-foreground';
const cellClass = 'border-b border-border px-3 py-2.5';
const numberClass = 'text-right tabular-nums';

function ModelsTable({
  caption,
  models,
}: {
  caption: string;
  models: MyModel[];
}) {
  const t = useTranslations('account.models');
  const valuesOf = useModelValues();
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm leading-5 text-foreground">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={`${headClass} text-left`}>
              {t('model')}
            </th>
            <th scope="col" className={`${headClass} text-right`}>
              {t('spent')}
            </th>
            <th scope="col" className={`${headClass} text-right`}>
              {t('quota')}
            </th>
            <th scope="col" className={`${headClass} text-right`}>
              {t('remaining')}
            </th>
          </tr>
        </thead>
        <tbody>
          {models.map((row) => {
            const values = valuesOf(row);
            return (
              <tr key={row.model}>
                <td className={`${cellClass} break-words`}>
                  <ModelName row={row} />
                </td>
                <td className={`${cellClass} ${numberClass}`}>
                  {values.spent}
                </td>
                <td className={`${cellClass} ${numberClass}`}>
                  {values.quota}
                </td>
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
  const t = useTranslations('account.models');
  const valuesOf = useModelValues();
  return (
    <ul className="flex flex-col divide-y divide-border">
      {models.map((row) => {
        const values = valuesOf(row);
        const cells = [
          { label: t('spent'), value: values.spent },
          { label: t('quota'), value: values.quota },
          { label: t('remaining'), value: values.remaining },
        ];
        return (
          <li key={row.model} className="flex flex-col gap-0.5 py-3">
            <span className="text-sm leading-5 font-medium break-words text-foreground">
              <ModelName row={row} />
            </span>
            <span className="flex flex-wrap items-center gap-x-2 text-xs leading-4 font-medium text-muted-foreground tabular-nums">
              <span>
                {cells.map((cell, index) => (
                  <Fragment key={cell.label}>
                    {index > 0 && ' · '}
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
