'use client';

import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { LoaderCircle, RotateCwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { McpConnection } from '@agent-os/contracts';
import { StateBadge } from '@/components/state-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { describeApiError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import {
  takeConnectReturn,
  type ConnectReturn,
} from '@/lib/mcp/connect-return';
import { mcpApi } from '@/lib/mcp/mcp-api';
import { cn } from '@/lib/utils';

type Load =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; connections: McpConnection[] };

const hostOf = (url: string): string => new URL(url).host;

/**
 * MA-01 of UXRD Screen 3: a row per personal-OAuth server the employee may use, read when the page opens
 * (read-on-open, without the shared hook). «Подключить» is a link: the connect route answers 302 to the
 * authorization server (web-api-client, «Переход вместо запроса»). The return from it lands here with
 * `connected` or `error=connect_failed` in the address.
 */
export function ConnectionsSection() {
  const t = useTranslations('account');
  const headingId = useId();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [failedServer, setFailedServer] = useState<string | null>(null);
  const [failedUnknown, setFailedUnknown] = useState(false);
  const [focusServer, setFocusServer] = useState<string | null>(null);
  const returned = useRef<ConnectReturn | null>(null);
  const rowActions = useRef(new Map<string, HTMLElement>());

  // Read before the first load; a second run of the effect finds the address already clean and keeps the outcome.
  useEffect(() => {
    const outcome = takeConnectReturn();
    if (outcome !== null) returned.current = outcome;
  }, []);

  // An effect event: a change of the interface language must not read the connections again.
  const noticeConnected = useEffectEvent((server: string) =>
    toast.success(t('connections.connectedNotice', { server })),
  );

  // `attempt` grows with «Повторить», which shows Loading itself; an answer after leaving the page or after a
  // newer attempt is dropped.
  useEffect(() => {
    let current = true;
    const applyReturn = (outcome: ConnectReturn): void => {
      if (outcome.server === null) {
        // The return matched no connection request: the failure goes above the list instead of under a row.
        logger.warn('account: mcp connect returned without a server', {
          kind: outcome.kind,
        });
        setFailedUnknown(true);
        return;
      }
      logger.info('account: mcp connect returned', {
        kind: outcome.kind,
        server: outcome.server,
      });
      if (outcome.kind === 'connected') noticeConnected(outcome.server);
      else setFailedServer(outcome.server);
      setFocusServer(outcome.server);
    };
    mcpApi.connections().then(
      (connections) => {
        if (!current) return;
        setLoad({ status: 'ready', connections });
        const outcome = returned.current;
        returned.current = null;
        if (outcome !== null) applyReturn(outcome);
      },
      (error: unknown) => {
        if (!current) return;
        logger.error(
          'account: mcp connections read failed',
          describeApiError(error),
        );
        setLoad({ status: 'error' });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  // UXRD Accessibility: after the return, focus goes to the row's button. A frame later than the page's own
  // focus on its `h1`, which is also deferred by a frame, so the return wins.
  useEffect(() => {
    if (focusServer === null || load.status !== 'ready') return;
    const frame = requestAnimationFrame(() => {
      rowActions.current.get(focusServer)?.focus();
      setFocusServer(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusServer, load.status]);

  async function handleDisconnect(server: string): Promise<void> {
    setDisconnecting(server);
    try {
      await mcpApi.disconnect(server);
      logger.info('account: mcp account disconnected', { server });
      // The DELETE answers 204 with no body, and the only change is this row's status (UXRD MA-01 «Отключение»).
      setLoad((current) =>
        current.status === 'ready'
          ? {
              status: 'ready',
              connections: current.connections.map((row) =>
                row.server === server ? { ...row, status: 'needs_auth' } : row,
              ),
            }
          : current,
      );
      setFailedServer((failed) => (failed === server ? null : failed));
      // The focused «Отключить» is replaced by «Подключить»: focus follows to it instead of falling to the body.
      setFocusServer(server);
      toast.success(t('connections.disconnectedNotice', { server }));
    } catch (error) {
      logger.error('account: mcp account disconnect failed', {
        server,
        ...describeApiError(error),
      });
      toast.error(t('connections.disconnectFailed', { server }));
    } finally {
      setDisconnecting(null);
    }
  }

  const setRowAction = (server: string) => (element: HTMLElement | null) => {
    if (element === null) rowActions.current.delete(server);
    else rowActions.current.set(server, element);
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex max-w-160 flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-base leading-6 font-semibold">
          {t('connections.title')}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t('connections.caption')}
        </p>
      </div>

      {failedUnknown && (
        <p
          role="alert"
          className="text-xs leading-4 font-medium text-destructive"
        >
          {t('connections.connectFailedUnknown')}
        </p>
      )}

      {load.status === 'loading' && (
        <div
          role="status"
          aria-label={t('connections.title')}
          className="flex flex-col gap-3"
        >
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-3/4" />
        </div>
      )}

      {load.status === 'error' && (
        <div className="flex flex-col items-start gap-3 text-sm leading-5">
          <p role="alert">{t('connections.loadFailed')}</p>
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => {
              setLoad({ status: 'loading' });
              setAttempt((count) => count + 1);
            }}
          >
            <RotateCwIcon aria-hidden />
            {t('retry')}
          </Button>
        </div>
      )}

      {load.status === 'ready' && load.connections.length === 0 && (
        <div className="flex flex-col gap-1 text-sm leading-5">
          <p className="font-medium text-foreground">
            {t('connections.empty')}
          </p>
          <p className="text-xs leading-4 font-medium text-muted-foreground">
            {t('connections.emptyCaption')}
          </p>
        </div>
      )}

      {load.status === 'ready' && load.connections.length > 0 && (
        <ul className="flex flex-col divide-y divide-border">
          {load.connections.map((row) => (
            <ConnectionRow
              key={row.server}
              row={row}
              connecting={connecting === row.server}
              disconnecting={disconnecting === row.server}
              failed={failedServer === row.server}
              actionRef={setRowAction(row.server)}
              onConnect={() => setConnecting(row.server)}
              onDisconnect={() => void handleDisconnect(row.server)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

type ConnectionRowProps = {
  row: McpConnection;
  connecting: boolean;
  disconnecting: boolean;
  failed: boolean;
  actionRef: (element: HTMLElement | null) => void;
  onConnect: () => void;
  onDisconnect: () => void;
};

/** Name and host on the left, the badge and one `outline` `sm` button on the right; below 768 px the button goes under the name. */
function ConnectionRow({
  row,
  connecting,
  disconnecting,
  failed,
  actionRef,
  onConnect,
  onDisconnect,
}: ConnectionRowProps) {
  const t = useTranslations('account.connections');
  const nameId = useId();
  const connected = row.status === 'connected';
  const actionClass = 'pointer-coarse:h-11';
  return (
    <li aria-labelledby={nameId} className="flex flex-col gap-2 py-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
        <div className="flex min-w-0 flex-col">
          <span
            id={nameId}
            className="text-sm leading-5 font-medium break-words"
          >
            {row.server}
          </span>
          <span className="text-xs leading-4 font-medium break-all text-muted-foreground">
            {hostOf(row.url)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <StateBadge state={connected ? 'ok' : 'action'}>
            {connected ? t('connected') : t('needsAuth')}
          </StateBadge>
          {connected ? (
            <Button
              ref={actionRef}
              variant="outline"
              size="sm"
              className={actionClass}
              disabled={disconnecting}
              onClick={onDisconnect}
            >
              {disconnecting && (
                <LoaderCircle className="animate-spin" aria-hidden />
              )}
              {t('disconnect')}
            </Button>
          ) : (
            <a
              ref={actionRef}
              href={mcpApi.connectUrl(row.server)}
              // `cn` as in `Button`: without the merge the base `border-transparent` wins over the outline border.
              className={cn(
                buttonVariants({
                  variant: 'outline',
                  size: 'sm',
                  className: actionClass,
                }),
              )}
              onClick={onConnect}
            >
              {connecting && (
                <LoaderCircle className="animate-spin" aria-hidden />
              )}
              {connecting
                ? t('connecting', { server: row.server })
                : t('connect')}
            </a>
          )}
        </div>
      </div>
      {failed && !connected && (
        <p
          role="alert"
          className="text-xs leading-4 font-medium text-destructive"
        >
          {t('connectFailed', { server: row.server })}
        </p>
      )}
    </li>
  );
}
