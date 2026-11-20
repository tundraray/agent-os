'use client';

import { useState } from 'react';
import { BoxIcon } from 'lucide-react';
import { toast } from 'sonner';
import { AccessErrorCode, type CatalogModel, type PriceRates } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { formatPriceUsd } from '@/lib/access/money';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_SIZE } from '../admin-form';
import { PANEL_TITLE } from '../admin-header';
import { adminSectionTitle } from '../admin-sections';
import { ConfirmDialog } from '../confirm-dialog';
import { DataTable, resourceTableState, type DataTableColumn, type DataTableRow } from '../data-table';
import { MODEL_TEXT, ModelDialog, PRICES } from './model-dialog';

/**
 * UXRD MC-30; the removal body carries the plan's Notes 6 change: personal denies on the model are removed
 * with it, so the text names them.
 */
const TEXT = {
  model: 'Модель',
  remove: 'Убрать из каталога',
  above: (threshold: number) => `свыше ${new Intl.NumberFormat('ru-RU').format(threshold)} входных токенов`,
  newPrices: 'Новые цены действуют для следующих вызовов. Прошлые стоимости не пересчитываются.',
  removeTitle: (name: string) => `Убрать модель «${name}» из каталога?`,
  removeBody:
    'Все права и личные запреты на эту модель будут удалены. Агенты больше не смогут её выбрать, а работающие на ней завершатся сбоем «модель не подключена».',
  empty: 'Каталог пуст',
  emptyDescription: 'Добавьте модель, чтобы агенты могли работать.',
  // Not in the UXRD: the read failure follows the shell's «Не удалось …» texts, as in «Роли».
  loadFailed: 'Не удалось загрузить каталог моделей',
  // Not in MC-30: the notice of a removal, after «Роль удалена».
  removed: 'Модель убрана из каталога',
} as const;

const COLUMNS: readonly DataTableColumn[] = [
  { header: TEXT.model },
  ...PRICES.map(({ label }) => ({ header: label, align: 'end' as const })),
];

const priceCells = (prices: PriceRates): string[] => PRICES.map(({ field }) => formatPriceUsd(prices[field]));

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

/** UXRD AD-11: the model catalogue with its prices, «Добавить модель», «Изменить» and «Убрать из каталога». */
export function CatalogSection() {
  const models = useResource(adminApi.models.list, 'models');
  const [editing, setEditing] = useState<DialogState>(CLOSED);
  const [removing, setRemoving] = useState<DialogState>(CLOSED);

  const removeModel = async (model: CatalogModel): Promise<void> => {
    try {
      await adminApi.models.remove(model.id);
    } catch (error) {
      // design-admin.md, Error handling: a model already gone is the outcome asked for; the re-read shows it.
      if (!isApiRequestError(error) || error.code !== AccessErrorCode.MODEL_NOT_FOUND) throw error;
      logger.warn('admin: model remove: already gone', describeApiError(error));
    } finally {
      models.reload();
    }
    toast.success(TEXT.removed);
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
      ...priceCells(model.prices),
    ],
    nested:
      model.longContext === null
        ? undefined
        : [
            {
              key: `${model.id}:long`,
              cells: [
                <Truncated key="above" text={TEXT.above(model.longContext.aboveInputTokens)} />,
                ...priceCells(model.longContext.prices),
              ],
            },
          ],
    actions: [
      { label: MODEL_TEXT.edit, onSelect: () => setEditing({ open: true, model }) },
      { label: TEXT.remove, onSelect: () => setRemoving({ open: true, model }) },
    ],
  });

  const state = resourceTableState(models, TEXT.loadFailed, (data) => ({
    rows: data.map(toRow),
    empty: { Icon: BoxIcon, title: TEXT.empty, description: TEXT.emptyDescription },
  }));

  const removed = removing.model;

  return (
    <>
      <PageHeader area={PANEL_TITLE} title={adminSectionTitle('models')}>
        <Button size="sm" className={CONTROL_SIZE} onClick={() => setEditing({ open: true, model: null })}>
          {MODEL_TEXT.add}
        </Button>
      </PageHeader>
      {(models.data?.length ?? 0) > 0 && (
        <div className={cn(CAPTION, 'mb-2 flex flex-col text-muted-foreground')}>
          <p>{MODEL_TEXT.priceUnit}</p>
          <p>{TEXT.newPrices}</p>
        </div>
      )}
      <DataTable caption={adminSectionTitle('models')} columns={COLUMNS} state={state} actionsAs="menu" />
      <ModelDialog
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        model={editing.model}
        reload={models.reload}
      />
      {removed !== null && (
        <ConfirmDialog
          open={removing.open}
          onOpenChange={(open) => setRemoving((current) => ({ ...current, open }))}
          title={TEXT.removeTitle(removed.name)}
          body={TEXT.removeBody}
          confirmLabel={TEXT.remove}
          onConfirm={() => removeModel(removed)}
          logEvent="admin: model remove"
          // The row and its «⋯», which opened the dialog, leave with the model.
          focusTitleAfterConfirm
        />
      )}
    </>
  );
}
