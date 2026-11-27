'use client';

import type { AdminPage } from '@/lib/shell-route';
import { RegisterServerForm } from './register-server-form';
import { ServerList } from './server-list';
import { ServerPage } from './server-page';

type ServersSectionProps = {
  /** The list, the registration or one server's page, from the address. */
  page: AdminPage;
};

/**
 * The «MCP-серверы» section (AD-08 — AD-10). The page is keyed by the server's name, so another server's
 * address starts from a fresh read, and a tab change keeps it with its unsaved access.
 */
export function ServersSection({ page }: ServersSectionProps) {
  if (page.kind === 'new') return <RegisterServerForm />;
  if (page.kind === 'record')
    return (
      <ServerPage
        key={page.key}
        name={page.key}
        tab={page.tab === 'access' ? 'access' : 'tools'}
      />
    );
  return <ServerList />;
}
