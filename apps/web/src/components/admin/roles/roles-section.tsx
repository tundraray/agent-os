'use client';

import {
  ADMIN_RECORD_TABS,
  type AdminPage,
  type AdminRecordTab,
} from '@/lib/shell-route';
import { RoleList } from './role-list';
import { RolePage } from './role-page';

type RolesSectionProps = { page: AdminPage };

const isRoleTab = (
  tab: AdminRecordTab | undefined,
): tab is AdminRecordTab<'roles'> =>
  ADMIN_RECORD_TABS.roles.some((roleTab) => roleTab === tab);

/**
 * The «Роли» section: a role's page (AD-06) on its record address, the list (AD-05) on every other. The page is
 * keyed by the role alone: a tab change keeps it, and with it the unsaved levels.
 */
export function RolesSection({ page }: RolesSectionProps) {
  return page.kind === 'record' ? (
    <RolePage
      key={page.key}
      id={page.key}
      tab={isRoleTab(page.tab) ? page.tab : 'tools'}
    />
  ) : (
    <RoleList />
  );
}
