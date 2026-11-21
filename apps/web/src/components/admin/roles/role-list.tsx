'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { BUILTIN_ROLE_KEY, type RoleList as Roles, type RoleSummary } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { StateBadge } from '@/components/state-badge';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { builtinName } from '@/lib/i18n/builtin-name';
import type { Locale } from '@/lib/i18n/pick-locale';
import { adminRecordPath } from '@/lib/shell-route';
import { CONTROL_SIZE } from '../admin-form';
import { useAdminTitles } from '../admin-header';
import { DataTable, resourceTableState, type DataTableColumn, type DataTableRow } from '../data-table';
import { RoleNameDialog } from './role-name-dialog';

type RolesTranslator = ReturnType<typeof useTranslations<'admin.roles'>>;

/** DC-5: the built-in role first; the rest keep the server's order (by name), nothing is sorted here. */
const builtinFirst = (roles: Roles): Roles => [
  ...roles.filter((role) => role.builtin),
  ...roles.filter((role) => !role.builtin),
];

function toRow(role: RoleSummary, { t, locale }: { t: RolesTranslator; locale: Locale }): DataTableRow {
  const name = builtinName({ builtinKey: BUILTIN_ROLE_KEY, name: role.name }, locale);
  return {
    key: role.id,
    name,
    href: adminRecordPath('roles', role.id),
    cells: [
      <span key="name" className="flex min-w-0 items-center gap-2">
        <span className="truncate" title={name}>
          {name}
        </span>
        {role.builtin && <StateBadge variant="source">{t('builtin')}</StateBadge>}
      </span>,
      role.memberCount,
      // The «Администраторы» column: a word for yes, a dash for no (plan Notes 6).
      role.isAdmin ? t('isAdmin') : t('notAdmin'),
    ],
  };
}

/** UXRD AD-05: the roles list with «Создать роль». */
export function RoleList() {
  const titles = useAdminTitles();
  const t = useTranslations('admin.roles');
  const locale = useLocale();
  const roles = useResource(adminApi.roles.list, 'roles');
  const [creating, setCreating] = useState(false);

  // No empty state: the built-in role always exists.
  const state = resourceTableState(roles, t('listLoadFailed'), (data) => ({
    rows: builtinFirst(data).map((role) => toRow(role, { t, locale })),
  }));
  const columns: readonly DataTableColumn[] = [
    { header: t('role') },
    { header: t('memberCount'), align: 'end' },
    { header: t('admins') },
  ];

  return (
    <>
      <PageHeader area={titles.panel} title={titles.section('roles')}>
        <Button size="sm" className={CONTROL_SIZE} onClick={() => setCreating(true)}>
          {t('create')}
        </Button>
      </PageHeader>
      <DataTable caption={titles.section('roles')} columns={columns} state={state} />
      <RoleNameDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
