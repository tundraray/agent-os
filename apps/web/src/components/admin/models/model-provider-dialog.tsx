'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ModelProviderKindSchema,
  type CreateModelProviderBody,
  type ModelProviderKind,
  type ModelProviderView,
  type UpdateModelProviderBody,
} from '@agent-os/contracts';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { adminApi } from '@/lib/admin/admin-api';
import { isNotFound } from '@/lib/admin/admin-errors';
import { modelProviderRules } from '@/lib/admin/form-rules';
import {
  DEFAULT_PROVIDER_NAME,
  providerKindText,
} from '@/lib/admin/model-providers';
import { cn } from '@/lib/utils';
import {
  AdminForm,
  AdminRadioField,
  AdminTextField,
  CAPTION,
  type AdminFormApi,
} from '../admin-form';
import { SecretField } from '../secret-field';

type ProviderValues = {
  kind: ModelProviderKind;
  name: string;
  /** The admin typed «Имя» himself: from then on the type no longer puts its name there. */
  nameEdited: boolean;
  baseUrl: string;
  /** `SecretField`: `undefined` — nothing typed, `''` — a replacement started and still empty. */
  apiKey: string | undefined;
};

function valuesOf(provider: ModelProviderView | null): ProviderValues {
  if (provider === null) {
    return {
      kind: 'anthropic',
      name: DEFAULT_PROVIDER_NAME.anthropic ?? '',
      nameEdited: false,
      baseUrl: '',
      apiKey: undefined,
    };
  }
  return {
    kind: provider.kind,
    name: provider.name,
    nameEdited: true,
    baseUrl: provider.baseUrl ?? '',
    apiKey: undefined,
  };
}

/**
 * KD-4: the only place that decides whether a body carries the key — only a typed, non-empty value. An empty
 * replacement means «the key did not change»; the web never asks to remove the key (no null key).
 */
const typedKey = (apiKey: string | undefined): { apiKey?: string } =>
  apiKey === undefined || apiKey === '' ? {} : { apiKey };

function createBodyOf({
  kind,
  name,
  baseUrl,
  apiKey,
}: ProviderValues): CreateModelProviderBody {
  const url = baseUrl.trim();
  return {
    name,
    kind,
    ...(url === '' ? {} : { baseUrl: url }),
    ...typedKey(apiKey),
  };
}

/** Only what changed: an emptied address is `null` (the type's default); an untouched one stays out. */
function updateBodyOf(
  provider: ModelProviderView,
  { baseUrl, apiKey }: ProviderValues,
): UpdateModelProviderBody {
  const url = baseUrl.trim();
  const address =
    url === (provider.baseUrl ?? '')
      ? {}
      : { baseUrl: url === '' ? null : url };
  return { ...address, ...typedKey(apiKey) };
}

function ProviderFields({
  form,
  provider,
}: {
  form: AdminFormApi<ProviderValues>;
  provider: ModelProviderView | null;
}) {
  const t = useTranslations('admin.models');
  const { values } = form;
  const kindText = providerKindText(t, values.kind);
  const kindOptions = ModelProviderKindSchema.options.map((kind) => {
    const text = providerKindText(t, kind);
    return { value: kind, label: text.label, hint: text.hint ?? undefined };
  });

  const chooseKind = (kind: ModelProviderKind): void => {
    form.set('kind', kind);
    if (!values.nameEdited) form.set('name', DEFAULT_PROVIDER_NAME[kind] ?? '');
  };

  return (
    <>
      {provider === null ? (
        <>
          <AdminRadioField
            label={t('providerDialog.kind')}
            value={values.kind}
            options={kindOptions}
            onChange={chooseKind}
          />
          <AdminTextField
            {...form.field('name')}
            label={t('providerDialog.name')}
            value={values.name}
            mono
            hint={t('providerDialog.nameHint', {
              name:
                values.name === ''
                  ? t('providerDialog.namePlaceholder')
                  : values.name,
            })}
            onChange={(value) => {
              form.set('name', value);
              form.set('nameEdited', true);
            }}
          />
        </>
      ) : (
        // KD-3: name and type are fixed once added — text, not fields.
        <div className="flex flex-col gap-0.5">
          <p className="text-data wrap-break-word text-foreground">
            {t('providerDialog.fixed', {
              name: provider.name,
              kind: providerKindText(t, provider.kind).label,
            })}
          </p>
          <p className={cn(CAPTION, 'text-muted-foreground')}>
            {t('providerDialog.fixedHint')}
          </p>
        </div>
      )}
      <AdminTextField
        {...form.field('baseUrl')}
        label={t('providerDialog.baseUrl')}
        value={values.baseUrl}
        mono
        inputMode="url"
        hint={kindText.baseUrlHint}
        onChange={(value) => form.set('baseUrl', value)}
      />
      <SecretField
        {...form.field('apiKey')}
        label={
          provider === null
            ? t('providerDialog.apiKeyOptional')
            : t('providerDialog.apiKey')
        }
        isSet={provider?.apiKeySet ?? false}
        lastFour={provider?.apiKeyLast4}
        hint={kindText.apiKeyHint}
        value={values.apiKey}
        onChange={(value) => form.set('apiKey', value)}
      />
    </>
  );
}

type ModelProviderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` adds a provider; a provider is changed in place, its name and type never change. */
  provider: ModelProviderView | null;
  /** Re-reads the «Модели» section: after a save, and on closing once the provider turned out gone (KD-1). */
  reloadAll: () => void;
  /** The notice's «Проверить подключение»: the table's check of this provider. */
  checkConnection: (name: string) => void;
};

/**
 * UXRD MP-04: «Добавить провайдера» and «Изменить» — one dialog form. The key lives only in this form's state
 * and in the body of one request (KD-4); `secretFields` empties it after a successful save, and it never goes
 * into an address, a notice or the log (the form logs the event name and the request's shape only).
 */
export function ModelProviderDialog({
  open,
  onOpenChange,
  provider,
  reloadAll,
  checkConnection,
}: ModelProviderDialogProps) {
  const t = useTranslations('admin.models');
  const adding = provider === null;
  // The name of the saved provider, for the notice: the response's, not the form's.
  const savedName = useRef('');
  // A 404 on save: the error stays in the open dialog, the section is re-read once it closes (MP-04).
  const gone = useRef(false);

  const changeOpen = (next: boolean): void => {
    onOpenChange(next);
    if (!next && gone.current) {
      gone.current = false;
      reloadAll();
    }
  };

  const submit = async (values: ProviderValues): Promise<void> => {
    if (provider === null) {
      savedName.current = (
        await adminApi.modelProviders.create(createBodyOf(values))
      ).name;
      return;
    }
    try {
      savedName.current = (
        await adminApi.modelProviders.update(
          provider.name,
          updateBodyOf(provider, values),
        )
      ).name;
    } catch (error) {
      if (isNotFound(error)) gone.current = true;
      throw error;
    }
  };

  const saved = (): void => {
    const name = savedName.current;
    onOpenChange(false);
    reloadAll();
    // An edit always changed the address or the key (`hasChange`), so the check is offered after either save.
    toast.success(
      adding
        ? t('providerDialog.added', { name })
        : t('providerDialog.saved', { name }),
      {
        action: {
          label: t('providers.check'),
          onClick: () => checkConnection(name),
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="wrap-break-word">
            {adding
              ? t('providerDialog.addTitle')
              : t('providerDialog.editTitle', { name: provider.name })}
          </DialogTitle>
        </DialogHeader>
        <AdminForm
          key={provider?.name ?? 'new'}
          variant="dialog"
          initialValues={valuesOf(provider)}
          validate={(values) =>
            modelProviderRules({
              name: values.name,
              baseUrl: values.baseUrl,
              apiKey: values.apiKey ?? '',
            })
          }
          onSubmit={submit}
          submitLabel={
            adding ? t('providerDialog.add') : t('providerDialog.save')
          }
          // The contract refuses an empty `PATCH`: with nothing changed «Сохранить» sends nothing.
          hasChange={
            provider === null
              ? undefined
              : (values) =>
                  Object.keys(updateBodyOf(provider, values)).length > 0
          }
          onSaved={saved}
          secretFields={['apiKey']}
          errorContext={
            provider === null ? undefined : { providerName: provider.name }
          }
          logEvent={
            adding
              ? 'admin: model provider create'
              : 'admin: model provider save'
          }
        >
          {(form) => <ProviderFields form={form} provider={provider} />}
        </AdminForm>
      </DialogContent>
    </Dialog>
  );
}
