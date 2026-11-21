'use client';

import { useId, useState } from 'react';
import { BoxIcon, PlusIcon } from 'lucide-react';
import { useFormatter } from 'next-intl';
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
import { MODEL_DIALOG_TEXT, MODELS_TEXT } from '@/lib/admin/admin-texts';
import { modelUnavailableReason } from '@/lib/admin/model-providers';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import type { Formatter } from '@/lib/i18n/formats';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_SIZE } from '../admin-form';
import { ConfirmDialog } from '../confirm-dialog';
import { DataTable, resourceTableState, type DataTableColumn, type DataTableRow } from '../data-table';
import { ModelDialog, PRICES } from './model-dialog';

/**
 * UXRD enterprise-access MC-30 and model-providers MC-7; the removal body carries the plan's Notes 6 change:
 * personal denies on the model are removed with it, so the text names them.
 */
const TEXT = {
  model: 'Модель',
  noProvider: 'Нет провайдера',
  remove: 'Убрать из каталога',
  above: (threshold: string) => `свыше ${threshold} входных токенов`,
  newPrices: 'Новые цены действуют для следующих вызовов. Прошлые стоимости не пересчитываются.',
  removeTitle: (name: string) => `Убрать модель «${name}» из каталога?`,
  removeBody:
    'Все права и личные запреты на эту модель будут удалены. Агенты больше не смогут её выбрать, а работающие на ней завершатся сбоем «модель не подключена».',
  defaultChat: 'Это модель чата по умолчанию: пока вы не выберете другую, чат не отвечает.',
  defaultEmbedding:
    'Это модель эмбеддингов по умолчанию: пока вы не выберете другую, отбор по смыслу в самообучении выключен.',
  empty: 'Каталог пуст',
  emptyDescription: 'Добавьте модель, чтобы агенты могли работать.',
  emptyNoProviders: 'Сначала добавьте провайдера, потом его модели.',
  // Not in the UXRD: the read failure follows the shell's «Не удалось …» texts, as in «Роли».
  loadFailed: 'Не удалось загрузить каталог моделей',
  // Not in MC-30: the notice of a removal, after «Роль удалена».
  removed: 'Модель убрана из каталога',
} as const;

const COLUMNS: readonly DataTableColumn[] = [
  { header: TEXT.model },
  { header: MODEL_DIALOG_TEXT.provider },
  { header: MODEL_DIALOG_TEXT.purpose },
  ...PRICES.map(({ label }) => ({ header: label, align: 'end' as const })),
];

const priceCells = (format: Formatter, prices: PriceRates): string[] =>
  PRICES.map(({ field }) => format.number(prices[field], 'usdPrice'));

/** An embedding model has the input price only: output and both cache prices read «—» (MP-03). */
const embeddingPriceCells = (format: Formatter, inputUsdPerMTok: number): string[] =>
  PRICES.map(({ field }) => (field === 'inputUsdPerMTok' ? format.number(inputUsdPerMTok, 'usdPrice') : '—'));

/** MP-03: the catalogue by id, so the models of one provider stand together. */
const byId = (models: readonly CatalogModel[]): CatalogModel[] => [...models].sort((a, b) => a.id.localeCompare(b.id));

/** MC-7: the consequence added to the removal of a default model. */
function removeBodyOf(model: CatalogModel, defaults: ModelDefaults | undefined): string {
  if (defaults?.chatModel === model.id) return `${TEXT.removeBody} ${TEXT.defaultChat}`;
  if (defaults?.embeddingModel === model.id) return `${TEXT.removeBody} ${TEXT.defaultEmbedding}`;
  return TEXT.removeBody;
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
    toast.success(TEXT.removed);
  };

  const providerCell = (model: CatalogModel) => {
    const missing = providers !== undefined && modelUnavailableReason(model.id, providers) === 'provider_missing';
    return (
      <span key="provider" className="flex items-center gap-2">
        <Truncated text={model.provider} />
        {missing && <StateBadge state="action">{TEXT.noProvider}</StateBadge>}
      </span>
    );
  };

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
      model.purpose === 'chat' ? MODEL_DIALOG_TEXT.chat : `${MODEL_DIALOG_TEXT.embedding} · ${model.dimensions}`,
      ...(model.purpose === 'chat' ? priceCells(format, model.prices) : embeddingPriceCells(format, model.inputUsdPerMTok)),
    ],
    nested:
      model.purpose !== 'chat' || model.longContext === null
        ? undefined
        : [
            {
              key: `${model.id}:long`,
              cells: [
                <Truncated key="above" text={TEXT.above(format.number(model.longContext.aboveInputTokens))} />,
                '',
                '',
                ...priceCells(format, model.longContext.prices),
              ],
            },
          ],
    actions: [
      { label: MODEL_DIALOG_TEXT.edit, onSelect: () => setEditing({ open: true, model }) },
      { label: TEXT.remove, onSelect: () => setRemoving({ open: true, model }) },
    ],
  });

  const state = resourceTableState(catalog, TEXT.loadFailed, (data) => ({
    rows: byId(data).map(toRow),
    empty: { Icon: BoxIcon, title: TEXT.empty, description: noProviders ? TEXT.emptyNoProviders : TEXT.emptyDescription },
  }));

  const removed = removing.model;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      {/* Below 768 px the button goes on its own line under the heading. */}
      <div className="flex flex-col items-start gap-2 md:flex-row md:items-center md:justify-between">
        <h2 id={headingId} className="text-base leading-6 font-semibold">
          {MODELS_TEXT.catalogTitle}
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(CONTROL_SIZE, 'aria-disabled:opacity-50')}
          aria-disabled={noProviders || undefined}
          aria-describedby={noProviders ? needsProviderId : undefined}
          title={noProviders ? MODELS_TEXT.addModelNeedsProvider : undefined}
          onClick={() => {
            if (!noProviders) setEditing({ open: true, model: null });
          }}
        >
          <PlusIcon aria-hidden />
          {MODELS_TEXT.addModel}
          {noProviders && (
            <span id={needsProviderId} className="sr-only">
              {MODELS_TEXT.addModelNeedsProvider}
            </span>
          )}
        </Button>
      </div>
      {(catalog.data?.length ?? 0) > 0 && (
        <div className={cn(CAPTION, 'flex flex-col text-muted-foreground')}>
          <p>{MODEL_DIALOG_TEXT.priceUnit}</p>
          <p>{TEXT.newPrices}</p>
        </div>
      )}
      <DataTable caption={MODELS_TEXT.catalogTitle} columns={COLUMNS} state={state} actionsAs="menu" />
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
          title={TEXT.removeTitle(removed.name)}
          body={removeBodyOf(removed, defaults)}
          confirmLabel={TEXT.remove}
          onConfirm={() => removeModel(removed)}
          logEvent="admin: model remove"
          // The row and its «⋯», which opened the dialog, leave with the model.
          focusTitleAfterConfirm
        />
      )}
    </section>
  );
}
