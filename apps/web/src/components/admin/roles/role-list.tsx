'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { RoleList as Roles, RoleSummary } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StateBadge } from '@/components/state-badge';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { builtinRoleName } from '@/i18n/builtin-name';
import type { Locale } from '@/i18n/pick-locale';
import { adminRecordPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { CONTROL_SIZE } from '../admin-form';
import { useAdminTitles } from '../admin-header';
import {
  DataTable,
  resourceTableState,
  type DataTableColumn,
  type DataTableRow,
} from '../data-table';
import { RoleNameDialog } from './role-name-dialog';

type RolesTranslator = ReturnType<typeof useTranslations<'admin.roles'>>;

/** UXRD AD-05: «Супер-администратор», then «Все сотрудники», then the rest in the server's order (by name). */
const BUILTIN_ORDER = ['super_admin', 'everyone'] as const;

const builtinFirst = (roles: Roles): Roles => [
  ...BUILTIN_ORDER.flatMap((kind) =>
    roles.filter((role) => role.builtinKind === kind),
  ),
  ...roles.filter((role) => role.builtinKind === null),
];

function toRow(
  role: RoleSummary,
  name: string,
  t: RolesTranslator,
): DataTableRow {
  return {
    key: role.id,
    name,
    href: adminRecordPath('roles', role.id),
    cells: [
      <span key="name" className="flex min-w-0 items-center gap-2">
        <span className="truncate" title={name}>
          {name}
        </span>
        {role.builtinKind !== null && (
          <StateBadge variant="source">{t('builtin')}</StateBadge>
        )}
      </span>,
      // «Все сотрудники» holds every employee: no count, the word «все» (AC-38.2).
      role.memberCount ?? t('everyoneCount'),
      // The «Администраторы» column: a word for yes, a dash for no (plan Notes 6).
      role.isAdmin ? t('isAdmin') : t('notAdmin'),
    ],
  };
}

/** By the name the screen shows, case-insensitive, from the first letter (AD-05 «Найти роль»). */
function visibleRows(
  roles: Roles,
  { query, locale, t }: { query: string; locale: Locale; t: RolesTranslator },
): DataTableRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return builtinFirst(roles).flatMap((role) => {
    const name = builtinRoleName(role.name, locale);
    return name.toLocaleLowerCase().includes(needle)
      ? [toRow(role, name, t)]
      : [];
  });
}

/** UXRD AD-05: the roles list with its search and «Создать роль». */
export function RoleList() {
  const titles = useAdminTitles();
  const t = useTranslations('admin.roles');
  const locale = useLocale();
  const roles = useResource(adminApi.roles.list, 'roles');
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');

  // No empty state: the built-in roles always exist, so an empty table is a search without matches.
  const state = resourceTableState(roles, t('listLoadFailed'), (data) => ({
    rows: visibleRows(data, { query, locale, t }),
    noMatches: query.trim() === '' ? undefined : t('noMatches'),
  }));
  const columns: readonly DataTableColumn[] = [
    { header: t('role') },
    { header: t('memberCount'), align: 'end' },
    { header: t('admins') },
  ];

  return (
    <>
      <PageHeader area={titles.panel} title={titles.section('roles')}>
        <Button
          size="sm"
          className={CONTROL_SIZE}
          onClick={() => setCreating(true)}
        >
          {t('create')}
        </Button>
      </PageHeader>
      <div className="flex flex-col gap-3">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t('search')}
          placeholder={t('search')}
          className={cn(CONTROL_SIZE, 'text-data md:w-72 md:text-data')}
        />
        <DataTable
          caption={titles.section('roles')}
          columns={columns}
          state={state}
        />
      </div>
      <RoleNameDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
