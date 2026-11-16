'use client';

import type { AdminPage, AdminSection } from '@/lib/shell-route';
import { CatalogSection } from './models/catalog-section';
import { RolesSection } from './roles/roles-section';
import { ServersSection } from './servers/servers-section';
import { SignInSection } from './sign-in/sign-in-section';
import { UsersSection } from './users/users-section';

type AdminScreenProps = { section: AdminSection; page: AdminPage };

/**
 * The section screen of a panel address; mounted by `AdminGate` for an administrator only.
 */
export function AdminScreen({ section, page }: AdminScreenProps) {
  switch (section) {
    case 'users':
      return <UsersSection page={page} />;
    case 'roles':
      return <RolesSection page={page} />;
    case 'models':
      return <CatalogSection />;
    case 'sign-in':
      return <SignInSection page={page} />;
    case 'servers':
      return <ServersSection page={page} />;
  }
}
