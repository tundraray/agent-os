'use client';

import Link from 'next/link';
import { ServerIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { McpServerMode, McpServerStatus, McpServerSummary } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { StateBadge, type StateBadgeState } from '@/components/state-badge';
import { buttonVariants } from '@/components/ui/button';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import type { ServersTranslator } from '@/i18n/catalog';
import { adminNewPath, adminRecordPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_SIZE } from '../admin-form';
import { useAdminTitles } from '../admin-header';
import { DataTable, resourceTableState, type DataTableColumn, type DataTableRow } from '../data-table';
import { ToolResultSettingsForm } from './tool-result-settings-form';

/** MC-29: the credentials mode as the panel names it. */
export const serverModeLabel = (t: ServersTranslator, mode: McpServerMode): string => t(`mode.${mode}`);

/** The state-badge kinds: «Включён» is good, «Выключен» is off, the missing admin account wants an action. */
const SERVER_STATE: Readonly<Record<McpServerStatus, StateBadgeState>> = {
  enabled: 'ok',
  disabled: 'off',
  awaiting_admin_account: 'action',
};

/** The status of a server in its list row and in its page's header. */
export function ServerStatusBadge({ status }: { status: McpServerStatus }) {
  const t = useTranslations('admin.servers');
  return <StateBadge state={SERVER_STATE[status]}>{t(`state.${status}`)}</StateBadge>;
}

const columns = (t: ServersTranslator): readonly DataTableColumn[] => [
  { header: t('server') },
  { header: t('credentials') },
  { header: t('toolCount'), align: 'end' },
  { header: t('status') },
];

const toRow = (t: ServersTranslator, server: McpServerSummary): DataTableRow => ({
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
    serverModeLabel(t, server.mode),
    server.toolCount,
    <ServerStatusBadge key="status" status={server.status} />,
  ],
});

/**
 * UXRD AD-08: the registered servers as link rows in the server's order (by name); under them the settings of
 * large tool results (tool-result-reading R-5).
 */
export function ServerList() {
  const titles = useAdminTitles();
  const t = useTranslations('admin.servers');
  const servers = useResource(adminApi.servers.list, 'servers');

  const state = resourceTableState(servers, t('listLoadFailed'), (data) => ({
    rows: data.map((server) => toRow(t, server)),
    empty: { Icon: ServerIcon, title: t('empty'), description: t('emptyHint') },
  }));

  return (
    <>
      <PageHeader area={titles.panel} title={titles.section('servers')}>
        <Link href={adminNewPath('servers')} className={buttonVariants({ size: 'sm', className: CONTROL_SIZE })}>
          {t('register')}
        </Link>
      </PageHeader>
      <div className="flex max-w-240 flex-col gap-8">
        <DataTable caption={titles.section('servers')} columns={columns(t)} state={state} />
        <ToolResultSettingsForm />
      </div>
    </>
  );
}
