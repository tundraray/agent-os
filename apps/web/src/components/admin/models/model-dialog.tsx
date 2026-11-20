'use client';

import { useId, useRef } from 'react';
import { toast } from 'sonner';
import {
  AccessErrorCode,
  type CatalogModel,
  type CreateCatalogModelBody,
  type ModelDefaults,
  type ModelProviderView,
  type ModelPurpose,
  type PriceRates,
  type UpdateCatalogModelBody,
} from '@agent-os/contracts';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { adminApi } from '@/lib/admin/admin-api';
import { ADMIN_TEXT, MODEL_DIALOG_TEXT as TEXT } from '@/lib/admin/admin-texts';
import { modelRules, parseDecimal, type ModelValues } from '@/lib/admin/form-rules';
import { PROVIDER_KIND_TEXT } from '@/lib/admin/model-providers';
import { isApiRequestError } from '@/lib/api/api-request';
import { cn } from '@/lib/utils';
import { AdminForm, AdminRadioField, AdminSelectField, AdminTextField, CAPTION, type AdminFormApi } from '../admin-form';
import { MODEL_DEFAULT_FIELD_ID } from './model-defaults-form';

type PriceField = keyof PriceRates;
type PriceTexts = ModelValues['prices'];

/** UXRD MC-30: the four prices in the order of the catalogue's columns and the dialog's fields. */
export const PRICES: ReadonlyArray<{ field: PriceField; label: string }> = [
  { field: 'inputUsdPerMTok', label: 'Вход' },
  { field: 'outputUsdPerMTok', label: 'Выход' },
  { field: 'cacheWriteUsdPerMTok', label: 'Запись в кэш' },
  { field: 'cacheReadUsdPerMTok', label: 'Чтение из кэша' },
];

/** MP-06: an embedding model is priced by its input only. */
const EMBEDDING_PRICES = PRICES.filter(({ field }) => field === 'inputUsdPerMTok');

const NO_PRICES: PriceTexts = {
  inputUsdPerMTok: '',
  outputUsdPerMTok: '',
  cacheWriteUsdPerMTok: '',
  cacheReadUsdPerMTok: '',
};

const PURPOSE_TEXT: Readonly<Record<ModelPurpose, string>> = { chat: TEXT.chat, embedding: TEXT.embedding };

/** A stored price as the field shows it: every significant digit up to nine decimals, comma for the fraction. */
const priceText = (usd: number): string => usd.toFixed(9).replace(/\.?0+$/, '').replace('.', ',');

const textsOf = (prices: PriceRates): PriceTexts => ({
  inputUsdPerMTok: priceText(prices.inputUsdPerMTok),
  outputUsdPerMTok: priceText(prices.outputUsdPerMTok),
  cacheWriteUsdPerMTok: priceText(prices.cacheWriteUsdPerMTok),
  cacheReadUsdPerMTok: priceText(prices.cacheReadUsdPerMTok),
});

/** A new model: chat, and the only provider chosen at once (MP-06). */
function newModel(providers: readonly ModelProviderView[]): ModelValues {
  return {
    provider: providers.length === 1 ? providers[0].name : null,
    purpose: 'chat',
    modelName: '',
    name: '',
    prices: NO_PRICES,
    longContext: null,
    dimensions: '',
  };
}

/** A stored model: provider, purpose, the name at the provider and the dimensions are fixed, shown as text. */
function valuesOf(model: CatalogModel): ModelValues {
  const fixed = { provider: model.provider, modelName: model.id.slice(model.provider.length + 1), name: model.name };
  if (model.purpose === 'embedding') {
    return {
      ...fixed,
      purpose: 'embedding',
      prices: { ...NO_PRICES, inputUsdPerMTok: priceText(model.inputUsdPerMTok) },
      longContext: null,
      dimensions: String(model.dimensions),
    };
  }
  return {
    ...fixed,
    purpose: 'chat',
    prices: textsOf(model.prices),
    longContext:
      model.longContext === null
        ? null
        : { aboveInputTokens: String(model.longContext.aboveInputTokens), prices: textsOf(model.longContext.prices) },
    dimensions: '',
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

/** A chat model's prices; `longContext: null` while the checkbox is off. */
const chatPricesOf = ({ prices, longContext }: ModelValues) => ({
  prices: ratesOf(prices),
  longContext:
    longContext === null
      ? null
      : { aboveInputTokens: numberOf(longContext.aboveInputTokens), prices: ratesOf(longContext.prices) },
});

/**
 * DC-2: the whole id `{provider}/{name at the provider}` and only the fields of the purpose — the server refuses a
 * field of the other purpose.
 */
function createBodyOf(values: ModelValues): CreateCatalogModelBody {
  if (values.provider === null) throw new Error('model form: no provider passed the field rule');
  const id = `${values.provider}/${values.modelName.trim()}`;
  const name = values.name.trim();
  if (values.purpose === 'embedding') {
    return {
      id,
      name,
      purpose: 'embedding',
      inputUsdPerMTok: numberOf(values.prices.inputUsdPerMTok),
      dimensions: numberOf(values.dimensions),
    };
  }
  return { id, name, purpose: 'chat', ...chatPricesOf(values) };
}

/** An edit changes the name and the prices of the model's own purpose. */
function updateBodyOf(model: CatalogModel, values: ModelValues): UpdateCatalogModelBody {
  const name = values.name.trim();
  if (model.purpose === 'embedding') return { name, inputUsdPerMTok: numberOf(values.prices.inputUsdPerMTok) };
  return { name, ...chatPricesOf(values) };
}

type PriceGroupProps = {
  /** The group's name: the unit, and for the second group what its prices are for. */
  legend: string;
  form: AdminFormApi<ModelValues>;
  fields: typeof PRICES;
  prices: PriceTexts;
  /** `''` for the ordinary prices, `long.` for the long-request ones: the error keys of `modelRules`. */
  errorPrefix: '' | 'long.';
  onChange: (prices: PriceTexts) => void;
};

/** Prices of a model, ordinary or for long requests: one group of fields under the unit. */
function PriceGroup({ legend, form, fields, prices, errorPrefix, onChange }: PriceGroupProps) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className={cn(CAPTION, 'mb-2 text-muted-foreground')}>{legend}</legend>
      <div className="grid grid-cols-2 gap-4">
        {fields.map(({ field, label }) => {
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

/** The error keys of the purpose-specific fields, cleared when the purpose changes along with their values. */
const PURPOSE_ERROR_KEYS = [...PRICES.map(({ field }) => field), 'dimensions', ...LONG_ERROR_KEYS];

function ChatPrices({ form }: { form: AdminFormApi<ModelValues> }) {
  const checkboxId = useId();
  const { values } = form;
  const long = values.longContext;

  const toggleLong = (on: boolean): void => {
    form.set('longContext', on ? { aboveInputTokens: '', prices: NO_PRICES } : null);
    if (!on) LONG_ERROR_KEYS.forEach(form.clearError);
  };

  return (
    <>
      <PriceGroup
        legend={TEXT.priceUnit}
        form={form}
        fields={PRICES}
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
          {TEXT.longContext}
        </FieldLabel>
      </Field>
      {long !== null && (
        <>
          <AdminTextField
            {...form.field('aboveInputTokens')}
            label={TEXT.threshold}
            value={long.aboveInputTokens}
            inputMode="numeric"
            onChange={(value) => {
              form.set('longContext', { ...long, aboveInputTokens: value });
              form.clearError('aboveInputTokens');
            }}
          />
          <PriceGroup
            legend={TEXT.longPriceUnit}
            form={form}
            fields={PRICES}
            prices={long.prices}
            errorPrefix="long."
            onChange={(prices) => form.set('longContext', { ...long, prices })}
          />
        </>
      )}
    </>
  );
}

function EmbeddingPrice({ form }: { form: AdminFormApi<ModelValues> }) {
  return (
    <PriceGroup
      legend={TEXT.priceUnit}
      form={form}
      fields={EMBEDDING_PRICES}
      prices={form.values.prices}
      errorPrefix=""
      onChange={(prices) => form.set('prices', prices)}
    />
  );
}

/** MP-06, adding: provider, purpose, the name at the provider with the id it makes. */
function NewModelHead({ form, providers }: { form: AdminFormApi<ModelValues>; providers: readonly ModelProviderView[] }) {
  const { values } = form;
  const chosen = providers.find((provider) => provider.name === values.provider);
  // AC-13.2: a provider whose kind serves no embedding model is not offered one.
  const embeddings = chosen?.servesEmbeddings ?? true;

  const choosePurpose = (purpose: ModelPurpose): void => {
    if (purpose === values.purpose) return;
    form.set('purpose', purpose);
    form.set('prices', NO_PRICES);
    form.set('longContext', null);
    form.set('dimensions', '');
    PURPOSE_ERROR_KEYS.forEach(form.clearError);
  };

  const chooseProvider = (name: string): void => {
    form.set('provider', name);
    if (providers.find((provider) => provider.name === name)?.servesEmbeddings === false) choosePurpose('chat');
  };

  const providerOptions = [...providers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((provider) => ({
      value: provider.name,
      label: TEXT.providerOption(provider.name, PROVIDER_KIND_TEXT[provider.kind].label),
    }));
  const purposes: readonly ModelPurpose[] = embeddings ? ['chat', 'embedding'] : ['chat'];
  const purposeOptions = purposes.map((purpose) => ({ value: purpose, label: PURPOSE_TEXT[purpose] }));
  const modelName = values.modelName.trim();

  return (
    <>
      <AdminSelectField
        {...form.field('provider')}
        label={TEXT.provider}
        value={values.provider}
        // The MC-7 error text doubles as the prompt of the empty field.
        emptyText={ADMIN_TEXT.modelProviderRequired}
        options={providerOptions}
        onChange={chooseProvider}
        disabled={form.saving}
      />
      <div className="flex flex-col gap-1.5">
        <AdminRadioField label={TEXT.purpose} value={values.purpose} options={purposeOptions} onChange={choosePurpose} />
        {!embeddings && (
          <p className={cn(CAPTION, 'text-muted-foreground')}>
            {TEXT.noAnthropicEmbeddings}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <AdminTextField
          {...form.field('modelName')}
          label={TEXT.modelName}
          value={values.modelName}
          mono
          hint={TEXT.modelNameHint}
          onChange={(value) => form.set('modelName', value)}
        />
        <p className={cn(CAPTION, 'font-mono wrap-break-word text-muted-foreground')}>
          {TEXT.idPreview(
            values.provider ?? TEXT.providerPlaceholder,
            modelName === '' ? TEXT.modelNamePlaceholder : modelName,
          )}
        </p>
      </div>
    </>
  );
}

type ModelFieldsProps = {
  form: AdminFormApi<ModelValues>;
  /** `null` while adding. */
  model: CatalogModel | null;
  providers: readonly ModelProviderView[];
};

function ModelFields({ form, model, providers }: ModelFieldsProps) {
  const { values } = form;
  return (
    <>
      {model === null ? (
        <NewModelHead form={form} providers={providers} />
      ) : (
        <p className="text-data wrap-break-word text-foreground">
          {TEXT.fixed(model.id, PURPOSE_TEXT[model.purpose])}
          {model.purpose === 'embedding' && TEXT.fixedDimensions(model.dimensions)}
        </p>
      )}
      <AdminTextField
        {...form.field('name')}
        label={TEXT.name}
        value={values.name}
        onChange={(value) => form.set('name', value)}
      />
      {values.purpose === 'chat' ? <ChatPrices form={form} /> : <EmbeddingPrice form={form} />}
      {model === null && values.purpose === 'embedding' && (
        <AdminTextField
          {...form.field('dimensions')}
          label={TEXT.dimensions}
          value={values.dimensions}
          inputMode="numeric"
          hint={TEXT.dimensionsHint}
          inputClassName="w-24"
          onChange={(value) => form.set('dimensions', value)}
        />
      )}
    </>
  );
}

type ModelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` adds a model; a model is changed in place, its id, purpose and dimensions never change. */
  model: CatalogModel | null;
  /** All providers of the section; `[]` while their read is loading or failed. */
  providers: readonly ModelProviderView[];
  /** The saved defaults: a new model of a purpose without one offers «Выбрать по умолчанию»; unknown — not offered. */
  defaults: ModelDefaults | undefined;
  /** Re-reads the «Модели» section: after a save, and when the model being changed is already gone (KD-1). */
  reloadAll: () => void;
};

const DEFAULT_OF: Readonly<Record<ModelPurpose, keyof ModelDefaults>> = {
  chat: 'chatModel',
  embedding: 'embeddingModel',
};

/**
 * UXRD MP-06: «Добавить модель» and «Изменить» — one dialog form. A taken id is the error of «Имя модели у
 * провайдера»; a provider gone meanwhile or one that serves no embeddings is the form's error
 * (`describeAdminError`); a model removed meanwhile (`MODEL_NOT_FOUND`) re-reads the section.
 */
export function ModelDialog({ open, onOpenChange, model, providers, defaults, reloadAll }: ModelDialogProps) {
  const adding = model === null;
  const addedPurpose = useRef<ModelPurpose>('chat');

  const submit = async (values: ModelValues): Promise<void> => {
    if (model === null) {
      addedPurpose.current = values.purpose;
      await adminApi.models.create(createBodyOf(values));
      return;
    }
    try {
      await adminApi.models.update(model.id, updateBodyOf(model, values));
    } catch (error) {
      if (isApiRequestError(error) && error.code === AccessErrorCode.MODEL_NOT_FOUND) reloadAll();
      throw error;
    }
  };

  const saved = (): void => {
    onOpenChange(false);
    reloadAll();
    if (!adding) return;
    const purpose = addedPurpose.current;
    const offerDefault = defaults !== undefined && defaults[DEFAULT_OF[purpose]] === null;
    toast.success(
      TEXT.added,
      offerDefault
        ? {
            action: {
              label: TEXT.chooseDefault,
              // The MP-01 form holds the value: the action only takes the admin to the field.
              onClick: () => document.getElementById(MODEL_DEFAULT_FIELD_ID[purpose])?.focus(),
            },
          }
        : undefined,
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Up to eleven fields with long-request prices: the dialog scrolls rather than leaving the viewport. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{adding ? TEXT.add : TEXT.edit}</DialogTitle>
        </DialogHeader>
        <AdminForm
          key={model?.id ?? 'new'}
          variant="dialog"
          initialValues={model === null ? newModel(providers) : valuesOf(model)}
          validate={modelRules}
          onSubmit={submit}
          submitLabel={adding ? TEXT.add : TEXT.save}
          // A new model's notice is `saved`'s own: it may carry «Выбрать по умолчанию».
          savedText={adding ? null : TEXT.saved}
          onSaved={saved}
          // The refusal names the provider of the request that was refused.
          errorContext={(values) => ({ providerName: values.provider ?? undefined })}
          logEvent={adding ? 'admin: model create' : 'admin: model save'}
        >
          {(form) => <ModelFields form={form} model={model} providers={providers} />}
        </AdminForm>
      </DialogContent>
    </Dialog>
  );
}
