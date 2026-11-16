'use client';

import { useId } from 'react';
import { KeyRoundIcon } from 'lucide-react';
import type { ProviderSummary, ProviderType } from '@agent-os/contracts';
import { StateBadge } from '@/components/state-badge';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { rereadOnNotFound } from '@/lib/admin/admin-errors';
import { adminRecordPath } from '@/lib/shell-route';
import { FormWarning } from '../admin-form';
import { DataTable, resourceTableState, type DataTableColumn, type DataTableRow } from '../data-table';
import { SavingSwitch } from '../saving-switch';

/** UXRD MC-27. */
const TEXT = {
  title: 'Способы входа',
  button: 'Кнопка',
  enabled: 'Включено',
  password: 'Логин и пароль',
  builtin: 'встроенный',
  alwaysOn: 'Всегда включён',
  googleWarning:
    'Включённый Google пускает любого владельца аккаунта Google: первый вход создаёт учётную запись без ролей. Пока вы не дадите ей права, чат ей не отвечает.',
  // Not in the UXRD: the read failure follows the panel's «Не удалось загрузить …» texts.
  loadFailed: 'Не удалось загрузить способы входа',
  // Never shown: the built-in row is always there; DataTable needs an empty state all the same.
  empty: 'Способов входа нет',
} as const;

/** MC-27: the provider fields the new form and the provider page share. */
export const PROVIDER_TEXT = {
  type: 'Тип',
  name: 'Название кнопки',
  nameHint: (name: string) => `Сотрудники увидят «Войти через ${name.trim()}»`,
} as const;

/** MC-27: the provider types of the first version as the panel names them. */
export const PROVIDER_TYPE_LABEL: Readonly<Record<ProviderType, string>> = { google: 'Google', oidc: 'OIDC' };

/** MC-27: under «Тип» of the new form and under the header of a Google provider's page. */
export function GoogleWarning() {
  return (
    <FormWarning>{TEXT.googleWarning}</FormWarning>
  );
}

type ProviderEnabledSwitchProps = {
  provider: Pick<ProviderSummary, 'id' | 'name' | 'enabled'>;
  /** In a table row the column names the switch: «Включено: {название}», read but not shown. */
  inTable: boolean;
  /** Reads the screen's resource again: after a save, and after a 404 (Error handling, a row action). */
  onChanged: () => void;
};

/**
 * DC-8: «Включено» of a provider, in its table row and on its page. A refused enable (`PROVIDER_INCOMPLETE`,
 * `PUBLIC_URL_REQUIRED`) puts the switch back with the MC-27 or Notes 6 text under it.
 */
export function ProviderEnabledSwitch({ provider, inTable, onChanged }: ProviderEnabledSwitchProps) {
  const save = async (enabled: boolean): Promise<void> => {
    await rereadOnNotFound(onChanged)(() => adminApi.providers.update(provider.id, { enabled }));
    onChanged();
  };

  return (
    <SavingSwitch
      label={inTable ? `${TEXT.enabled}: ${provider.name}` : TEXT.enabled}
      labelHidden={inTable}
      checked={provider.enabled}
      onSave={save}
      logEvent="admin: provider enable"
    />
  );
}

const COLUMNS: readonly DataTableColumn[] = [
  { header: TEXT.button },
  { header: PROVIDER_TEXT.type },
  { header: TEXT.enabled },
];

/** FR-01: the password sign-in is always on; it is not in the response and not a link. */
const PASSWORD_ROW: DataTableRow = {
  key: 'password',
  name: TEXT.password,
  cells: [
    TEXT.password,
    TEXT.builtin,
    <StateBadge key="enabled" state="ok">
      {TEXT.alwaysOn}
    </StateBadge>,
  ],
};

/** UXRD AD-07: the sign-in methods — the password row, then the providers in creation order as link rows. */
export function ProvidersTable() {
  const headingId = useId();
  const providers = useResource(adminApi.providers.list, 'providers');

  const toRow = (provider: ProviderSummary): DataTableRow => ({
    key: provider.id,
    name: provider.name,
    href: adminRecordPath('sign-in', provider.id),
    cells: [
      <span key="name" className="block truncate" title={provider.name}>
        {provider.name}
      </span>,
      PROVIDER_TYPE_LABEL[provider.type],
      // Above the row link's overlay, so the switch takes the press instead of opening the provider.
      <div key="enabled" className="relative z-10">
        <ProviderEnabledSwitch provider={provider} inTable onChanged={providers.reload} />
      </div>,
    ],
  });

  const state = resourceTableState(providers, TEXT.loadFailed, (data) => ({
    rows: [PASSWORD_ROW, ...data.map(toRow)],
    empty: { Icon: KeyRoundIcon, title: TEXT.empty, description: '' },
  }));

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {TEXT.title}
      </h2>
      <DataTable caption={TEXT.title} columns={COLUMNS} state={state} />
    </section>
  );
}
