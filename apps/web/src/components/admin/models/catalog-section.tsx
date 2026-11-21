'use client';

import { useId, useState } from 'react';
import { BoxIcon, PlusIcon } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AccessErrorCode,
  type CatalogModel,
  type ModelDefaults,
  type ModelProviderView,
  type PriceRates,
} from '@agent-os/contracts';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import type { Resource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { modelUnavailableReason, type ModelsTranslator } from '@/lib/admin/model-providers';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import type { Formatter } from '@/lib/i18n/formats';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_SIZE } from '../admin-form';
import { ConfirmDialog } from '../confirm-dialog';
import { DataTable, resourceTableState, type DataTableColumn, type DataTableRow } from '../data-table';
import { ModelDialog, PRICES } from './model-dialog';

const priceCells = (format: Formatter, prices: PriceRates): string[] =>
  PRICES.map((field) => format.number(prices[field], 'usdPrice'));

/** An embedding model has the input price only: output and both cache prices read «—» (MP-03). */
const embeddingPriceCells = (format: Formatter, inputUsdPerMTok: number): string[] =>
  PRICES.map((field) => (field === 'inputUsdPerMTok' ? format.number(inputUsdPerMTok, 'usdPrice') : '—'));

/** MP-03: the catalogue by id, so the models of one provider stand together. */
const byId = (models: readonly CatalogModel[], locale: string): CatalogModel[] =>
  [...models].sort((a, b) => a.id.localeCompare(b.id, locale));

/**
 * enterprise-access MC-30 with model-providers MC-7: the removal body names the personal denies removed with
 * the model, and a default model adds its consequence.
 */
function removeBodyOf(t: ModelsTranslator, model: CatalogModel, defaults: ModelDefaults | undefined): string {
  const body = t('catalog.removeBody');
  if (defaults?.chatModel === model.id) return `${body} ${t('catalog.defaultChat')}`;
  if (defaults?.embeddingModel === model.id) return `${body} ${t('catalog.defaultEmbedding')}`;
  return body;
}

/** One line of text in a column that gives way: cut at the end, whole in the tooltip. */
function Truncated({ text }: { text: string }) {
  return (
    <span className="block truncate" title={text}>
      {text}
    </span>
  );
}

/** A dialog keeps its model while it closes, so its content does not change during the exit animation. */
type DialogState = { open: boolean; model: CatalogModel | null };

const CLOSED: DialogState = { open: false, model: null };

type CatalogSectionProps = {
  catalog: Resource<CatalogModel[]>;
  /** `undefined` while the providers' read is loading or failed: then no row is marked «Нет провайдера». */
  providers: readonly ModelProviderView[] | undefined;
  defaults: ModelDefaults | undefined;
  /** Re-reads the whole «Модели» section after any change of this block (KD-1). */
  reloadAll: () => void;
};

/**
 * UXRD MP-03: the model catalogue with provider, purpose and prices, «Добавить модель», «Изменить» and
 * «Убрать из каталога». The data come from `ModelsScreen`.
 */
export function CatalogSection({ catalog, providers, defaults, reloadAll }: CatalogSectionProps) {
  const t = useTranslations('admin.models');
  const tPrice = useTranslations('admin.models.dialog.price');
  const locale = useLocale();
  const headingId = useId();
  const format = useFormatter();
  const needsProviderId = useId();
  const [editing, setEditing] = useState<DialogState>(CLOSED);
  const [removing, setRemoving] = useState<DialogState>(CLOSED);
  const noProviders = providers !== undefined && providers.length === 0;

  const removeModel = async (model: CatalogModel): Promise<void> => {
    try {
      await adminApi.models.remove(model.id);
    } catch (error) {
      // design-admin.md, Error handling: a model already gone is the outcome asked for; the re-read shows it.
      if (!isApiRequestError(error) || error.code !== AccessErrorCode.MODEL_NOT_FOUND) throw error;
      logger.warn('admin: model remove: already gone', describeApiError(error));
    } finally {
      reloadAll();
    }
    toast.success(t('catalog.removed'));
  };

  const providerCell = (model: CatalogModel) => {
    const missing = providers !== undefined && modelUnavailableReason(model.id, providers) === 'provider_missing';
    return (
      <span key="provider" className="flex items-center gap-2">
        <Truncated text={model.provider} />
        {missing && <StateBadge state="action">{t('catalog.noProvider')}</StateBadge>}
      </span>
    );
  };

  const columns: readonly DataTableColumn[] = [
    { header: t('catalog.model') },
    { header: t('dialog.provider') },
    { header: t('dialog.purpose') },
    ...PRICES.map((field) => ({ header: tPrice(field), align: 'end' as const })),
  ];

  const toRow = (model: CatalogModel): DataTableRow => ({
    key: model.id,
    name: model.name,
    cells: [
      <span key="model" className="flex min-w-0 flex-col py-1">
        <span className="truncate" title={model.name}>
          {model.name}
        </span>
        <span className={cn(CAPTION, 'truncate font-mono text-muted-foreground')} title={model.id}>
          {model.id}
        </span>
      </span>,
      providerCell(model),
      model.purpose === 'chat' ? t('dialog.chat') : t('catalog.embeddingPurpose', { dimensions: model.dimensions }),
      ...(model.purpose === 'chat' ? priceCells(format, model.prices) : embeddingPriceCells(format, model.inputUsdPerMTok)),
    ],
    nested:
      model.purpose !== 'chat' || model.longContext === null
        ? undefined
        : [
            {
              key: `${model.id}:long`,
              cells: [
                <Truncated
                  key="above"
                  text={t('catalog.above', { threshold: format.number(model.longContext.aboveInputTokens) })}
                />,
                '',
                '',
                ...priceCells(format, model.longContext.prices),
              ],
            },
          ],
    actions: [
      { label: t('dialog.edit'), onSelect: () => setEditing({ open: true, model }) },
      { label: t('catalog.remove'), onSelect: () => setRemoving({ open: true, model }) },
    ],
  });

  const state = resourceTableState(catalog, t('catalog.loadFailed'), (data) => ({
    rows: byId(data, locale).map(toRow),
    empty: {
      Icon: BoxIcon,
      title: t('catalog.empty'),
      description: noProviders ? t('catalog.emptyNoProviders') : t('catalog.emptyDescription'),
    },
  }));

  const removed = removing.model;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      {/* Below 768 px the button goes on its own line under the heading. */}
      <div className="flex flex-col items-start gap-2 md:flex-row md:items-center md:justify-between">
        <h2 id={headingId} className="text-base leading-6 font-semibold">
          {t('catalogTitle')}
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(CONTROL_SIZE, 'aria-disabled:opacity-50')}
          aria-disabled={noProviders || undefined}
          aria-describedby={noProviders ? needsProviderId : undefined}
          title={noProviders ? t('addModelNeedsProvider') : undefined}
          onClick={() => {
            if (!noProviders) setEditing({ open: true, model: null });
          }}
        >
          <PlusIcon aria-hidden />
          {t('addModel')}
          {noProviders && (
            <span id={needsProviderId} className="sr-only">
              {t('addModelNeedsProvider')}
            </span>
          )}
        </Button>
      </div>
      {(catalog.data?.length ?? 0) > 0 && (
        <div className={cn(CAPTION, 'flex flex-col text-muted-foreground')}>
          <p>{t('dialog.priceUnit')}</p>
          <p>{t('catalog.newPrices')}</p>
        </div>
      )}
      <DataTable caption={t('catalogTitle')} columns={columns} state={state} actionsAs="menu" />
      <ModelDialog
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        model={editing.model}
        providers={providers ?? []}
        defaults={defaults}
        reloadAll={reloadAll}
      />
      {removed !== null && (
        <ConfirmDialog
          open={removing.open}
          onOpenChange={(open) => setRemoving((current) => ({ ...current, open }))}
          title={t('catalog.removeTitle', { name: removed.name })}
          body={removeBodyOf(t, removed, defaults)}
          confirmLabel={t('catalog.remove')}
          onConfirm={() => removeModel(removed)}
          logEvent="admin: model remove"
          // The row and its «⋯», which opened the dialog, leave with the model.
          focusTitleAfterConfirm
        />
      )}
    </section>
  );
}
