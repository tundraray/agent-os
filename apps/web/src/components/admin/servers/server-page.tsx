'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, WrenchIcon } from 'lucide-react';
import { toast } from 'sonner';
import { McpErrorCode, type McpServerView, type McpToolView } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { Button, buttonVariants } from '@/components/ui/button';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { isNotFound, rereadOnNotFound } from '@/lib/admin/admin-errors';
import { ADMIN_TEXT, saveFailed } from '@/lib/admin/admin-texts';
import { sharedTokenRules } from '@/lib/admin/form-rules';
import { isApiRequestError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import { takeAdminConnectReturn } from '@/lib/mcp/connect-return';
import { adminPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { AdminForm, CAPTION, CONTROL_SIZE, describeRefusal, FormError } from '../admin-form';
import { PANEL_TITLE, RecordPlaceholder, sectionParent } from '../admin-header';
import { ConfirmDialog } from '../confirm-dialog';
import { ActionsMenu, DataTable, type DataTableColumn, type DataTableRow } from '../data-table';
import { SavingSwitch } from '../saving-switch';
import { SecretField } from '../secret-field';
import { SERVER_MODE_LABEL, ServerStatusBadge } from './server-list';

/** UXRD MC-29; «Сохранить», «Удалить» — MC-20. */
const TEXT = {
  enabled: 'Включён',
  disabled: 'Выключен',
  refresh: 'Обновить список',
  refreshing: 'Обновляем…',
  refreshed: (added: number, removed: number) => `Список обновлён: новых ${added}, убрано ${removed}`,
  connect: 'Подключить мой аккаунт',
  readOnlyHint: 'Чтобы сменить адрес или режим, удалите сервер и зарегистрируйте его заново.',
  sharedToken: 'Токен доступа',
  save: 'Сохранить',
  checking: 'Проверяем сервер…',
  tool: 'Инструмент',
  description: 'Описание',
  action: 'Действие',
  reads: 'читает',
  changes: 'меняет',
  remove: 'Удалить',
  removeTitle: (server: string) => `Удалить сервер «${server}»?`,
  // The second sentence is not in the UXRD: the API deletes every employee's account with the server.
  removeBody:
    'Агенты сразу потеряют его инструменты. Это действие нельзя отменить. Подключённые аккаунты сотрудников на этом сервере будут удалены.',
  // Not in the UXRD: the hidden caption of the tools table, its empty state (a server still waiting for the
  // admin account has no tools) and the read failure, after the panel's «Не удалось загрузить …» texts.
  tools: 'Инструменты',
  noTools: 'Инструментов пока нет',
  loadFailed: 'Не удалось загрузить сервер',
  // Not in the UXRD: the notice of a delete, after «Роль удалена».
  removed: 'Сервер удалён',
} as const;

/** The tool's name keeps its width; the long description is the column that gives way. */
const TOOL_COLUMNS: readonly DataTableColumn[] = [
  { header: TEXT.tool, shrinks: false },
  { header: TEXT.description, shrinks: true },
  { header: TEXT.action },
];

const isAccountRequired = (error: unknown): boolean =>
  isApiRequestError(error) && error.code === McpErrorCode.MCP_ACCOUNT_REQUIRED;

const toToolRow = (tool: McpToolView): DataTableRow => ({
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
        className={cn('truncate font-mono text-mono-compact', tool.title !== null && 'text-muted-foreground')}
        title={tool.name}
      >
        {tool.name}
      </span>
    </span>,
    <span key="description" className="block truncate" title={tool.description}>
      {tool.description}
    </span>,
    // A tool without the read-only hint changes data (UXRD AD-10).
    tool.readOnly ? TEXT.reads : TEXT.changes,
  ],
});

/** DC-9: the connection return, taken off the address. `connected` adds nothing: the page itself shows the account's tools. */
function connectReturnText(server: string): string | null {
  const outcome = takeAdminConnectReturn();
  if (outcome === null) return null;
  logger.info('admin: server connect returned', { server, outcome });
  if (outcome === 'connect_failed') return ADMIN_TEXT.connectFailed;
  if (outcome === 'tools_failed') return ADMIN_TEXT.toolsFailed;
  return null;
}

/**
 * UXRD AD-10: a registered server — the switch, the tools with what each does, the administrator's own
 * account, the shared token, the tools refresh and the delete. Name, address and mode only read (DC-10).
 */
export function ServerPage({ name }: { name: string }) {
  const router = useRouter();
  const { navigate } = useShellServices();
  /** The outcome of the connection return or of the last refresh, above the tools. */
  const [toolsError, setToolsError] = useState<string | null>(null);
  const returned = useRef<string | null>(null);

  // Read once on mount; a second run of the effect finds the address already clean and keeps the outcome.
  useEffect(() => {
    const text = connectReturnText(name);
    if (text !== null) returned.current = text;
  }, [name]);

  // The return is shown with the server it is about: when the read that the mount started answers.
  const server = useResource(async () => {
    const view = await adminApi.servers.get(name);
    if (returned.current !== null) setToolsError(returned.current);
    returned.current = null;
    return view;
  }, `server:${name}`);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (isNotFound(server.error)) return <ThreadNotice variant="record-not-found" section="servers" />;
  const data = server.data;
  if (data === undefined) return <RecordPlaceholder section="servers" resource={server} loadFailed={TEXT.loadFailed} />;

  /** Every change: a server that is gone reads the server again (→ «Запись не найдена») and still reaches its control. */
  const change = rereadOnNotFound(server.reload);

  const saveEnabled = async (enabled: boolean): Promise<void> => {
    await change(() => adminApi.servers.update(name, { enabled }));
    server.reload();
  };

  const refresh = async (): Promise<void> => {
    setToolsError(null);
    setRefreshing(true);
    try {
      const { added, removed } = await change(() => adminApi.servers.refreshTools(name));
      logger.info('admin: server tools refresh: done', { server: name, added: added.length, removed: removed.length });
      toast.success(TEXT.refreshed(added.length, removed.length));
      server.reload();
    } catch (error) {
      if (isAccountRequired(error)) {
        // DC-11: the administrator has no account on the server yet — the tab goes to connect it.
        logger.info('admin: server tools refresh: connecting the admin account', { server: name });
        navigate(adminApi.servers.connectUrl(name));
        return;
      }
      setToolsError(describeRefusal(error, { logEvent: 'admin: server tools refresh' })?.text ?? null);
    } finally {
      setRefreshing(false);
    }
  };

  const remove = async (): Promise<void> => {
    await change(() => adminApi.servers.remove(name));
    toast.success(TEXT.removed);
    router.push(adminPath('servers'));
  };

  return (
    <>
      <PageHeader area={PANEL_TITLE} parent={sectionParent('servers')} title={data.name} badge={<ServerStatusBadge status={data.status} />}>
        <Button variant="outline" size="sm" className={CONTROL_SIZE} disabled={refreshing} onClick={() => void refresh()}>
          {refreshing && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
          {refreshing ? TEXT.refreshing : TEXT.refresh}
        </Button>
        <ActionsMenu name={data.name} actions={[{ label: TEXT.remove, onSelect: () => setDeleting(true) }]} />
      </PageHeader>
      <div className="flex max-w-240 flex-col gap-6">
        {/* Under the header, as on a provider's page: a refusal reads under the switch, which the header would clip. */}
        <SavingSwitch
          label={TEXT.enabled}
          labelOff={TEXT.disabled}
          checked={data.status === 'enabled'}
          onSave={saveEnabled}
          logEvent="admin: server enable"
        />
        <ServerAddress server={data} connectUrl={adminApi.servers.connectUrl(name)} />
        {data.mode === 'shared' && (
          <SharedTokenForm
            isSet={data.sharedTokenSet}
            onSave={(sharedToken) => change(() => adminApi.servers.update(name, { sharedToken }))}
            onSaved={server.reload}
          />
        )}
        <div className="flex flex-col gap-3">
          {toolsError !== null && <FormError>{toolsError}</FormError>}
          <DataTable
            caption={TEXT.tools}
            columns={TOOL_COLUMNS}
            state={{
              status: 'ready',
              rows: data.tools.map(toToolRow),
              empty: { Icon: WrenchIcon, title: TEXT.noTools },
            }}
          />
        </div>
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={TEXT.removeTitle(data.name)}
        body={TEXT.removeBody}
        confirmLabel={TEXT.remove}
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
function ServerAddress({ server, connectUrl }: { server: McpServerView; connectUrl: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-data text-foreground">
        <span className="truncate font-mono text-mono-compact" title={server.url}>
          {server.url}
        </span>
        <span aria-hidden className="text-muted-foreground">
          ·
        </span>
        <span>{SERVER_MODE_LABEL[server.mode]}</span>
      </p>
      <p className={cn(CAPTION, 'text-muted-foreground')}>{TEXT.readOnlyHint}</p>
      {server.status === 'awaiting_admin_account' && (
        <a href={connectUrl} className={buttonVariants({ size: 'sm', className: cn(CONTROL_SIZE, 'mt-2 w-fit') })}>
          {TEXT.connect}
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
  return (
    <AdminForm<{ sharedToken: string | undefined }>
      variant="page"
      initialValues={{ sharedToken: undefined }}
      hasChange={({ sharedToken }) => sharedToken !== undefined && sharedToken !== ''}
      validate={({ sharedToken }) => sharedTokenRules({ sharedToken: sharedToken ?? '' })}
      onSubmit={async ({ sharedToken }) => {
        await onSave(sharedToken ?? '');
      }}
      submitLabel={TEXT.save}
      savingLabel={TEXT.checking}
      onSaved={onSaved}
      secretFields={['sharedToken']}
      errorContext={{ checkFailed: saveFailed }}
      logEvent="admin: server token"
    >
      {(form) => (
        <SecretField
          {...form.field('sharedToken')}
          label={TEXT.sharedToken}
          isSet={isSet}
          value={form.values.sharedToken}
          onChange={(value) => form.set('sharedToken', value)}
        />
      )}
    </AdminForm>
  );
}
