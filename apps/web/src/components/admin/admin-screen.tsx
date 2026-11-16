'use client';

import type { AdminPage, AdminSection } from '@/lib/shell-route';
import { RolesSection } from './roles/roles-section';
import { UsersSection } from './users/users-section';

type AdminScreenProps = { section: AdminSection; page: AdminPage };

/**
 * The section screen of a panel address; mounted by `AdminGate` for an administrator only. A section whose
 * screen is not built yet shows nothing.
 */
export function AdminScreen({ section, page }: AdminScreenProps) {
  switch (section) {
    case 'users':
      return <UsersSection page={page} />;
    case 'roles':
      return <RolesSection page={page} />;
    case 'sign-in':
    case 'servers':
    case 'models':
      return null;
  }
}
