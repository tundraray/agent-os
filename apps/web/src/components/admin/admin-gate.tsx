'use client';

import { useEffect } from 'react';
import { useStore } from 'zustand';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { useShellServices } from '@/components/shell/shell-actions';
import { pageTitle, useDocumentTitle } from '@/hooks/use-document-title';
import type { ShellRoute } from '@/lib/shell-route';
import { PANEL_TITLE } from './admin-header';
import { adminSectionTitle } from './admin-sections';
import { AdminScreen } from './admin-screen';
import { DataTable } from './data-table';

/** UXRD MC-19: the tab title of AD-02; it names neither a section of the panel nor a record. */
const NO_ACCESS_TITLE = pageTitle('Нет доступа');

/** `unknown` until `GET /api/auth/me` answers; `denied` also after a 403 `ADMIN_REQUIRED` (KD-2). */
export type AdminRight = 'unknown' | 'admin' | 'denied';

/** The administrator right from the shell's one `CurrentUser`, the value the user menu reads too. */
export function useAdminRight(): AdminRight {
  const { currentUser } = useShellServices();
  const user = useStore(currentUser, (current) => current.user);

  useEffect(() => {
    currentUser.load();
  }, [currentUser]);

  if (user === null) return 'unknown';
  return user.isAdmin ? 'admin' : 'denied';
}

type AdminGateProps = { route: Extract<ShellRoute, { kind: 'admin' }> };

/**
 * The only place the web decides whether to show the panel (design-admin.md, State Transitions). A section
 * screen, and so every `/api/admin/…` request, mounts only for an administrator (Invariant 1); until the right
 * is known the main area holds the table's Loading state named after the section (AD-01).
 */
export function AdminGate({ route }: AdminGateProps) {
  const right = useAdminRight();
  // An administrator's screen titles the tab itself (`AdminPageHeader`); until the right is known the tab
  // names the panel only, so a refused employee never sees a section's title.
  useDocumentTitle(right === 'denied' ? NO_ACCESS_TITLE : right === 'unknown' ? pageTitle(PANEL_TITLE) : undefined);

  if (right === 'denied') return <ThreadNotice variant="no-access" />;
  return (
    // AD-01: the main area's 24 px margins; a wide table scrolls inside it.
    <div className="h-full overflow-auto p-6">
      {right === 'admin' ? (
        <AdminScreen section={route.section} page={route.page} />
      ) : (
        <DataTable caption={adminSectionTitle(route.section)} columns={[]} state={{ status: 'loading' }} />
      )}
    </div>
  );
}
