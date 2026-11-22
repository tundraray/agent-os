'use client';

import { useEffect } from 'react';
import { focusShellTarget } from '@/lib/focus';
import type { AdminPage, AdminSection } from '@/lib/shell-route';
import { LibrarySection } from './library/library-section';
import { ModelsScreen } from './models/models-screen';
import { RolesSection } from './roles/roles-section';
import { ServersSection } from './servers/servers-section';
import { SignInSection } from './sign-in/sign-in-section';
import { UsersSection } from './users/users-section';

type AdminScreenProps = { section: AdminSection; page: AdminPage };

/**
 * The section screen of a panel address; mounted by `AdminGate` for an administrator only. Every panel page
 * opened — from the menu, the sidebar, a row, a form or a deleted record — gets the focus on its `h1` (UXRD
 * Accessibility), here and nowhere else.
 */
export function AdminScreen({ section, page }: AdminScreenProps) {
  const pageKey =
    page.kind === 'record' || page.kind === 'knowledge' ? page.key : null;
  useEffect(() => {
    focusShellTarget('page-title');
  }, [section, page.kind, pageKey]);

  switch (section) {
    case 'users':
      return <UsersSection page={page} />;
    case 'roles':
      return <RolesSection page={page} />;
    case 'models':
      return <ModelsScreen />;
    case 'sign-in':
      return <SignInSection page={page} />;
    case 'servers':
      return <ServersSection page={page} />;
    case 'library':
      return <LibrarySection page={page} />;
  }
}
