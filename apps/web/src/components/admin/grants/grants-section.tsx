'use client';

import { useState, type ReactNode } from 'react';
import { KeyRoundIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  AccessErrorCode,
  type Grant,
  type GrantEffect,
} from '@agent-os/contracts';
import { Button } from '@/components/ui/button';
import { StateBadge } from '@/components/state-badge';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { isApiRequestError } from '@/lib/api/api-request';
import { formatQuota } from '@/i18n/formats';
import { CONTROL_SIZE, describeRefusal } from '../admin-form';
import {
  DataTable,
  resourceTableState,
  type DataTableColumn,
  type DataTableRow,
} from '../data-table';
import { GrantDialog, type GrantHolderRef } from './grant-dialog';
import { QuotaDialog } from './quota-dialog';

const holderQuery = (
  holder: GrantHolderRef,
): { roleId: string } | { userId: string } =>
  holder.kind === 'role' ? { roleId: holder.id } : { userId: holder.id };

/** The grants whose «Убрать» is running, and the refusals shown under their rows. */
type RowState = {
  pending: ReadonlySet<string>;
  errors: ReadonlyMap<string, ReactNode>;
};

/**
 * UXRD AD-04 and AD-06 «Модели»: the holder's model grants with GR-01 and «Изменить квоту»; servers and tools
 * are given by levels (access-levels KD-6).
 */
export function GrantsSection({ holder }: { holder: GrantHolderRef }) {
  const t = useTranslations('admin.grants');
  const tErrors = useTranslations('errors');
  const format = useFormatter();
  const grants = useResource(
    () => adminApi.grants.list(holderQuery(holder)),
    `grants:${holder.kind}:${holder.id}`,
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

  const ready = grants.status === 'ready';
  // UXRD MC-24, MC-38.
  const columns: readonly DataTableColumn[] = [
    { header: t('dialog.model') },
    { header: t('kind') },
    { header: t('quotaColumn'), align: 'end' },
  ];

  const toRow = (grant: Grant): DataTableRow => {
    const target = grant.target.modelName;
    const removeAction = {
      label: t('remove'),
      onSelect: () => void remove(grant),
      pending: rowState.pending.has(grant.id),
    };
    return {
      key: grant.id,
      name: target,
      cells: [
        <span key="target" className="truncate" title={target}>
          {target}
        </span>,
        <StateBadge
          key="effect"
          state={grant.effect === 'allow' ? 'ok' : 'closed'}
        >
          {grant.effect === 'allow' ? t('allow') : t('deny')}
        </StateBadge>,
        grant.effect === 'allow'
          ? grant.quotaUsd === null
            ? t('noQuota')
            : formatQuota(format, grant.quotaUsd)
          : t('notApplicable'),
      ],
      actions:
        grant.effect === 'allow'
          ? [
              { label: t('changeQuota'), onSelect: () => openQuota(grant) },
              removeAction,
            ]
          : [removeAction],
      error: rowState.errors.get(grant.id),
    };
  };

  const state = resourceTableState(grants, t('loadFailed'), (data) => ({
    rows: data.map(toRow),
    empty: {
      Icon: KeyRoundIcon,
      title: holder.kind === 'role' ? t('emptyRole') : t('emptyUser'),
    },
  }));

  return (
    <section aria-label={t('title')} className="flex flex-col gap-3">
      {/* The tab names the section, so no heading of its own. */}
      <div className="flex flex-wrap gap-2">
        <AddButton disabled={!ready} onClick={() => openAdd('allow')}>
          {t('addAllow')}
        </AddButton>
        {holder.kind === 'user' && (
          <AddButton disabled={!ready} onClick={() => openAdd('deny')}>
            {t('addDeny')}
          </AddButton>
        )}
      </div>
      <DataTable
        caption={t('title')}
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
