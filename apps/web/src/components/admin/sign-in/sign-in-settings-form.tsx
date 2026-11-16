'use client';

import { useId } from 'react';
import type { SignInSettings } from '@agent-os/contracts';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import {
  hoursToMinutes,
  minutesToHours,
  signInSettingsRules,
  type SignInSettingsValues,
} from '@/lib/admin/form-rules';
import { apiBaseUrl } from '@/lib/config';
import { cn } from '@/lib/utils';
import { AdminForm, AdminTextField, CAPTION } from '../admin-form';
import { DataTable, resourceTableState } from '../data-table';

/** UXRD MC-33; «Сохранить» — MC-20. */
const TEXT = {
  title: 'Настройки входа',
  publicUrl: 'Публичный адрес Agent OS',
  idle: 'Без активности',
  absolute: 'Всего с момента входа',
  hours: 'часов',
  idleHint: 'От 0,25 до 24 часов.',
  absoluteHint: 'От 1 до 720 часов (30 суток), не меньше срока без активности.',
  note: 'Новые сроки действуют и для уже вошедших сотрудников — с их следующего запроса. Новый адрес перенесите в «Данные для провайдера» у каждого провайдера.',
  save: 'Сохранить',
  saved: 'Настройки входа сохранены',
  // Not in the UXRD: the read failure follows the panel's «Не удалось загрузить …» texts.
  loadFailed: 'Не удалось загрузить настройки входа',
} as const;

/** DC-7: the form shows hours; until an address is saved, the address of the API this web talks to. */
const valuesOf = (settings: SignInSettings): SignInSettingsValues => ({
  publicUrl: settings.publicUrl ?? new URL(apiBaseUrl).origin,
  idleHours: minutesToHours(settings.idleMinutes),
  absoluteHours: minutesToHours(settings.absoluteMinutes),
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

export function SignInSettingsForm() {
  const headingId = useId();
  const settings = useResource(adminApi.signInSettings.get, 'sign-in-settings');
  const data = settings.data;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {TEXT.title}
      </h2>
      {data === undefined ? (
        <DataTable caption={TEXT.title} columns={[]} state={resourceTableState(settings, TEXT.loadFailed)} />
      ) : (
        <>
          {/* Every save moves `updatedAt`: the new read starts the form from the values the server now holds. */}
          <AdminForm
            key={data.updatedAt ?? 'defaults'}
            variant="page"
            initialValues={valuesOf(data)}
            validate={signInSettingsRules}
            onSubmit={save}
            submitLabel={TEXT.save}
            savedText={TEXT.saved}
            onSaved={settings.reload}
            logEvent="admin: sign-in settings"
          >
            {(form) => (
              <>
                <AdminTextField
                  {...form.field('publicUrl')}
                  label={TEXT.publicUrl}
                  mono
                  type="url"
                  inputMode="url"
                  value={form.values.publicUrl}
                  onChange={(value) => form.set('publicUrl', value)}
                />
                <AdminTextField
                  {...form.field('idleHours')}
                  label={TEXT.idle}
                  hint={TEXT.idleHint}
                  inputMode="decimal"
                  suffix={TEXT.hours}
                  inputClassName="w-24"
                  value={form.values.idleHours}
                  onChange={(value) => form.set('idleHours', value)}
                />
                <AdminTextField
                  {...form.field('absoluteHours')}
                  label={TEXT.absolute}
                  hint={TEXT.absoluteHint}
                  inputMode="decimal"
                  suffix={TEXT.hours}
                  inputClassName="w-24"
                  value={form.values.absoluteHours}
                  onChange={(value) => form.set('absoluteHours', value)}
                />
              </>
            )}
          </AdminForm>
          <p className={cn(CAPTION, 'max-w-160 text-muted-foreground')}>{TEXT.note}</p>
        </>
      )}
    </section>
  );
}
