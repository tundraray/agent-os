'use client';

import { useId, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  IdentityErrorCode,
  PROVIDER_NAME_MAX_LENGTH,
  type ProviderView,
  type UpdateProviderBody,
} from '@agent-os/contracts';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { StateBadge } from '@/components/state-badge';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { isNotFound } from '@/lib/admin/admin-errors';
import { ADMIN_TEXT } from '@/lib/admin/admin-texts';
import { providerRules } from '@/lib/admin/form-rules';
import { isApiRequestError } from '@/lib/api/api-request';
import { cn } from '@/lib/utils';
import { adminPath } from '@/lib/shell-route';
import { AdminForm, AdminTextField, CAPTION } from '../admin-form';
import { AdminPageHeader, RecordPlaceholder } from '../admin-header';
import { CopyValue } from '../copy-value';
import { SecretField } from '../secret-field';
import { GoogleWarning, PROVIDER_TEXT, PROVIDER_TYPE_LABEL, ProviderEnabledSwitch } from './providers-table';

/** UXRD MC-27; «Сохранить» — MC-20. */
const TEXT = {
  on: 'Включено',
  off: 'Выключен',
  settings: 'Настройки провайдера',
  issuer: 'Issuer',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  providerData: 'Данные для провайдера',
  providerDataHint: 'Перенесите эти значения в настройки приложения Agent OS у провайдера',
  redirectUri: 'Адрес возврата',
  scopes: 'Scopes',
  save: 'Сохранить',
  // Not in the UXRD: the read failure follows the panel's «Не удалось загрузить …» texts.
  loadFailed: 'Не удалось загрузить провайдера',
} as const;

type ProviderValues = {
  name: string;
  /** Only an `oidc` provider shows the field. */
  issuer: string;
  clientId: string;
  /** The replacement of the client secret; `undefined` while there is none (Invariant 3). */
  clientSecret: string | undefined;
};

const valuesOf = ({ name, options }: ProviderView): ProviderValues => ({
  name,
  issuer: options.issuer ?? '',
  clientId: options.clientId ?? '',
  clientSecret: undefined,
});

/**
 * The `PATCH` body: empty fields and a secret without a replacement stay out of it, so a save never clears a
 * stored value and the stored secret is never sent back (design-admin.md, Contract `SecretField`).
 */
function updateBodyOf(type: ProviderView['type'], { name, issuer, clientId, clientSecret }: ProviderValues): UpdateProviderBody {
  const options: NonNullable<UpdateProviderBody['options']> = {};
  if (type === 'oidc' && issuer.trim() !== '') options.issuer = issuer.trim();
  if (clientId.trim() !== '') options.clientId = clientId.trim();
  if (clientSecret !== undefined && clientSecret !== '') options.clientSecret = clientSecret;
  return Object.keys(options).length === 0 ? { name: name.trim() } : { name: name.trim(), options };
}

const isPublicUrlRequired = (error: unknown): boolean =>
  isApiRequestError(error) && error.code === IdentityErrorCode.PUBLIC_URL_REQUIRED;

/**
 * UXRD «Провайдер»: the switch, the button's name, the settings of the provider's type (AC-26.4) with the
 * client secret as a `SecretField`, and the values to copy into the app at the provider (AC-26.1).
 */
export function ProviderPage({ id }: { id: string }) {
  const router = useRouter();
  const provider = useResource(() => adminApi.providers.get(id), `provider:${id}`);

  if (isNotFound(provider.error)) return <ThreadNotice variant="record-not-found" section="sign-in" />;

  const data = provider.data;
  if (data === undefined) {
    return (
      <RecordPlaceholder
        section="sign-in"
        resource={provider}
        // Notes 6: the provider's data are built from the public address, which cannot be derived here.
        loadFailed={isPublicUrlRequired(provider.error) ? ADMIN_TEXT.publicUrlRequired : TEXT.loadFailed}
      />
    );
  }

  const isOidc = data.type === 'oidc';

  return (
    <>
      <AdminPageHeader
        title={data.name}
        parent="sign-in"
        badge={<StateBadge state={data.enabled ? 'ok' : 'off'}>{data.enabled ? TEXT.on : TEXT.off}</StateBadge>}
      />
      <div className="flex max-w-160 flex-col gap-6">
        <ProviderEnabledSwitch provider={data} inTable={false} onChanged={provider.reload} />
        {data.type === 'google' && <GoogleWarning />}

        <AdminForm
          variant="page"
          initialValues={valuesOf(data)}
          validate={({ name, issuer }) => providerRules({ name, issuer: isOidc && issuer.trim() !== '' ? issuer : undefined })}
          onSubmit={async (values) => {
            await adminApi.providers.update(id, updateBodyOf(data.type, values));
          }}
          submitLabel={TEXT.save}
          onSaved={provider.reload}
          onCancel={() => router.push(adminPath('sign-in'))}
          secretFields={['clientSecret']}
          logEvent="admin: provider save"
        >
          {(form) => (
            <>
              <ReadOnlyValue label={PROVIDER_TEXT.type}>{PROVIDER_TYPE_LABEL[data.type]}</ReadOnlyValue>
              <AdminTextField
                {...form.field('name')}
                label={PROVIDER_TEXT.name}
                hint={PROVIDER_TEXT.nameHint(form.values.name)}
                maxLength={PROVIDER_NAME_MAX_LENGTH}
                value={form.values.name}
                onChange={(value) => form.set('name', value)}
              />
              <Group title={TEXT.settings}>
                {isOidc && (
                  <AdminTextField
                    {...form.field('issuer')}
                    label={TEXT.issuer}
                    mono
                    type="url"
                    inputMode="url"
                    value={form.values.issuer}
                    onChange={(value) => form.set('issuer', value)}
                  />
                )}
                <AdminTextField
                  {...form.field('clientId')}
                  label={TEXT.clientId}
                  mono
                  value={form.values.clientId}
                  onChange={(value) => form.set('clientId', value)}
                />
                <SecretField
                  {...form.field('clientSecret')}
                  label={TEXT.clientSecret}
                  isSet={data.options.clientSecretSet}
                  value={form.values.clientSecret}
                  onChange={(value) => form.set('clientSecret', value)}
                />
              </Group>
            </>
          )}
        </AdminForm>

        <Group title={TEXT.providerData} hint={TEXT.providerDataHint}>
          <CopyValue label={TEXT.redirectUri} value={data.providerData.redirectUri} />
          {isOidc && <CopyValue label={TEXT.scopes} value={data.providerData.scopes} />}
        </Group>
      </div>
    </>
  );
}

/** settings-form «Группа»: a Heading over its fields. */
function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 pt-2">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-base leading-6 font-semibold">
          {title}
        </h2>
        {hint !== undefined && <p className={cn(CAPTION, 'text-muted-foreground')}>{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** «Тип» never changes: a label over plain text, no input. */
function ReadOnlyValue({ label, children }: { label: string; children: string }) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <div id={labelId} className="text-data font-medium text-foreground">
        {label}
      </div>
      <p className="text-data text-foreground">{children}</p>
    </div>
  );
}
