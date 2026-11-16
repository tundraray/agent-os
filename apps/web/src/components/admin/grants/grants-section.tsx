'use client';

import { useId, useState } from 'react';
import { KeyRoundIcon } from 'lucide-react';
import { AccessErrorCode, type Grant, type GrantEffect } from '@agent-os/contracts';
import { Button } from '@/components/ui/button';
import { StateBadge } from '@/components/state-badge';
import { useResource } from '@/hooks/use-resource';
import { formatQuotaUsd } from '@/lib/access/money';
import { adminApi } from '@/lib/admin/admin-api';
import { grantTargetText, orphanGrantIds, serversToRead } from '@/lib/admin/grants';
import { isApiRequestError } from '@/lib/api/api-request';
import { cn } from '@/lib/utils';
import { CONTROL_SIZE, describeRefusal } from '../admin-form';
import { DataTable, type DataTableColumn, type DataTableRow, type DataTableState } from '../data-table';
import { GrantDialog, type GrantHolderRef } from './grant-dialog';
import { QuotaDialog } from './quota-dialog';

/** UXRD MC-24, MC-25, MC-26 and MC-20 («Убрать»). */
const TEXT = {
  roleTitle: 'Права',
  userTitle: 'Личные права и запреты',
  addRoleGrant: 'Добавить право',
  addAllow: 'Право',
  addDeny: 'Запрет',
  allow: 'Право',
  deny: 'Запрет',
  noQuota: 'без квоты',
  notApplicable: '—',
  orphan: 'Нет в реестре',
  changeQuota: 'Изменить квоту',
  remove: 'Убрать',
  // Not in the UXRD: the read failure follows the panel's «Не удалось загрузить …» texts.
  loadFailed: 'Не удалось загрузить права',
  // Not in the UXRD, which draws no empty state for the rights.
  emptyRole: 'Прав нет',
  emptyUser: 'Прав и запретов нет',
} as const;

const COLUMNS: readonly DataTableColumn[] = [{ header: 'Цель' }, { header: 'Вид' }, { header: 'Квота', align: 'end' }];

const isModelAllow = (grant: Grant): boolean => grant.effect === 'allow' && grant.target.kind === 'model';

const holderQuery = (holder: GrantHolderRef): { roleId: string } | { userId: string } =>
  holder.kind === 'role' ? { roleId: holder.id } : { userId: holder.id };

type RowState = { pendingId: string | null; errors: ReadonlyMap<string, string> };

/**
 * UXRD AD-04 «Личные права и запреты» and AD-06 «Права»: the holder's grants with GR-01 and «Изменить квоту».
 * A grant whose server or tool left the registry is an orphan row (GR-02) with «Убрать» only.
 */
export function GrantsSection({ holder }: { holder: GrantHolderRef }) {
  const headingId = useId();
  const grants = useResource(() => adminApi.grants.list(holderQuery(holder)), `grants:${holder.kind}:${holder.id}`);
  const servers = useResource(adminApi.servers.list, 'servers');

  // Design-admin «Права (GR-01, GR-02)»: the record of every server the holder has tool grants on, for its `tools`.
  const toRead = grants.data !== undefined && servers.data !== undefined ? serversToRead(grants.data, servers.data) : [];
  const records = useResource(
    () => Promise.all(toRead.map((name) => adminApi.servers.get(name))),
    `records:${toRead.join('\n')}`,
  );

  const [rowState, setRowState] = useState<RowState>({ pendingId: null, errors: new Map() });
  const [adding, setAdding] = useState(false);
  const [addEffect, setAddEffect] = useState<GrantEffect>('allow');
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [quotaGrant, setQuotaGrant] = useState<Grant | null>(null);

  const setRowError = (id: string, text: string | null): void =>
    setRowState((current) => {
      const errors = new Map(current.errors);
      if (text === null) errors.delete(id);
      else errors.set(id, text);
      return { ...current, errors };
    });

  /** UXRD Notes 9: «Убрать» sends at once, with no confirmation; the same dialog gives the grant back. */
  async function remove(grant: Grant): Promise<void> {
    setRowError(grant.id, null);
    setRowState((current) => ({ ...current, pendingId: grant.id }));
    try {
      await adminApi.grants.remove(grant.id);
      grants.reload();
    } catch (error) {
      const refusal = describeRefusal(error, { logEvent: 'admin: grant remove' });
      // Error handling: a grant already gone is not an error of the row — the screen reads its rights again.
      if (isApiRequestError(error) && error.code === AccessErrorCode.GRANT_NOT_FOUND) grants.reload();
      else if (refusal !== null) setRowError(grant.id, refusal.text);
    } finally {
      setRowState((current) => ({ ...current, pendingId: null }));
    }
  }

  const openAdd = (effect: GrantEffect): void => {
    setAddEffect(effect);
    setAdding(true);
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
          new Map((records.data ?? []).map((record) => [record.name, record.tools])),
        )
      : new Set<string>();

  const toRow = (grant: Grant): DataTableRow => {
    const orphan = orphans.has(grant.id);
    const target = grantTargetText(grant.target);
    const removeAction = { label: TEXT.remove, onSelect: () => void remove(grant), pending: rowState.pendingId === grant.id };
    return {
      key: grant.id,
      name: target,
      cells: [
        <TargetCell key="target" grant={grant} text={target} orphan={orphan} />,
        <StateBadge key="effect" state={grant.effect === 'allow' ? 'ok' : 'closed'}>
          {grant.effect === 'allow' ? TEXT.allow : TEXT.deny}
        </StateBadge>,
        isModelAllow(grant) ? (grant.quotaUsd === null ? TEXT.noQuota : formatQuotaUsd(grant.quotaUsd)) : TEXT.notApplicable,
      ],
      actions:
        !orphan && isModelAllow(grant)
          ? [{ label: TEXT.changeQuota, onSelect: () => openQuota(grant) }, removeAction]
          : [removeAction],
      error: rowState.errors.get(grant.id),
    };
  };

  const title = holder.kind === 'role' ? TEXT.roleTitle : TEXT.userTitle;
  const state: DataTableState =
    ready && grants.data !== undefined
      ? {
          status: 'ready',
          rows: grants.data.map(toRow),
          empty: { Icon: KeyRoundIcon, title: holder.kind === 'role' ? TEXT.emptyRole : TEXT.emptyUser, description: '' },
        }
      : grants.status === 'error' || servers.status === 'error'
        ? {
            status: 'error',
            message: TEXT.loadFailed,
            onRetry: () => {
              grants.reload();
              servers.reload();
            },
          }
        : { status: 'loading' };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="text-base leading-6 font-semibold">
          {title}
        </h2>
        <div className="flex gap-2">
          {holder.kind === 'role' ? (
            <AddButton disabled={!ready} onClick={() => openAdd('allow')}>
              {TEXT.addRoleGrant}
            </AddButton>
          ) : (
            <>
              <AddButton disabled={!ready} onClick={() => openAdd('allow')}>
                {TEXT.addAllow}
              </AddButton>
              <AddButton disabled={!ready} onClick={() => openAdd('deny')}>
                {TEXT.addDeny}
              </AddButton>
            </>
          )}
        </div>
      </div>
      <DataTable caption={title} columns={COLUMNS} state={state} actionsAs="menu" />
      <GrantDialog
        open={adding}
        onOpenChange={setAdding}
        holder={holder}
        effect={addEffect}
        grants={grants.data ?? []}
        servers={servers.data ?? []}
        onSaved={saved(setAdding)}
      />
      <QuotaDialog open={quotaOpen} onOpenChange={setQuotaOpen} grant={quotaGrant} onSaved={saved(setQuotaOpen)} />
    </section>
  );
}

function AddButton({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: string }) {
  return (
    <Button variant="outline" size="sm" className={CONTROL_SIZE} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

/** Servers and tools are technical names (Mono); an orphan's target is muted with «Нет в реестре» (GR-02). */
function TargetCell({ grant, text, orphan }: { grant: Grant; text: string; orphan: boolean }) {
  const mono = grant.target.kind !== 'model';
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className={cn('truncate', mono && 'font-mono text-mono-compact', orphan && 'text-muted-foreground')}
        title={text}
      >
        {text}
      </span>
      {orphan && <StateBadge state="off">{TEXT.orphan}</StateBadge>}
    </span>
  );
}
