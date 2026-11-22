'use client';

import { useId } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { SignInSettings } from '@agent-os/contracts';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import {
  hoursToMinutes,
  minutesToHours,
  signInSettingsRules,
  type SignInSettingsValues,
} from '@/lib/admin/form-rules';
import type { Formatter } from '@/i18n/formats';
import { cn } from '@/lib/utils';
import { AdminForm, AdminTextField, CAPTION } from '../admin-form';
import { DataTable, resourceTableState } from '../data-table';

/**
 * DC-7: the form shows hours; until an address is saved, the address the administrator opened the web at,
 * which is also where the browser reaches the API. Runs only on `useResource` data, so in the browser.
 */
const valuesOf = (format: Formatter, settings: SignInSettings): SignInSettingsValues => ({
  publicUrl: settings.publicUrl ?? window.location.origin,
  idleHours: minutesToHours(format, settings.idleMinutes),
  absoluteHours: minutesToHours(format, settings.absoluteMinutes),
});

/**
 * UXRD AD-14: one form, one «Сохранить» — the address and both limits go in one `PUT`, in minutes (FR-26).
 * Called after `signInSettingsRules` passed, so both hours read as numbers.
 */
async function save({ publicUrl, idleHours, absoluteHours }: SignInSettingsValues): Promise<void> {
  await adminApi.signInSettings.update({
    publicUrl: publicUrl.trim(),
    idleMinutes: minutesOf(idleHours),
    absoluteMinutes: minutesOf(absoluteHours),
  });
}

function minutesOf(hours: string): number {
  const minutes = hoursToMinutes(hours);
  if (minutes === null) throw new Error('Sign-in settings: hours were sent unchecked');
  return minutes;
}

/** UXRD AD-14 (texts MC-33, `admin.signIn.settings`). */
export function SignInSettingsForm() {
  const headingId = useId();
  const t = useTranslations('admin.signIn.settings');
  const format = useFormatter();
  const settings = useResource(adminApi.signInSettings.get, 'sign-in-settings');
  const data = settings.data;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {t('title')}
      </h2>
      {data === undefined ? (
        <DataTable caption={t('title')} columns={[]} state={resourceTableState(settings, t('loadFailed'))} />
      ) : (
        <>
          {/* Every save moves `updatedAt`: the new read starts the form from the values the server now holds. */}
          <AdminForm
            key={data.updatedAt ?? 'defaults'}
            variant="page"
            initialValues={valuesOf(format, data)}
            validate={signInSettingsRules}
            onSubmit={save}
            submitLabel={t('save')}
            savedText={t('saved')}
            onSaved={settings.reload}
            logEvent="admin: sign-in settings"
          >
            {(form) => (
              <>
                <AdminTextField
                  {...form.field('publicUrl')}
                  label={t('publicUrl')}
                  mono
                  type="url"
                  inputMode="url"
                  value={form.values.publicUrl}
                  onChange={(value) => form.set('publicUrl', value)}
                />
                <AdminTextField
                  {...form.field('idleHours')}
                  label={t('idle')}
                  hint={t('idleHint')}
                  inputMode="decimal"
                  suffix={t('hours')}
                  inputClassName="w-24"
                  value={form.values.idleHours}
                  onChange={(value) => form.set('idleHours', value)}
                />
                <AdminTextField
                  {...form.field('absoluteHours')}
                  label={t('absolute')}
                  hint={t('absoluteHint')}
                  inputMode="decimal"
                  suffix={t('hours')}
                  inputClassName="w-24"
                  value={form.values.absoluteHours}
                  onChange={(value) => form.set('absoluteHours', value)}
                />
              </>
            )}
          </AdminForm>
          <p className={cn(CAPTION, 'max-w-160 text-muted-foreground')}>{t('note')}</p>
        </>
      )}
    </section>
  );
}
