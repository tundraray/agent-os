'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { LoaderCircle, WrenchIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  McpErrorCode,
  type McpServerView,
  type McpToolView,
} from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { Button, buttonVariants } from '@/components/ui/button';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { isNotFound, rereadOnNotFound } from '@/lib/admin/admin-errors';
import { sharedTokenRules } from '@/lib/admin/form-rules';
import { isApiRequestError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import { takeAdminConnectReturn } from '@/lib/mcp/connect-return';
import { adminPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import {
  AdminForm,
  CAPTION,
  CONTROL_SIZE,
  describeRefusal,
  FormError,
} from '../admin-form';
import { RecordPlaceholder, useAdminTitles } from '../admin-header';
import { ConfirmDialog } from '../confirm-dialog';
import {
  ActionsMenu,
  DataTable,
  type DataTableColumn,
  type DataTableRow,
} from '../data-table';
import { SavingSwitch } from '../saving-switch';
import { SecretField } from '../secret-field';
import { serverModeLabel, ServerStatusBadge } from './server-list';

/** UXRD MC-29 (`admin.servers.page`); the tool names and descriptions come from the MCP server as they are. */
type PageTranslator = ReturnType<typeof useTranslations<'admin.servers.page'>>;

/** The tool's name keeps its width; the long description is the column that gives way. */
const toolColumns = (t: PageTranslator): readonly DataTableColumn[] => [
  { header: t('tool'), shrinks: false },
  { header: t('description'), shrinks: true },
  { header: t('action') },
];

const isAccountRequired = (error: unknown): boolean =>
  isApiRequestError(error) && error.code === McpErrorCode.MCP_ACCOUNT_REQUIRED;

const toToolRow = (t: PageTranslator, tool: McpToolView): DataTableRow => ({
  key: tool.name,
  name: tool.title ?? tool.name,
  cells: [
    <span key="tool" className="flex min-w-0 items-baseline gap-2">
      {tool.title !== null && (
        <span className="truncate" title={tool.title}>
          {tool.title}
        </span>
      )}
      <span
        className={cn(
          'truncate font-mono text-mono-compact',
          tool.title !== null && 'text-muted-foreground',
        )}
        title={tool.name}
      >
        {tool.name}
      </span>
    </span>,
    <span key="description" className="block truncate" title={tool.description}>
      {tool.description}
    </span>,
    // A tool without the read-only hint changes data (UXRD AD-10).
    tool.readOnly ? t('reads') : t('changes'),
  ],
});

/** A failed connection return; the page names it in its own language when it renders. */
type ConnectFailure = 'connect_failed' | 'tools_failed';

/** DC-9: the connection return, taken off the address. `connected` adds nothing: the page itself shows the account's tools. */
function takeConnectFailure(server: string): ConnectFailure | null {
  const outcome = takeAdminConnectReturn();
  if (outcome === null) return null;
  logger.info('admin: server connect returned', { server, outcome });
  return outcome === 'connected' ? null : outcome;
}

/**
 * UXRD AD-10: a registered server — the switch, the tools with what each does, the administrator's own
 * account, the shared token, the tools refresh and the delete. Name, address and mode only read (DC-10).
 */
export function ServerPage({ name }: { name: string }) {
  const titles = useAdminTitles();
  const t = useTranslations('admin.servers.page');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const { navigate } = useShellServices();
  /** The refusal of the last refresh, above the tools. */
  const [toolsError, setToolsError] = useState<ReactNode>(null);
  /** The failed connection return, above the tools until the next refresh. */
  const [connectFailure, setConnectFailure] = useState<ConnectFailure | null>(
    null,
  );
  const returned = useRef<ConnectFailure | null>(null);

  // Read once on mount; a second run of the effect finds the address already clean and keeps the outcome.
  useEffect(() => {
    const failure = takeConnectFailure(name);
    if (failure !== null) returned.current = failure;
  }, [name]);

  // The return is shown with the server it is about: when the read that the mount started answers.
  const server = useResource(async () => {
    const view = await adminApi.servers.get(name);
    if (returned.current !== null) setConnectFailure(returned.current);
    returned.current = null;
    return view;
  }, `server:${name}`);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (isNotFound(server.error))
    return <ThreadNotice variant="record-not-found" section="servers" />;
  const data = server.data;
  if (data === undefined)
    return (
      <RecordPlaceholder
        section="servers"
        resource={server}
        loadFailed={t('loadFailed')}
      />
    );

  const toolsNotice: ReactNode =
    toolsError ??
    (connectFailure === null ? null : t(`connectReturn.${connectFailure}`));

  /** Every change: a server that is gone reads the server again (→ «Запись не найдена») and still reaches its control. */
  const change = rereadOnNotFound(server.reload);

  const saveEnabled = async (enabled: boolean): Promise<void> => {
    await change(() => adminApi.servers.update(name, { enabled }));
    server.reload();
  };

  const refresh = async (): Promise<void> => {
    setToolsError(null);
    setConnectFailure(null);
    setRefreshing(true);
    try {
      const { added, removed } = await change(() =>
        adminApi.servers.refreshTools(name),
      );
      logger.info('admin: server tools refresh: done', {
        server: name,
        added: added.length,
        removed: removed.length,
      });
      toast.success(
        t('refreshed', { added: added.length, removed: removed.length }),
      );
      server.reload();
    } catch (error) {
      if (isAccountRequired(error)) {
        // DC-11: the administrator has no account on the server yet — the tab goes to connect it.
        logger.info(
          'admin: server tools refresh: connecting the admin account',
          { server: name },
        );
        navigate(adminApi.servers.connectUrl(name));
        return;
      }
      setToolsError(
        describeRefusal(tErrors, error, {
          logEvent: 'admin: server tools refresh',
        })?.text ?? null,
      );
    } finally {
      setRefreshing(false);
    }
  };

  const remove = async (): Promise<void> => {
    await change(() => adminApi.servers.remove(name));
    toast.success(t('removed'));
    router.push(adminPath('servers'));
  };

  return (
    <>
      <PageHeader
        area={titles.panel}
        parent={titles.parent('servers')}
        title={data.name}
        badge={<ServerStatusBadge status={data.status} />}
      >
        <Button
          variant="outline"
          size="sm"
          className={CONTROL_SIZE}
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing && (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {refreshing ? t('refreshing') : t('refresh')}
        </Button>
        <ActionsMenu
          name={data.name}
          actions={[{ label: t('remove'), onSelect: () => setDeleting(true) }]}
        />
      </PageHeader>
      <div className="flex max-w-240 flex-col gap-6">
        {/* Under the header, as on a provider's page: a refusal reads under the switch, which the header would clip. */}
        <SavingSwitch
          label={t('enabled')}
          labelOff={t('disabled')}
          checked={data.status === 'enabled'}
          onSave={saveEnabled}
          logEvent="admin: server enable"
        />
        <ServerAddress
          server={data}
          connectUrl={adminApi.servers.connectUrl(name)}
        />
        {data.mode === 'shared' && (
          <SharedTokenForm
            isSet={data.sharedTokenSet}
            onSave={(sharedToken) =>
              change(() => adminApi.servers.update(name, { sharedToken }))
            }
            onSaved={server.reload}
          />
        )}
        <div className="flex flex-col gap-3">
          {toolsNotice !== null && <FormError>{toolsNotice}</FormError>}
          <DataTable
            caption={t('tools')}
            columns={toolColumns(t)}
            state={{
              status: 'ready',
              rows: data.tools.map((tool) => toToolRow(t, tool)),
              empty: { Icon: WrenchIcon, title: t('noTools') },
            }}
          />
        </div>
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('removeTitle', { server: data.name })}
        body={t('removeBody')}
        confirmLabel={t('remove')}
        onConfirm={remove}
        logEvent="admin: server delete"
        focusTitleAfterConfirm
      />
    </>
  );
}

/**
 * DC-10: the address and the mode are text, never fields. A server waiting for the administrator's account
 * offers the connection as a link: the connect route redirects to the authorization server.
 */
function ServerAddress({
  server,
  connectUrl,
}: {
  server: McpServerView;
  connectUrl: string;
}) {
  const t = useTranslations('admin.servers');
  return (
    <div className="flex flex-col gap-1">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-data text-foreground">
        <span
          className="truncate font-mono text-mono-compact"
          title={server.url}
        >
          {server.url}
        </span>
        <span aria-hidden className="text-muted-foreground">
          ·
        </span>
        <span>{serverModeLabel(t, server.mode)}</span>
      </p>
      <p className={cn(CAPTION, 'text-muted-foreground')}>
        {t('page.readOnlyHint')}
      </p>
      {server.status === 'awaiting_admin_account' && (
        <a
          href={connectUrl}
          className={buttonVariants({
            size: 'sm',
            className: cn(CONTROL_SIZE, 'mt-2 w-fit'),
          })}
        >
          {t('page.connect')}
        </a>
      )}
    </div>
  );
}

type SharedTokenFormProps = {
  isSet: boolean;
  /** Sends the replacement; the server checks it against the MCP server before keeping it. */
  onSave: (sharedToken: string) => Promise<unknown>;
  /** Reads the server again after a kept replacement (Invariant 4). */
  onSaved: () => void;
};

/**
 * UXRD AD-10 «Токен доступа» with its own «Сохранить» (settings-form «Сохранение на месте»): a replacement
 * goes in a `PATCH` with `sharedToken` only; until one is typed «Сохранить» is unavailable — there is nothing to
 * replace, and the stored token is never sent back (Contract `SecretField`). A refused replacement stays in the field; a
 * kept one is emptied, and the field reads «Задан» again.
 */
function SharedTokenForm({ isSet, onSave, onSaved }: SharedTokenFormProps) {
  const t = useTranslations('admin.servers');
  return (
    <AdminForm<{ sharedToken: string | undefined }>
      variant="page"
      initialValues={{ sharedToken: undefined }}
      hasChange={({ sharedToken }) =>
        sharedToken !== undefined && sharedToken !== ''
      }
      validate={({ sharedToken }) =>
        sharedTokenRules({ sharedToken: sharedToken ?? '' })
      }
      onSubmit={async ({ sharedToken }) => {
        await onSave(sharedToken ?? '');
      }}
      submitLabel={t('page.save')}
      savingLabel={t('checking')}
      onSaved={onSaved}
      secretFields={['sharedToken']}
      errorContext={{ checkFailed: 'save' }}
      logEvent="admin: server token"
    >
      {(form) => (
        <SecretField
          {...form.field('sharedToken')}
          label={t('sharedToken')}
          isSet={isSet}
          value={form.values.sharedToken}
          onChange={(value) => form.set('sharedToken', value)}
        />
      )}
    </AdminForm>
  );
}
