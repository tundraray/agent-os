'use client';

import { useId, useState, type ReactNode } from 'react';
import { KeyRoundIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  AccessErrorCode,
  type Grant,
  type GrantEffect,
  type McpServerView,
} from '@agent-os/contracts';
import { Button } from '@/components/ui/button';
import { StateBadge } from '@/components/state-badge';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import {
  grantTargetText,
  orphanGrantIds,
  serversToRead,
} from '@/lib/admin/grants';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import { formatQuota } from '@/i18n/formats';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { CONTROL_SIZE, describeRefusal } from '../admin-form';
import {
  DataTable,
  resourceTableState,
  type DataTableColumn,
  type DataTableRow,
} from '../data-table';
import { GrantDialog, type GrantHolderRef } from './grant-dialog';
import { QuotaDialog } from './quota-dialog';

const isModelAllow = (grant: Grant): boolean =>
  grant.effect === 'allow' && grant.target.kind === 'model';

const holderQuery = (
  holder: GrantHolderRef,
): { roleId: string } | { userId: string } =>
  holder.kind === 'role' ? { roleId: holder.id } : { userId: holder.id };

/** The grants whose «Убрать» is running, and the refusals shown under their rows. */
type RowState = {
  pending: ReadonlySet<string>;
  errors: ReadonlyMap<string, ReactNode>;
};

/** Each record on its own: one that fails to read is logged and left out, the others still tell their orphans. */
async function readRecords(names: readonly string[]): Promise<McpServerView[]> {
  const reads = await Promise.allSettled(
    names.map((name) => adminApi.servers.get(name)),
  );
  return reads.flatMap((read, index) => {
    if (read.status === 'fulfilled') return [read.value];
    logger.error('admin: grants: server record read failed', {
      server: names[index],
      ...describeApiError(read.reason),
    });
    return [];
  });
}

/**
 * UXRD AD-04 «Личные права и запреты» and AD-06 «Права»: the holder's grants with GR-01 and «Изменить квоту».
 * A grant whose server or tool left the registry is an orphan row (GR-02) with «Убрать» only.
 */
export function GrantsSection({ holder }: { holder: GrantHolderRef }) {
  const t = useTranslations('admin.grants');
  const tErrors = useTranslations('errors');
  const headingId = useId();
  const format = useFormatter();
  const grants = useResource(
    () => adminApi.grants.list(holderQuery(holder)),
    `grants:${holder.kind}:${holder.id}`,
  );
  const servers = useResource(adminApi.servers.list, 'servers');

  // Design-admin «Права (GR-01, GR-02)»: the record of every server the holder has tool grants on, for its `tools`.
  const toRead =
    grants.data !== undefined && servers.data !== undefined
      ? serversToRead(grants.data, servers.data)
      : [];
  const records = useResource(
    () => readRecords(toRead),
    `records:${toRead.join('\n')}`,
  );

  const [rowState, setRowState] = useState<RowState>({
    pending: new Set(),
    errors: new Map(),
  });
  const [adding, setAdding] = useState(false);
  const [addEffect, setAddEffect] = useState<GrantEffect>('allow');
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [quotaGrant, setQuotaGrant] = useState<Grant | null>(null);

  const setRowError = (id: string, text: ReactNode): void =>
    setRowState((current) => {
      const errors = new Map(current.errors);
      if (text === null) errors.delete(id);
      else errors.set(id, text);
      return { ...current, errors };
    });

  const setRowPending = (id: string, running: boolean): void =>
    setRowState((current) => {
      const pending = new Set(current.pending);
      if (running) pending.add(id);
      else pending.delete(id);
      return { ...current, pending };
    });

  /** UXRD Notes 9: «Убрать» sends at once, with no confirmation; the same dialog gives the grant back. */
  async function remove(grant: Grant): Promise<void> {
    setRowError(grant.id, null);
    setRowPending(grant.id, true);
    try {
      await adminApi.grants.remove(grant.id);
      grants.reload();
    } catch (error) {
      const refusal = describeRefusal(tErrors, error, {
        logEvent: 'admin: grant remove',
      });
      // Error handling: a grant already gone is not an error of the row — the screen reads its rights again.
      if (
        isApiRequestError(error) &&
        error.code === AccessErrorCode.GRANT_NOT_FOUND
      )
        grants.reload();
      else if (refusal !== null) setRowError(grant.id, refusal.text);
    } finally {
      setRowPending(grant.id, false);
    }
  }

  const openAdd = (effect: GrantEffect): void => {
    setAddEffect(effect);
    setAdding(true);
  };

  /**
   * Closed without a new grant: the rights are read again, because a refused «уже есть» means the list on
   * screen is behind the server.
   */
  const changeAdding = (open: boolean): void => {
    setAdding(open);
    if (!open) grants.reload();
  };

  const openQuota = (grant: Grant): void => {
    setQuotaGrant(grant);
    setQuotaOpen(true);
  };

  const saved = (close: (open: boolean) => void) => (): void => {
    close(false);
    grants.reload();
  };

  const ready = grants.status === 'ready' && servers.status === 'ready';
  const orphans =
    grants.data !== undefined && servers.data !== undefined
      ? orphanGrantIds(
          grants.data,
          servers.data,
          new Map(
            (records.data ?? []).map((record) => [record.name, record.tools]),
          ),
        )
      : new Set<string>();

  // UXRD MC-24, MC-26.
  const columns: readonly DataTableColumn[] = [
    { header: t('target') },
    { header: t('kind') },
    { header: t('quotaColumn'), align: 'end' },
  ];

  const toRow = (grant: Grant): DataTableRow => {
    const orphan = orphans.has(grant.id);
    const target = grantTargetText(grant.target);
    const removeAction = {
      label: t('remove'),
      onSelect: () => void remove(grant),
      pending: rowState.pending.has(grant.id),
    };
    return {
      key: grant.id,
      name: target,
      cells: [
        <TargetCell key="target" grant={grant} text={target} orphan={orphan} />,
        <StateBadge
          key="effect"
          state={grant.effect === 'allow' ? 'ok' : 'closed'}
        >
          {grant.effect === 'allow' ? t('allow') : t('deny')}
        </StateBadge>,
        isModelAllow(grant)
          ? grant.quotaUsd === null
            ? t('noQuota')
            : formatQuota(format, grant.quotaUsd)
          : t('notApplicable'),
      ],
      actions:
        !orphan && isModelAllow(grant)
          ? [
              { label: t('changeQuota'), onSelect: () => openQuota(grant) },
              removeAction,
            ]
          : [removeAction],
      error: rowState.errors.get(grant.id),
    };
  };

  const title = holder.kind === 'role' ? t('roleTitle') : t('userTitle');
  // The table waits for both reads: the registry tells which rows are orphans.
  const state = resourceTableState(
    {
      status:
        grants.status === 'error' || servers.status === 'error'
          ? 'error'
          : ready
            ? 'ready'
            : 'loading',
      data: grants.data,
      reload: () => {
        grants.reload();
        servers.reload();
      },
    },
    t('loadFailed'),
    (data) => ({
      rows: data.map(toRow),
      empty: {
        Icon: KeyRoundIcon,
        title: holder.kind === 'role' ? t('emptyRole') : t('emptyUser'),
      },
    }),
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="text-base leading-6 font-semibold">
          {title}
        </h2>
        <div className="flex gap-2">
          {holder.kind === 'role' ? (
            <AddButton disabled={!ready} onClick={() => openAdd('allow')}>
              {t('addAllow')}
            </AddButton>
          ) : (
            <>
              <AddButton disabled={!ready} onClick={() => openAdd('allow')}>
                {t('allow')}
              </AddButton>
              <AddButton disabled={!ready} onClick={() => openAdd('deny')}>
                {t('deny')}
              </AddButton>
            </>
          )}
        </div>
      </div>
      <DataTable
        caption={title}
        columns={columns}
        state={state}
        actionsAs="menu"
      />
      <GrantDialog
        open={adding}
        onOpenChange={changeAdding}
        holder={holder}
        effect={addEffect}
        grants={grants.data ?? []}
        servers={servers.data ?? []}
        onSaved={saved(setAdding)}
      />
      <QuotaDialog
        open={quotaOpen}
        onOpenChange={setQuotaOpen}
        grant={quotaGrant}
        onSaved={saved(setQuotaOpen)}
      />
    </section>
  );
}

function AddButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={CONTROL_SIZE}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** Servers and tools are technical names (Mono); an orphan's target is muted with «Нет в реестре» (GR-02). */
function TargetCell({
  grant,
  text,
  orphan,
}: {
  grant: Grant;
  text: string;
  orphan: boolean;
}) {
  const t = useTranslations('admin.grants');
  const mono = grant.target.kind !== 'model';
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          'truncate',
          mono && 'font-mono text-mono-compact',
          orphan && 'text-muted-foreground',
        )}
        title={text}
      >
        {text}
      </span>
      {orphan && <StateBadge state="off">{t('orphan')}</StateBadge>}
    </span>
  );
}
