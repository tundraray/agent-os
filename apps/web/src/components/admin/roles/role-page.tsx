'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontalIcon, UsersIcon } from 'lucide-react';
import { toast } from 'sonner';
import { IdentityErrorCode, type RoleDetail } from '@agent-os/contracts';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { isApiRequestError } from '@/lib/api/api-request';
import { focusShellTarget } from '@/lib/focus';
import { adminPath, adminRecordPath } from '@/lib/shell-route';
import { AdminPageHeader } from '../admin-header';
import { adminSectionTitle } from '../admin-sections';
import { ConfirmDialog } from '../confirm-dialog';
import { DataTable, type DataTableColumn, type DataTableRow, type DataTableState } from '../data-table';
import { GrantsSection } from '../grants/grants-section';
import { SavingSwitch } from '../saving-switch';
import { RoleNameDialog } from './role-name-dialog';

/** UXRD MC-26; «Удалить» — MC-20, «Сотрудник» — MC-22. */
const TEXT = {
  builtin: 'встроенная',
  rename: 'Переименовать',
  remove: 'Удалить',
  isAdmin: 'Право администратора',
  members: 'Сотрудники',
  member: 'Сотрудник',
  removeTitle: (role: string) => `Удалить роль «${role}»?`,
  removeBody: 'Сотрудники роли сразу потеряют её права.',
  removed: 'Роль удалена',
  // The «⋯» menu follows the data-table's «Действия: {запись}».
  menu: (role: string) => `Действия: ${role}`,
  // Not in the UXRD: the read failure follows the panel's «Не удалось загрузить …» texts.
  loadFailed: 'Не удалось загрузить роль',
  // Not in the UXRD, which draws no empty state for the members.
  noMembers: 'В роли нет сотрудников',
} as const;

const MEMBER_COLUMNS: readonly DataTableColumn[] = [{ header: TEXT.member }];

/** Error handling: a role that is gone (404) or built-in (409) is read again; the page shows what the server holds. */
const needsReread = (error: unknown): boolean =>
  isApiRequestError(error) &&
  (error.code === IdentityErrorCode.ROLE_NOT_FOUND || error.code === IdentityErrorCode.BUILTIN_ROLE);

const isNotFound = (error: unknown): boolean =>
  isApiRequestError(error) && error.code === IdentityErrorCode.ROLE_NOT_FOUND;

/**
 * UXRD AD-06: a role's page — the admin right, the rights, the members (read only), rename and delete. The
 * built-in role (DC-5) has no «⋯» menu and its admin right is on and unavailable.
 */
export function RolePage({ id }: { id: string }) {
  const router = useRouter();
  const role = useResource(() => adminApi.roles.get(id), `role:${id}`);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // After a delete the closing dialog hands focus to the page `h1`, which the list's `h1` then replaces.
  const deletedFocus = useRef<HTMLElement | null>(null);

  if (role.status === 'error' && isNotFound(role.error)) return <ThreadNotice variant="record-not-found" section="roles" />;

  /** Every change: the refusal of a gone or built-in role reads the role again and still reaches its control. */
  const change = async (request: () => Promise<unknown>): Promise<void> => {
    try {
      await request();
    } catch (error) {
      if (needsReread(error)) role.reload();
      throw error;
    }
  };

  const saveAdmin = async (isAdmin: boolean): Promise<void> => {
    await change(() => adminApi.roles.update(id, { isAdmin }));
    role.reload();
  };

  const remove = async (): Promise<void> => {
    await change(() => adminApi.roles.remove(id));
    toast.success(TEXT.removed);
    deletedFocus.current = document.querySelector<HTMLElement>('[data-shell-focus="page-title"]');
    focusShellTarget('page-title');
    router.push(adminPath('roles'));
  };

  const data = role.data;
  const header = (
    <AdminPageHeader
      parent={data === undefined ? undefined : 'roles'}
      title={data?.name ?? adminSectionTitle('roles')}
      badge={data?.builtin === true ? <StateBadge variant="source">{TEXT.builtin}</StateBadge> : undefined}
    >
      {data !== undefined && !data.builtin ? (
        <RoleMenu name={data.name} onRename={() => setRenaming(true)} onDelete={() => setDeleting(true)} />
      ) : undefined}
    </AdminPageHeader>
  );

  if (data === undefined) {
    const state: DataTableState =
      role.status === 'error'
        ? { status: 'error', message: TEXT.loadFailed, onRetry: role.reload }
        : { status: 'loading' };
    return (
      <>
        {header}
        <DataTable caption={adminSectionTitle('roles')} columns={[]} state={state} />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-6">
        {data.builtin ? (
          <BuiltinAdminSwitch label={TEXT.isAdmin} />
        ) : (
          <SavingSwitch label={TEXT.isAdmin} checked={data.isAdmin} onSave={saveAdmin} logEvent="admin: role admin right" />
        )}
        <GrantsSection holder={{ kind: 'role', id }} />
        <MembersSection members={data.members} />
      </div>
      {!data.builtin && (
        <>
          <RoleNameDialog
            open={renaming}
            onOpenChange={setRenaming}
            role={{ id, name: data.name }}
            onRenamed={role.reload}
          />
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title={TEXT.removeTitle(data.name)}
            body={TEXT.removeBody}
            confirmLabel={TEXT.remove}
            onConfirm={remove}
            logEvent="admin: role delete"
            finalFocus={deletedFocus}
          />
        </>
      )}
    </>
  );
}

function RoleMenu({ name, onRename, onDelete }: { name: string; onRename: () => void; onDelete: () => void }) {
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
        <DropdownMenuItem onClick={onRename} className="pointer-coarse:min-h-11">
          {TEXT.rename}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDelete} className="pointer-coarse:min-h-11">
          {TEXT.remove}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** DC-5: the built-in role keeps the admin right — the switch is on and unavailable, laid out as `SavingSwitch`. */
function BuiltinAdminSwitch({ label }: { label: string }) {
  const labelId = useId();
  return (
    <label className="flex w-fit items-center gap-2">
      <Switch checked disabled aria-labelledby={labelId} />
      <span id={labelId} className="text-data font-medium text-foreground opacity-50">
        {label}
      </span>
    </label>
  );
}

/** UXRD AD-06 «Сотрудники»: read only, each name links to the employee's page (KD-7). */
function MembersSection({ members }: { members: RoleDetail['members'] }) {
  const headingId = useId();
  const rows: DataTableRow[] = members.map((member) => ({
    key: member.id,
    name: member.name,
    href: adminRecordPath('users', member.id),
    cells: [
      <span key="name" className="block truncate" title={member.name}>
        {member.name}
      </span>,
    ],
  }));

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {TEXT.members}
      </h2>
      <DataTable
        caption={TEXT.members}
        columns={MEMBER_COLUMNS}
        state={{ status: 'ready', rows, empty: { Icon: UsersIcon, title: TEXT.noMembers, description: '' } }}
      />
    </section>
  );
}
