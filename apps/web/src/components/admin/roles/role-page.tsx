'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { UsersIcon } from 'lucide-react';
import { toast } from 'sonner';
import { IdentityErrorCode, type RoleDetail } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { StateBadge } from '@/components/state-badge';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { isNotFound, rereadOnNotFound } from '@/lib/admin/admin-errors';
import { isApiRequestError } from '@/lib/api/api-request';
import { adminPath, adminRecordPath } from '@/lib/shell-route';
import { PANEL_TITLE, RecordPlaceholder, sectionParent } from '../admin-header';
import { ConfirmDialog } from '../confirm-dialog';
import { ActionsMenu, DataTable, type DataTableColumn, type DataTableRow } from '../data-table';
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
  // Not in the UXRD: the owner's decision — giving the admin right is confirmed.
  grantAdminTitle: (role: string) => `Дать роли «${role}» право администратора?`,
  grantAdminBody: (members: number) =>
    members > 0
      ? `Все сотрудники роли станут администраторами: ${members}.`
      : 'Сейчас в роли нет сотрудников; каждый, кого в неё добавят, станет администратором.',
  grantAdmin: 'Дать право',
  // Not in the UXRD: the read failure follows the panel's «Не удалось загрузить …» texts.
  loadFailed: 'Не удалось загрузить роль',
  // Not in the UXRD, which draws no empty state for the members.
  noMembers: 'В роли нет сотрудников',
} as const;

const ADMIN_RIGHT_LOG_EVENT = 'admin: role admin right';

const MEMBER_COLUMNS: readonly DataTableColumn[] = [{ header: TEXT.member }];

/** Error handling: like a role that is gone (404), a built-in one (409) is read again; the page shows what the server holds. */
const isBuiltinRefusal = (error: unknown): boolean =>
  isApiRequestError(error) && error.code === IdentityErrorCode.BUILTIN_ROLE;

/**
 * UXRD AD-06: a role's page — the admin right, the rights, the members (read only), rename and delete. The
 * built-in role (DC-5) has no «⋯» menu and its admin right is on and unavailable.
 */
export function RolePage({ id }: { id: string }) {
  const router = useRouter();
  const role = useResource(() => adminApi.roles.get(id), `role:${id}`);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [grantingAdmin, setGrantingAdmin] = useState(false);

  if (isNotFound(role.error)) return <ThreadNotice variant="record-not-found" section="roles" />;
  const data = role.data;
  if (data === undefined) return <RecordPlaceholder section="roles" resource={role} loadFailed={TEXT.loadFailed} />;

  /** Every change: the refusal of a gone or built-in role reads the role again and still reaches its control. */
  const change = rereadOnNotFound(role.reload, isBuiltinRefusal);

  const saveAdmin = async (isAdmin: boolean): Promise<void> => {
    await change(() => adminApi.roles.update(id, { isAdmin }));
    role.reload();
  };

  const remove = async (): Promise<void> => {
    await change(() => adminApi.roles.remove(id));
    toast.success(TEXT.removed);
    router.push(adminPath('roles'));
  };

  return (
    <>
      <PageHeader area={PANEL_TITLE}
        parent={sectionParent('roles')}
        title={data.name}
        badge={data.builtin ? <StateBadge variant="source">{TEXT.builtin}</StateBadge> : undefined}
      >
        {data.builtin ? undefined : (
          <ActionsMenu
            name={data.name}
            actions={[
              { label: TEXT.rename, onSelect: () => setRenaming(true) },
              { label: TEXT.remove, onSelect: () => setDeleting(true) },
            ]}
          />
        )}
      </PageHeader>
      <div className="flex max-w-3xl flex-col gap-6">
        {/* DC-5: the built-in role keeps the admin right — its switch is on and unavailable. */}
        <SavingSwitch
          label={TEXT.isAdmin}
          checked={data.builtin || data.isAdmin}
          disabled={data.builtin}
          onSave={saveAdmin}
          logEvent={ADMIN_RIGHT_LOG_EVENT}
          confirmOn={() => setGrantingAdmin(true)}
        />
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
            focusTitleAfterConfirm
          />
          <ConfirmDialog
            open={grantingAdmin}
            onOpenChange={setGrantingAdmin}
            title={TEXT.grantAdminTitle(data.name)}
            body={TEXT.grantAdminBody(data.members.length)}
            confirmLabel={TEXT.grantAdmin}
            onConfirm={() => saveAdmin(true)}
            logEvent={ADMIN_RIGHT_LOG_EVENT}
          />
        </>
      )}
    </>
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
        state={{ status: 'ready', rows, empty: { Icon: UsersIcon, title: TEXT.noMembers } }}
      />
    </section>
  );
}
