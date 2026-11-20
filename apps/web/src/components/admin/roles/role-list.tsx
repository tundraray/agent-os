'use client';

import { useState } from 'react';
import type { RoleList as Roles, RoleSummary } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { StateBadge } from '@/components/state-badge';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { adminRecordPath } from '@/lib/shell-route';
import { CONTROL_SIZE } from '../admin-form';
import { PANEL_TITLE } from '../admin-header';
import { adminSectionTitle } from '../admin-sections';
import { DataTable, resourceTableState, type DataTableColumn, type DataTableRow } from '../data-table';
import { RoleNameDialog } from './role-name-dialog';

/** UXRD MC-26; «да» / «—» of «Администраторы» — plan Notes 6. */
const TEXT = {
  create: 'Создать роль',
  builtin: 'встроенная',
  isAdmin: 'да',
  notAdmin: '—',
  loadFailed: 'Не удалось загрузить роли',
} as const;

const COLUMNS: readonly DataTableColumn[] = [
  { header: 'Роль' },
  { header: 'Сотрудников', align: 'end' },
  { header: 'Администраторы' },
];

/** DC-5: the built-in role first; the rest keep the server's order (by name), nothing is sorted here. */
const builtinFirst = (roles: Roles): Roles => [
  ...roles.filter((role) => role.builtin),
  ...roles.filter((role) => !role.builtin),
];

const toRow = (role: RoleSummary): DataTableRow => ({
  key: role.id,
  name: role.name,
  href: adminRecordPath('roles', role.id),
  cells: [
    <span key="name" className="flex min-w-0 items-center gap-2">
      <span className="truncate" title={role.name}>
        {role.name}
      </span>
      {role.builtin && <StateBadge variant="source">{TEXT.builtin}</StateBadge>}
    </span>,
    role.memberCount,
    role.isAdmin ? TEXT.isAdmin : TEXT.notAdmin,
  ],
});

/** UXRD AD-05: the roles list with «Создать роль». */
export function RoleList() {
  const roles = useResource(adminApi.roles.list, 'roles');
  const [creating, setCreating] = useState(false);

  // No empty state: the built-in role always exists.
  const state = resourceTableState(roles, TEXT.loadFailed, (data) => ({ rows: builtinFirst(data).map(toRow) }));

  return (
    <>
      <PageHeader area={PANEL_TITLE} title={adminSectionTitle('roles')}>
        <Button size="sm" className={CONTROL_SIZE} onClick={() => setCreating(true)}>
          {TEXT.create}
        </Button>
      </PageHeader>
      <DataTable caption={adminSectionTitle('roles')} columns={COLUMNS} state={state} />
      <RoleNameDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
