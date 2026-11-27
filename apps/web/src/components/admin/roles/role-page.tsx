'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { UsersIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  IdentityErrorCode,
  type RoleDetail,
  type UpdateRoleBody,
} from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { StateBadge } from '@/components/state-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { isNotFound, rereadOnNotFound } from '@/lib/admin/admin-errors';
import { isApiRequestError } from '@/lib/api/api-request';
import { builtinRoleName } from '@/i18n/builtin-name';
import {
  adminPath,
  adminRecordPath,
  adminRecordTabPath,
  type AdminRecordTab,
} from '@/lib/shell-route';
import { CAPTION, RECORD_TABS } from '../admin-form';
import { RecordPlaceholder, useAdminTitles } from '../admin-header';
import { ConfirmDialog } from '../confirm-dialog';
import { ActionsMenu, DataTable, type DataTableRow } from '../data-table';
import { GrantsSection } from '../grants/grants-section';
import { ChangedDot } from '../levels/level-select';
import { SavingSwitch } from '../saving-switch';
import { RoleNameDialog } from './role-name-dialog';
import { RoleToolsTab, useRoleLevels } from './role-tools-tab';

const ADMIN_RIGHT_LOG_EVENT = 'admin: role admin right';

/** «Инструменты» lives at the role's own address; the others after it (access-levels C3 web «Адреса»). */
type RoleTab = 'tools' | AdminRecordTab<'roles'>;
const ROLE_TABS: readonly RoleTab[] = ['tools', 'models', 'rights', 'members'];

const tabHref = (id: string, tab: RoleTab): string =>
  tab === 'tools'
    ? adminRecordPath('roles', id)
    : adminRecordTabPath('roles', id, tab);

/** Error handling: like a role that is gone (404), a built-in one (409) is read again; the page shows what the server holds. */
const isBuiltinRefusal = (error: unknown): boolean =>
  isApiRequestError(error) && error.code === IdentityErrorCode.BUILTIN_ROLE;

/**
 * UXRD AD-06: a role's page — the header with its «⋯» menu and the tabs «Инструменты», «Модели», «Права»,
 * «Участники». The levels draft lives here, not in its tab, so switching tabs keeps unsaved changes (KD-11).
 * «Супер-администратор» has no menu; «Все сотрудники» has only «Создать копию» (AC-38.2).
 */
export function RolePage({ id, tab = 'tools' }: { id: string; tab?: RoleTab }) {
  const titles = useAdminTitles();
  const t = useTranslations('admin.roles');
  const tLevels = useTranslations('admin.levels');
  const locale = useLocale();
  const router = useRouter();
  const role = useResource(() => adminApi.roles.get(id), `role:${id}`);
  const levels = useRoleLevels(id);
  const [renaming, setRenaming] = useState(false);
  const [copying, setCopying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [grantingAdmin, setGrantingAdmin] = useState(false);

  if (isNotFound(role.error))
    return <ThreadNotice variant="record-not-found" section="roles" />;
  const data = role.data;
  if (data === undefined)
    return (
      <RecordPlaceholder
        section="roles"
        resource={role}
        loadFailed={t('loadFailed')}
      />
    );

  const name = builtinRoleName(data.name, locale);

  /** Every change: the refusal of a gone or built-in role reads the role again and still reaches its control. */
  const change = rereadOnNotFound(role.reload, isBuiltinRefusal);

  const save = async (body: UpdateRoleBody): Promise<void> => {
    await change(() => adminApi.roles.update(id, body));
    role.reload();
  };

  const remove = async (): Promise<void> => {
    await change(() => adminApi.roles.remove(id));
    toast.success(t('removed'));
    router.push(adminPath('roles'));
  };

  const kind = data.builtinKind;
  const copyAction = { label: t('copy'), onSelect: () => setCopying(true) };
  const actions =
    kind === 'super_admin'
      ? []
      : kind === 'everyone'
        ? [copyAction]
        : [
            { label: t('rename'), onSelect: () => setRenaming(true) },
            copyAction,
            { label: t('remove'), onSelect: () => setDeleting(true) },
          ];
  const toolsChanged = levels.draft.changedCount > 0;

  return (
    <>
      <PageHeader
        area={titles.panel}
        parent={titles.parent('roles')}
        title={name}
        badge={
          kind !== null ? (
            <StateBadge variant="source">{t('builtin')}</StateBadge>
          ) : undefined
        }
      >
        {actions.length > 0 && <ActionsMenu name={name} actions={actions} />}
      </PageHeader>
      <Tabs value={tab} className="gap-4">
        <TabsList variant="line" className={RECORD_TABS.list}>
          {ROLE_TABS.map((value) => (
            <TabsTrigger
              key={value}
              value={value}
              nativeButton={false}
              className={RECORD_TABS.tab}
              // Same page: a plain link, so the leave guard does not ask (access-level-editor, «Уход с изменениями»).
              render={<Link href={tabHref(id, value)} />}
            >
              {t(`tabs.${value}`)}
              {value === 'tools' && toolsChanged && (
                <>
                  <ChangedDot />
                  <span className="sr-only"> {tLevels('tabChanged')}</span>
                </>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={tab}>
          {tab === 'tools' && (
            <RoleToolsTab roleName={name} builtinKind={kind} levels={levels} />
          )}
          {tab === 'models' && <GrantsSection holder={{ kind: 'role', id }} />}
          {tab === 'rights' && (
            <RightsTab
              role={data}
              onSave={save}
              confirmAdmin={setGrantingAdmin}
            />
          )}
          {tab === 'members' &&
            (kind === 'everyone' ? (
              <p className="text-data text-muted-foreground">
                {t('everyoneMembers')}
              </p>
            ) : (
              <MembersTab members={data.members} />
            ))}
        </TabsContent>
      </Tabs>
      {kind !== 'super_admin' && (
        <RoleNameDialog
          open={copying}
          onOpenChange={setCopying}
          copyOf={{ id, name: data.name }}
        />
      )}
      {kind === null && (
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
            title={t('removeTitle', { role: name })}
            body={t('removeBody')}
            confirmLabel={t('remove')}
            onConfirm={remove}
            logEvent="admin: role delete"
            focusTitleAfterConfirm
          />
          <ConfirmDialog
            open={grantingAdmin}
            onOpenChange={setGrantingAdmin}
            title={t('grantAdminTitle', { role: name })}
            body={t('grantAdminBody', { members: data.members.length })}
            confirmLabel={t('grantAdmin')}
            onConfirm={() => save({ isAdmin: true })}
            logEvent={ADMIN_RIGHT_LOG_EVENT}
          />
        </>
      )}
    </>
  );
}

/**
 * AD-06 «Права»: the admin right and the training rights. «Супер-администратор» has them all, on and unavailable;
 * «Все сотрудники» has none and never can (FR-38).
 */
function RightsTab({
  role,
  onSave,
  confirmAdmin,
}: {
  role: RoleDetail;
  onSave: (body: UpdateRoleBody) => Promise<void>;
  confirmAdmin: (open: boolean) => void;
}) {
  const t = useTranslations('admin.roles');
  const builtin = role.builtinKind !== null;
  const superAdmin = role.builtinKind === 'super_admin';
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <SavingSwitch
        label={t('adminRight')}
        checked={superAdmin || role.isAdmin}
        disabled={builtin}
        onSave={(isAdmin) => onSave({ isAdmin })}
        logEvent={ADMIN_RIGHT_LOG_EVENT}
        confirmOn={() => confirmAdmin(true)}
      />
      {/* RT-01: the training rights save at once. */}
      <SavingSwitch
        label={t('trainOwn.label')}
        hint={superAdmin ? t('alwaysOn') : t('trainOwn.hint')}
        checked={superAdmin || role.trainOwn}
        disabled={builtin}
        onSave={(trainOwn) => onSave({ trainOwn })}
        logEvent="admin: role train own"
      />
      <SavingSwitch
        label={t('trainAny.label')}
        hint={superAdmin ? t('alwaysOn') : t('trainAny.hint')}
        checked={superAdmin || role.trainAny}
        disabled={builtin}
        onSave={(trainAny) => onSave({ trainAny })}
        logEvent="admin: role train any"
      />
      {role.builtinKind === 'everyone' && (
        <p className={`${CAPTION} text-muted-foreground`}>
          {t('everyoneRights')}
        </p>
      )}
    </div>
  );
}

/** AD-06 «Участники»: read only, each name links to the employee's page (KD-7). */
function MembersTab({ members }: { members: RoleDetail['members'] }) {
  const t = useTranslations('admin');
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
    <DataTable
      caption={t('roles.tabs.members')}
      columns={[{ header: t('users.employee') }]}
      state={{
        status: 'ready',
        rows,
        empty: { Icon: UsersIcon, title: t('roles.noMembers') },
      }}
    />
  );
}
