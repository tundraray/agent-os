'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  PROVIDER_NAME_MAX_LENGTH,
  type ProviderType,
} from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { adminApi } from '@/lib/admin/admin-api';
import { providerRules } from '@/lib/admin/form-rules';
import { adminPath, adminRecordPath } from '@/lib/shell-route';
import {
  AdminForm,
  AdminRadioField,
  AdminTextField,
  type AdminFormApi,
  type AdminRadioOption,
} from '../admin-form';
import { useAdminTitles } from '../admin-header';
import { GoogleWarning, PROVIDER_TYPE_LABEL } from './providers-table';

type NewProviderValues = { type: ProviderType; name: string };

const INITIAL: NewProviderValues = {
  type: 'google',
  name: PROVIDER_TYPE_LABEL.google,
};

/** The Google name is a default: it follows the type until the administrator types a name of their own. */
function chooseType(
  form: AdminFormApi<NewProviderValues>,
  type: ProviderType,
): void {
  form.set('type', type);
  const { name } = form.values;
  if (name.trim() === '' || name === PROVIDER_TYPE_LABEL.google) {
    form.set('name', type === 'google' ? PROVIDER_TYPE_LABEL.google : '');
  }
}

/**
 * UXRD «Новый провайдер»: the type and the button's name. «Создать» saves a disabled provider and opens its
 * page, where its settings and «Данные для провайдера» are.
 */
export function NewProviderForm() {
  const titles = useAdminTitles();
  const t = useTranslations('admin.signIn');
  const router = useRouter();
  const types: readonly AdminRadioOption<ProviderType>[] = [
    { value: 'google', label: PROVIDER_TYPE_LABEL.google },
    {
      value: 'oidc',
      label: PROVIDER_TYPE_LABEL.oidc,
      hint: t('newProvider.oidcHint'),
    },
  ];

  const create = async ({ type, name }: NewProviderValues): Promise<void> => {
    const created = await adminApi.providers.create({
      type,
      name: name.trim(),
    });
    router.push(adminRecordPath('sign-in', created.id));
  };

  return (
    <>
      <PageHeader
        area={titles.panel}
        title={t('newProvider.title')}
        parent={titles.parent('sign-in')}
      />
      <AdminForm
        variant="page"
        initialValues={INITIAL}
        validate={({ name }) => providerRules({ name })}
        onSubmit={create}
        submitLabel={t('newProvider.create')}
        savedText={null}
        onCancel={() => router.push(adminPath('sign-in'))}
        logEvent="admin: provider create"
      >
        {(form) => (
          <>
            <AdminRadioField
              label={t('type')}
              value={form.values.type}
              options={types}
              onChange={(type) => chooseType(form, type)}
            />
            {form.values.type === 'google' && <GoogleWarning />}
            <AdminTextField
              {...form.field('name')}
              label={t('name')}
              hint={t('nameHint', { name: form.values.name.trim() })}
              maxLength={PROVIDER_NAME_MAX_LENGTH}
              value={form.values.name}
              onChange={(value) => form.set('name', value)}
            />
          </>
        )}
      </AdminForm>
    </>
  );
}
