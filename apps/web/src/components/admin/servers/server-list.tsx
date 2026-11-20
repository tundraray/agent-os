'use client';

import Link from 'next/link';
import { ServerIcon } from 'lucide-react';
import type { McpServerMode, McpServerStatus, McpServerSummary } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { StateBadge, type StateBadgeState } from '@/components/state-badge';
import { buttonVariants } from '@/components/ui/button';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { adminNewPath, adminRecordPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_SIZE } from '../admin-form';
import { PANEL_TITLE } from '../admin-header';
import { adminSectionTitle } from '../admin-sections';
import { DataTable, resourceTableState, type DataTableColumn, type DataTableRow } from '../data-table';
import { ToolResultSettingsForm } from './tool-result-settings-form';

/** UXRD MC-29. */
const TEXT = {
  register: 'Зарегистрировать сервер',
  server: 'Сервер',
  tools: 'Инструментов',
  status: 'Статус',
  empty: 'Серверов пока нет',
  emptyHint: 'Зарегистрируйте первый MCP-сервер по адресу.',
  // Not in the UXRD: the read failure follows the panel's «Не удалось загрузить …» texts.
  loadFailed: 'Не удалось загрузить MCP-серверы',
} as const;

/** MC-29: the server fields the list, the registration and the server's page share. */
export const SERVER_TEXT = { credentials: 'Учётные данные' } as const;

/** MC-29: the credentials modes as the panel names them. */
export const SERVER_MODE_LABEL: Readonly<Record<McpServerMode, string>> = {
  shared: 'Общая учётная запись',
  oauth: 'Личный OAuth',
};

/** MC-29 and the state-badge kinds: «Включён» is good, «Выключен» is off, the missing admin account wants an action. */
const SERVER_STATUS: Readonly<Record<McpServerStatus, { label: string; state: StateBadgeState }>> = {
  enabled: { label: 'Включён', state: 'ok' },
  disabled: { label: 'Выключен', state: 'off' },
  awaiting_admin_account: { label: 'Ждёт аккаунта администратора', state: 'action' },
};

/** The status of a server in its list row and in its page's header. */
export function ServerStatusBadge({ status }: { status: McpServerStatus }) {
  const { label, state } = SERVER_STATUS[status];
  return <StateBadge state={state}>{label}</StateBadge>;
}

const COLUMNS: readonly DataTableColumn[] = [
  { header: TEXT.server },
  { header: SERVER_TEXT.credentials },
  { header: TEXT.tools, align: 'end' },
  { header: TEXT.status },
];

const toRow = (server: McpServerSummary): DataTableRow => ({
  key: server.name,
  name: server.name,
  href: adminRecordPath('servers', server.name),
  cells: [
    <span key="server" className="flex min-w-0 flex-col">
      <span className="truncate font-mono text-mono-compact" title={server.name}>
        {server.name}
      </span>
      <span className={cn(CAPTION, 'truncate font-mono text-muted-foreground')} title={server.url}>
        {server.url}
      </span>
    </span>,
    SERVER_MODE_LABEL[server.mode],
    server.toolCount,
    <ServerStatusBadge key="status" status={server.status} />,
  ],
});

/**
 * UXRD AD-08: the registered servers as link rows in the server's order (by name); under them the settings of
 * large tool results (tool-result-reading R-5).
 */
export function ServerList() {
  const servers = useResource(adminApi.servers.list, 'servers');

  const state = resourceTableState(servers, TEXT.loadFailed, (data) => ({
    rows: data.map(toRow),
    empty: { Icon: ServerIcon, title: TEXT.empty, description: TEXT.emptyHint },
  }));

  return (
    <>
      <PageHeader area={PANEL_TITLE} title={adminSectionTitle('servers')}>
        <Link href={adminNewPath('servers')} className={buttonVariants({ size: 'sm', className: CONTROL_SIZE })}>
          {TEXT.register}
        </Link>
      </PageHeader>
      <div className="flex max-w-240 flex-col gap-8">
        <DataTable caption={adminSectionTitle('servers')} columns={COLUMNS} state={state} />
        <ToolResultSettingsForm />
      </div>
    </>
  );
}
