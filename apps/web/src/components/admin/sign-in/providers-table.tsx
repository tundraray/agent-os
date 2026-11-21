'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import type { ProviderSummary, ProviderType } from '@agent-os/contracts';
import { StateBadge } from '@/components/state-badge';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { rereadOnNotFound } from '@/lib/admin/admin-errors';
import { adminRecordPath } from '@/lib/shell-route';
import { FormWarning } from '../admin-form';
import { DataTable, resourceTableState, type DataTableColumn, type DataTableRow } from '../data-table';
import { SavingSwitch } from '../saving-switch';

/** UXRD MC-27 (`admin.signIn`): the texts the table, the new form and the provider page share. */
type SignInTranslator = ReturnType<typeof useTranslations<'admin.signIn'>>;

/** MC-27: the provider types of the first version as the panel names them — the same in every language (KD-7). */
export const PROVIDER_TYPE_LABEL: Readonly<Record<ProviderType, string>> = { google: 'Google', oidc: 'OIDC' };

/** MC-27: under «Тип» of the new form and under the header of a Google provider's page. */
export function GoogleWarning() {
  const t = useTranslations('admin.signIn');
  return (
    <FormWarning>{t('googleWarning')}</FormWarning>
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
 * `PUBLIC_URL_REQUIRED`) puts the switch back with its MC-27 text under it.
 */
export function ProviderEnabledSwitch({ provider, inTable, onChanged }: ProviderEnabledSwitchProps) {
  const t = useTranslations('admin.signIn');
  const save = async (enabled: boolean): Promise<void> => {
    await rereadOnNotFound(onChanged)(() => adminApi.providers.update(provider.id, { enabled }));
    onChanged();
  };

  return (
    <SavingSwitch
      label={inTable ? t('enabledSwitch', { name: provider.name }) : t('enabled')}
      labelOff={t('disabled')}
      labelHidden={inTable}
      checked={provider.enabled}
      onSave={save}
      logEvent="admin: provider enable"
    />
  );
}

const columns = (t: SignInTranslator): readonly DataTableColumn[] => [
  { header: t('button') },
  { header: t('type') },
  { header: t('enabled') },
];

/** FR-01: the password sign-in is always on; it is not in the response and not a link. */
const passwordRow = (t: SignInTranslator): DataTableRow => ({
  key: 'password',
  name: t('password'),
  cells: [
    t('password'),
    t('builtin'),
    <StateBadge key="enabled" state="ok">
      {t('alwaysOn')}
    </StateBadge>,
  ],
});

/** UXRD AD-07: the sign-in methods — the password row, then the providers in creation order as link rows. */
export function ProvidersTable() {
  const headingId = useId();
  const t = useTranslations('admin.signIn');
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

  // No empty state: the password row is always there.
  const state = resourceTableState(providers, t('methodsLoadFailed'), (data) => ({ rows: [passwordRow(t), ...data.map(toRow)] }));

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {t('methods')}
      </h2>
      <DataTable caption={t('methods')} columns={columns(t)} state={state} />
    </section>
  );
}
