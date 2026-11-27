'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { InfoIcon, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { McpErrorCode, type McpServerView } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { isNotFound, rereadOnNotFound } from '@/lib/admin/admin-errors';
import { sharedTokenRules } from '@/lib/admin/form-rules';
import { isApiRequestError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import { takeAdminConnectReturn } from '@/lib/mcp/connect-return';
import {
  adminPath,
  adminRecordPath,
  adminRecordTabPath,
  type AdminRecordTab,
} from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import {
  AdminForm,
  CAPTION,
  CONTROL_SIZE,
  describeRefusal,
  FormError,
  RECORD_TABS,
} from '../admin-form';
import { RecordPlaceholder, useAdminTitles } from '../admin-header';
import { ConfirmDialog } from '../confirm-dialog';
import { ActionsMenu } from '../data-table';
import { ChangedDot } from '../levels/level-select';
import { SavingSwitch } from '../saving-switch';
import { SecretField } from '../secret-field';
import { ServerAccessTab, useServerAccess } from './server-access-tab';
import { serverModeLabel, ServerStatusBadge } from './server-list';
import { ServerToolsTab } from './server-tools-tab';

const isAccountRequired = (error: unknown): boolean =>
  isApiRequestError(error) && error.code === McpErrorCode.MCP_ACCOUNT_REQUIRED;

/** «Инструменты» lives at the server's own address, «Доступ» after it (access-levels C3 web «Адреса»). */
export type ServerTab = 'tools' | AdminRecordTab<'servers'>;
const SERVER_TABS: readonly ServerTab[] = ['tools', 'access'];

const tabHref = (name: string, tab: ServerTab): string =>
  tab === 'tools'
    ? adminRecordPath('servers', name)
    : adminRecordTabPath('servers', name, tab);

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
 * UXRD AD-10: a registered server — the switch, the address, the shared token, the tools refresh and the delete,
 * and under them the tabs «Инструменты» (ST-01) and «Доступ» (ST-02). Name, address and mode only read (DC-10).
 * The access draft lives here, not in its tab, so switching tabs keeps unsaved changes (access-levels KD-7).
 */
export function ServerPage({
  name,
  tab = 'tools',
}: {
  name: string;
  tab?: ServerTab;
}) {
  const titles = useAdminTitles();
  const t = useTranslations('admin.servers.page');
  const tTabs = useTranslations('admin.servers.tabs');
  const tLevels = useTranslations('admin.levels');
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
  const access = useServerAccess(name);
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
      access.read.reload();
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
        <ServerAddress server={data} />
        {data.mode === 'shared' && (
          <SharedTokenForm
            isSet={data.sharedTokenSet}
            onSave={(sharedToken) =>
              change(() => adminApi.servers.update(name, { sharedToken }))
            }
            onSaved={server.reload}
          />
        )}
        {data.status === 'disabled' && (
          <p
            className={cn(
              CAPTION,
              'flex items-start gap-2 text-muted-foreground',
            )}
          >
            <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {t('disabledHint')}
          </p>
        )}
        {toolsNotice !== null && <FormError>{toolsNotice}</FormError>}
      </div>
      <Tabs value={tab} className="mt-6 gap-4">
        <TabsList variant="line" className={RECORD_TABS.list}>
          {SERVER_TABS.map((value) => (
            <TabsTrigger
              key={value}
              value={value}
              nativeButton={false}
              className={RECORD_TABS.tab}
              // Same page: a plain link, so the leave guard does not ask (access-level-editor, «Уход с изменениями»).
              render={<Link href={tabHref(name, value)} />}
            >
              {tTabs(value)}
              {value === 'access' && access.draft.changedCount > 0 && (
                <>
                  <ChangedDot />
                  <span className="sr-only"> {tLevels('tabChanged')}</span>
                </>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={tab}>
          {tab === 'tools' ? (
            <ServerToolsTab
              server={data}
              connectUrl={adminApi.servers.connectUrl(name)}
              change={change}
              onToolSaved={() => {
                // The page's server is the one truth of the tools: the tab, opened again, shows the saved class.
                server.reload();
                access.read.reload();
              }}
            />
          ) : (
            <ServerAccessTab server={name} state={access} />
          )}
        </TabsContent>
      </Tabs>
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
 * DC-10: the address and the mode are text, never fields. A server waiting for the administrator's account offers
 * the connection in «Инструменты» (ST-01), where its tools will appear.
 */
function ServerAddress({ server }: { server: McpServerView }) {
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
      {server.mode === 'oauth' && server.oauthClientId !== null && (
        <OAuthClient
          clientId={server.oauthClientId}
          secretSet={server.oauthClientSecretSet}
        />
      )}
      <p className={cn(CAPTION, 'text-muted-foreground')}>
        {t('page.readOnlyHint')}
      </p>
    </div>
  );
}

/**
 * AD-10: the ready OAuth app of a personal-OAuth server — its «Client ID» in Mono and whether «Client Secret» is
 * held; both only read (KD-6, AC-35.5), the secret's value never comes back.
 */
function OAuthClient({
  clientId,
  secretSet,
}: {
  clientId: string;
  secretSet: boolean;
}) {
  const t = useTranslations('admin.servers');
  const tSecret = useTranslations('admin.secret');
  return (
    <dl className="flex flex-col gap-1 text-data text-foreground">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <dt className="text-muted-foreground">{t('oauthClientId')}:</dt>
        <dd className="min-w-0 font-mono text-mono-compact [overflow-wrap:anywhere]">
          {clientId}
        </dd>
      </div>
      <div className="flex flex-wrap items-center gap-x-2">
        <dt className="text-muted-foreground">{t('oauthClientSecret')}:</dt>
        <dd>
          <StateBadge state="neutral">
            {secretSet ? tSecret('set') : tSecret('notSet')}
          </StateBadge>
        </dd>
      </div>
    </dl>
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
