'use client';

import { useId } from 'react';
import { useRouter } from 'next/navigation';
import { PROVIDER_NAME_MAX_LENGTH, ProviderTypeSchema, type ProviderType } from '@agent-os/contracts';
import { FieldDescription, FieldLegend, FieldSet } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { adminApi } from '@/lib/admin/admin-api';
import { providerRules } from '@/lib/admin/form-rules';
import { cn } from '@/lib/utils';
import { adminPath, adminRecordPath } from '@/lib/shell-route';
import { AdminForm, AdminTextField, CAPTION, type AdminFormApi } from '../admin-form';
import { AdminPageHeader } from '../admin-header';
import { GoogleWarning, PROVIDER_TEXT, PROVIDER_TYPE_LABEL } from './providers-table';

/** UXRD MC-27; the title is the UXRD's name of the screen. */
const TEXT = {
  title: 'Новый провайдер',
  oidcHint: 'Okta и любой корпоративный IdP по OIDC',
  create: 'Создать',
} as const;

const TYPES: readonly ProviderType[] = ['google', 'oidc'];

type NewProviderValues = { type: ProviderType; name: string };

const INITIAL: NewProviderValues = { type: 'google', name: PROVIDER_TYPE_LABEL.google };

/**
 * UXRD «Новый провайдер»: the type and the button's name. «Создать» saves a disabled provider and opens its
 * page, where its settings and «Данные для провайдера» are.
 */
export function NewProviderForm() {
  const router = useRouter();

  const create = async ({ type, name }: NewProviderValues): Promise<void> => {
    const created = await adminApi.providers.create({ type, name: name.trim() });
    router.push(adminRecordPath('sign-in', created.id));
  };

  return (
    <>
      <AdminPageHeader title={TEXT.title} parent="sign-in" />
      <AdminForm
        variant="page"
        initialValues={INITIAL}
        validate={({ name }) => providerRules({ name })}
        onSubmit={create}
        submitLabel={TEXT.create}
        savedText={null}
        onCancel={() => router.push(adminPath('sign-in'))}
        logEvent="admin: provider create"
      >
        {(form) => (
          <>
            <TypeField form={form} />
            <AdminTextField
              {...form.field('name')}
              label={PROVIDER_TEXT.name}
              hint={PROVIDER_TEXT.nameHint(form.values.name)}
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

function TypeField({ form }: { form: AdminFormApi<NewProviderValues> }) {
  const legendId = useId();
  const oidcHintId = useId();

  const choose = (value: unknown): void => {
    const type = ProviderTypeSchema.safeParse(value);
    if (!type.success) return;
    form.set('type', type.data);
    // The Google name is a default: it follows the type until the administrator types a name of their own.
    const { name } = form.values;
    if (name.trim() === '' || name === PROVIDER_TYPE_LABEL.google) {
      form.set('name', type.data === 'google' ? PROVIDER_TYPE_LABEL.google : '');
    }
  };

  return (
    <FieldSet className="gap-1.5">
      <FieldLegend id={legendId} variant="label" className="mb-0 text-data font-medium text-foreground">
        {PROVIDER_TEXT.type}
      </FieldLegend>
      <RadioGroup aria-labelledby={legendId} value={form.values.type} onValueChange={choose} className="gap-2">
        {TYPES.map((type) => (
          <div key={type} className="flex flex-col gap-0.5">
            <Label className="flex w-fit items-center gap-2 text-data font-normal text-foreground pointer-coarse:min-h-11">
              <RadioGroupItem value={type} aria-describedby={type === 'oidc' ? oidcHintId : undefined} />
              {PROVIDER_TYPE_LABEL[type]}
            </Label>
            {type === 'oidc' && (
              <FieldDescription id={oidcHintId} className={cn(CAPTION, 'pl-6 text-muted-foreground')}>
                {TEXT.oidcHint}
              </FieldDescription>
            )}
          </div>
        ))}
      </RadioGroup>
      {form.values.type === 'google' && <GoogleWarning />}
    </FieldSet>
  );
}
