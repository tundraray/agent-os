'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, MoreHorizontalIcon, WrenchIcon } from 'lucide-react';
import { toast } from 'sonner';
import { McpErrorCode, type McpServerView, type McpToolView } from '@agent-os/contracts';
import { useShellServices } from '@/components/shell/shell-actions';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { Button, buttonVariants } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { ADMIN_TEXT, saveFailed } from '@/lib/admin/admin-texts';
import { sharedTokenRules } from '@/lib/admin/form-rules';
import { isApiRequestError } from '@/lib/api/api-request';
import { focusShellTarget } from '@/lib/focus';
import { logger } from '@/lib/logger';
import { takeAdminConnectReturn } from '@/lib/mcp/connect-return';
import { adminPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { AdminForm, CAPTION, CONTROL_SIZE, describeRefusal, FORM_TEXT, FormError } from '../admin-form';
import { AdminPageHeader } from '../admin-header';
import { adminSectionTitle } from '../admin-sections';
import { ConfirmDialog } from '../confirm-dialog';
import { DataTable, type DataTableColumn, type DataTableRow } from '../data-table';
import { SavingSwitch } from '../saving-switch';
import { SecretField } from '../secret-field';
import { SERVER_MODE_LABEL, ServerStatusBadge } from './server-list';

/** UXRD MC-29; «Сохранить», «Удалить» — MC-20. */
const TEXT = {
  enabled: 'Включён',
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
  // The «⋯» menu follows the data-table's «Действия: {запись}».
  menu: (server: string) => `Действия: ${server}`,
  // Not in the UXRD: the hidden caption of the tools table, its empty state (a server still waiting for the
  // admin account has no tools) and the read failure, after the panel's «Не удалось загрузить …» texts.
  tools: 'Инструменты',
  noTools: 'Инструментов пока нет',
  loadFailed: 'Не удалось загрузить сервер',
} as const;

const TOOL_COLUMNS: readonly DataTableColumn[] = [{ header: TEXT.tool }, { header: TEXT.description }, { header: TEXT.action }];

const isNotFound = (error: unknown): boolean =>
  isApiRequestError(error) && error.code === McpErrorCode.MCP_SERVER_NOT_FOUND;

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
      <span className={cn('truncate font-mono text-mono-compact', tool.title !== null && 'text-muted-foreground')}>
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

/**
 * DC-9: the connection return, read once on mount and taken off the address (the panel renders only in the
 * browser, after the right is known). `connected` adds nothing: the page itself shows the account's tools.
 */
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
  const server = useResource(() => adminApi.servers.get(name), `server:${name}`);
  /** The outcome of the connection return or of the last refresh, above the tools. */
  const [toolsError, setToolsError] = useState<string | null>(() => connectReturnText(name));
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // After a delete the closing dialog hands focus to the page `h1`, which the list's `h1` then replaces.
  const deletedFocus = useRef<HTMLElement | null>(null);

  if (server.status === 'error' && isNotFound(server.error)) {
    return <ThreadNotice variant="record-not-found" section="servers" />;
  }

  /** Every change: a server that is gone reads the server again (→ «Запись не найдена») and still reaches its control. */
  const change = async <T,>(request: () => Promise<T>): Promise<T> => {
    try {
      return await request();
    } catch (error) {
      if (isNotFound(error)) server.reload();
      throw error;
    }
  };

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
    deletedFocus.current = document.querySelector<HTMLElement>('[data-shell-focus="page-title"]');
    focusShellTarget('page-title');
    router.push(adminPath('servers'));
  };

  const data = server.data;
  const header = (
    <AdminPageHeader
      parent={data === undefined ? undefined : 'servers'}
      title={data?.name ?? adminSectionTitle('servers')}
      badge={data === undefined ? undefined : <ServerStatusBadge status={data.status} />}
    >
      {data !== undefined && (
        <>
          <Button
            variant="outline"
            size="sm"
            className={CONTROL_SIZE}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {refreshing ? TEXT.refreshing : TEXT.refresh}
          </Button>
          <ServerMenu name={data.name} onDelete={() => setDeleting(true)} />
        </>
      )}
    </AdminPageHeader>
  );

  if (data === undefined) {
    return (
      <>
        {header}
        <DataTable
          caption={adminSectionTitle('servers')}
          columns={[]}
          state={
            server.status === 'error'
              ? { status: 'error', message: TEXT.loadFailed, onRetry: server.reload }
              : { status: 'loading' }
          }
        />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="flex max-w-240 flex-col gap-6">
        {/* Under the header, as on a provider's page: a refusal reads under the switch, which the header would clip. */}
        <SavingSwitch
          label={TEXT.enabled}
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
              empty: { Icon: WrenchIcon, title: TEXT.noTools, description: '' },
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
        finalFocus={deletedFocus}
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
 * goes in a `PATCH` with `sharedToken` only; without one nothing is sent (Contract `SecretField`). A refused
 * replacement stays in the field; a kept one is emptied, and the field reads «Задан» again.
 */
function SharedTokenForm({ isSet, onSave, onSaved }: SharedTokenFormProps) {
  return (
    <AdminForm<{ sharedToken: string | undefined }>
      variant="page"
      initialValues={{ sharedToken: undefined }}
      validate={({ sharedToken }) => (sharedToken === undefined ? {} : sharedTokenRules({ sharedToken }))}
      onSubmit={async ({ sharedToken }) => {
        // «Задан» without «Заменить»: there is nothing to replace, and the stored token is never sent back.
        if (sharedToken === undefined) return;
        await onSave(sharedToken);
        toast.success(FORM_TEXT.saved);
      }}
      submitLabel={TEXT.save}
      savingLabel={TEXT.checking}
      savedText={null}
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

function ServerMenu({ name, onDelete }: { name: string; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="pointer-coarse:size-11"
            aria-label={TEXT.menu(name)}
            aria-haspopup="menu"
          />
        }
      >
        <MoreHorizontalIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        <DropdownMenuItem onClick={onDelete} className="pointer-coarse:min-h-11">
          {TEXT.remove}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
