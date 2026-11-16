'use client';

import { useEffect } from 'react';
import { useStore } from 'zustand';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { useShellServices } from '@/components/shell/shell-actions';
import type { ShellRoute } from '@/lib/shell-route';
import { adminSectionTitle } from './admin-sections';
import { AdminScreen } from './admin-screen';
import { DataTable } from './data-table';

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
