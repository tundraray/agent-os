'use client';

import type { AdminPage } from '@/lib/shell-route';
import { RoleList } from './role-list';
import { RolePage } from './role-page';

type RolesSectionProps = { page: AdminPage };

/** The «Роли» section: a role's page (AD-06) on its record address, the list (AD-05) on every other. */
export function RolesSection({ page }: RolesSectionProps) {
  return page.kind === 'record' ? <RolePage key={page.key} id={page.key} /> : <RoleList />;
}
