'use client';

import { useId } from 'react';
import { AccessErrorCode, type CatalogModel, type PriceRates } from '@agent-os/contracts';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { adminApi } from '@/lib/admin/admin-api';
import { modelRules, parseDecimal, type ModelValues } from '@/lib/admin/form-rules';
import { isApiRequestError } from '@/lib/api/api-request';
import { cn } from '@/lib/utils';
import { AdminForm, AdminTextField, CAPTION, type AdminFormApi } from '../admin-form';

type PriceField = keyof PriceRates;
type PriceTexts = ModelValues['prices'];

/** UXRD MC-30: the four prices in the order of the catalogue's columns and the dialog's fields. */
export const PRICES: ReadonlyArray<{ field: PriceField; label: string }> = [
  { field: 'inputUsdPerMTok', label: 'Вход' },
  { field: 'outputUsdPerMTok', label: 'Выход' },
  { field: 'cacheWriteUsdPerMTok', label: 'Запись в кэш' },
  { field: 'cacheReadUsdPerMTok', label: 'Чтение из кэша' },
];

/** UXRD MC-30. */
export const MODEL_TEXT = {
  add: 'Добавить модель',
  edit: 'Изменить',
  id: 'ID модели',
  name: 'Название',
  priceUnit: '$ за 1 млн токенов',
  // Not in MC-30: the second group of prices needs a name of its own for a screen reader.
  longPriceUnit: '$ за 1 млн токенов для длинных запросов',
  longContext: 'Другие цены для длинных запросов',
  threshold: 'Порог, входных токенов',
  save: 'Сохранить',
  // Not in MC-30: the notices of a save, after «Роль удалена».
  added: 'Модель добавлена',
  saved: 'Модель сохранена',
} as const;

const NO_PRICES: PriceTexts = {
  inputUsdPerMTok: '',
  outputUsdPerMTok: '',
  cacheWriteUsdPerMTok: '',
  cacheReadUsdPerMTok: '',
};

/** A stored price as the field shows it: every significant digit up to nine decimals, comma for the fraction. */
const priceText = (usd: number): string => usd.toFixed(9).replace(/\.?0+$/, '').replace('.', ',');

const textsOf = (prices: PriceRates): PriceTexts => ({
  inputUsdPerMTok: priceText(prices.inputUsdPerMTok),
  outputUsdPerMTok: priceText(prices.outputUsdPerMTok),
  cacheWriteUsdPerMTok: priceText(prices.cacheWriteUsdPerMTok),
  cacheReadUsdPerMTok: priceText(prices.cacheReadUsdPerMTok),
});

function valuesOf(model: CatalogModel | null): ModelValues {
  if (model === null) return { id: '', name: '', prices: NO_PRICES, longContext: null };
  return {
    name: model.name,
    prices: textsOf(model.prices),
    longContext:
      model.longContext === null
        ? null
        : { aboveInputTokens: String(model.longContext.aboveInputTokens), prices: textsOf(model.longContext.prices) },
  };
}

/** A number the field rule already accepted; a `null` here is a defect of the rule, not of the input. */
function numberOf(text: string): number {
  const value = parseDecimal(text);
  if (value === null) throw new Error(`model form: «${text}» passed the field rule but is not a number`);
  return value;
}

const ratesOf = (prices: PriceTexts): PriceRates => ({
  inputUsdPerMTok: numberOf(prices.inputUsdPerMTok),
  outputUsdPerMTok: numberOf(prices.outputUsdPerMTok),
  cacheWriteUsdPerMTok: numberOf(prices.cacheWriteUsdPerMTok),
  cacheReadUsdPerMTok: numberOf(prices.cacheReadUsdPerMTok),
});

/** The fields shared by `POST` and `PATCH`; `longContext: null` while the checkbox is off. */
const bodyOf = ({ name, prices, longContext }: ModelValues) => ({
  name: name.trim(),
  prices: ratesOf(prices),
  longContext:
    longContext === null
      ? null
      : { aboveInputTokens: numberOf(longContext.aboveInputTokens), prices: ratesOf(longContext.prices) },
});

type PriceGroupProps = {
  /** The group's name: the unit, and for the second group what its prices are for. */
  legend: string;
  form: AdminFormApi<ModelValues>;
  prices: PriceTexts;
  /** `''` for the ordinary prices, `long.` for the long-request ones: the error keys of `modelRules`. */
  errorPrefix: '' | 'long.';
  onChange: (prices: PriceTexts) => void;
};

/** The four prices of a model, ordinary or for long requests: one group of fields under the unit. */
function PriceGroup({ legend, form, prices, errorPrefix, onChange }: PriceGroupProps) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className={cn(CAPTION, 'mb-2 text-muted-foreground')}>{legend}</legend>
      <div className="grid grid-cols-2 gap-4">
        {PRICES.map(({ field, label }) => {
          const key = `${errorPrefix}${field}`;
          return (
            <AdminTextField
              key={key}
              {...form.field(key)}
              label={label}
              value={prices[field]}
              inputMode="decimal"
              onChange={(value) => {
                onChange({ ...prices, [field]: value });
                form.clearError(key);
              }}
            />
          );
        })}
      </div>
    </fieldset>
  );
}

const LONG_ERROR_KEYS = ['aboveInputTokens', ...PRICES.map(({ field }) => `long.${field}`)];

function ModelFields({ form, adding }: { form: AdminFormApi<ModelValues>; adding: boolean }) {
  const checkboxId = useId();
  const { values } = form;
  const long = values.longContext;

  const toggleLong = (on: boolean): void => {
    form.set('longContext', on ? { aboveInputTokens: '', prices: NO_PRICES } : null);
    if (!on) LONG_ERROR_KEYS.forEach(form.clearError);
  };

  return (
    <>
      {adding && (
        <AdminTextField
          {...form.field('id')}
          label={MODEL_TEXT.id}
          value={values.id ?? ''}
          mono
          onChange={(value) => form.set('id', value)}
        />
      )}
      <AdminTextField
        {...form.field('name')}
        label={MODEL_TEXT.name}
        value={values.name}
        onChange={(value) => form.set('name', value)}
      />
      <PriceGroup
        legend={MODEL_TEXT.priceUnit}
        form={form}
        prices={values.prices}
        errorPrefix=""
        onChange={(prices) => form.set('prices', prices)}
      />
      <Field orientation="horizontal" className="gap-2">
        <Checkbox
          id={checkboxId}
          checked={long !== null}
          disabled={form.saving}
          onCheckedChange={(checked) => toggleLong(checked)}
        />
        <FieldLabel htmlFor={checkboxId} className="text-data font-normal text-foreground">
          {MODEL_TEXT.longContext}
        </FieldLabel>
      </Field>
      {long !== null && (
        <>
          <AdminTextField
            {...form.field('aboveInputTokens')}
            label={MODEL_TEXT.threshold}
            value={long.aboveInputTokens}
            inputMode="numeric"
            onChange={(value) => {
              form.set('longContext', { ...long, aboveInputTokens: value });
              form.clearError('aboveInputTokens');
            }}
          />
          <PriceGroup
            legend={MODEL_TEXT.longPriceUnit}
            form={form}
            prices={long.prices}
            errorPrefix="long."
            onChange={(prices) => form.set('longContext', { ...long, prices })}
          />
        </>
      )}
    </>
  );
}

type ModelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` adds a model; a model is changed in place, its id never changes. */
  model: CatalogModel | null;
  /** Reads the catalogue again: after a save, and when the model being changed is already gone. */
  reload: () => void;
};

/**
 * UXRD AD-11: «Добавить модель» and «Изменить» — one dialog form. A taken ID is the error of «ID модели»
 * (`describeAdminError`); a model removed meanwhile (`MODEL_NOT_FOUND`) re-reads the catalogue.
 */
export function ModelDialog({ open, onOpenChange, model, reload }: ModelDialogProps) {
  const adding = model === null;

  const submit = async (values: ModelValues): Promise<void> => {
    if (model === null) {
      await adminApi.models.create({ id: (values.id ?? '').trim(), ...bodyOf(values) });
      return;
    }
    try {
      await adminApi.models.update(model.id, bodyOf(values));
    } catch (error) {
      if (isApiRequestError(error) && error.code === AccessErrorCode.MODEL_NOT_FOUND) reload();
      throw error;
    }
  };

  const saved = (): void => {
    onOpenChange(false);
    reload();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Eleven fields with long-request prices: the dialog scrolls rather than leaving the viewport. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{adding ? MODEL_TEXT.add : MODEL_TEXT.edit}</DialogTitle>
        </DialogHeader>
        <AdminForm
          key={model?.id ?? 'new'}
          variant="dialog"
          initialValues={valuesOf(model)}
          validate={modelRules}
          onSubmit={submit}
          submitLabel={adding ? MODEL_TEXT.add : MODEL_TEXT.save}
          savedText={adding ? MODEL_TEXT.added : MODEL_TEXT.saved}
          onSaved={saved}
          logEvent={adding ? 'admin: model create' : 'admin: model update'}
        >
          {(form) => <ModelFields form={form} adding={adding} />}
        </AdminForm>
      </DialogContent>
    </Dialog>
  );
}
