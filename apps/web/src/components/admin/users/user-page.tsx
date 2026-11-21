'use client';

import { useId, useState, type ReactNode } from 'react';
import { LoaderCircleIcon, ShieldIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { IdentityErrorCode, type AdminUserDetail } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { isNotFound } from '@/lib/admin/admin-errors';
import { isApiRequestError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_SIZE, describeRefusal } from '../admin-form';
import { RecordPlaceholder, useAdminTitles } from '../admin-header';
import { ConfirmDialog } from '../confirm-dialog';
import { DataTable, type DataTableColumn, type DataTableRow } from '../data-table';
import { GrantsSection } from '../grants/grants-section';
import { ResetPasswordDialog } from './reset-password-dialog';
import { isLocalAccount, UserStatusBadge } from './user-list';

/** UXRD MC-23 and MC-24. */
const TEXT = {
  block: 'Заблокировать',
  unblock: 'Разблокировать',
  blockBody:
    'Сеансы сотрудника закроются сразу, а работающие агенты закончатся на своём следующем шаге. Беседы и данные сохранятся.',
  resetPassword: 'Сбросить пароль',
  roles: 'Роли',
  assignRole: 'Назначить роль',
  removeRole: 'Снять роль',
  adminRight: 'Право администратора',
  adminPersonal: 'есть: лично',
  adminNone: 'нет',
  grantPersonal: 'Дать лично',
  revokePersonal: 'Снять лично',
  // Not in the UXRD: the owner's decision — giving the admin right is confirmed.
  grantBody:
    'Сотрудник сможет управлять учётными записями, ролями, правами, способами входа, MCP-серверами и моделями.',
  grantConfirm: 'Дать право',
  // Not in the UXRD: the read failure follows the panel's «Не удалось загрузить …» texts.
  loadFailed: 'Не удалось загрузить сотрудника',
  // Not in the UXRD, which draws no empty state for the employee's roles.
  noRoles: 'Ролей нет',
  // Not in the UXRD: the notices of a status change, after «Роль удалена».
  blocked: 'Сотрудник заблокирован',
  unblocked: 'Сотрудник разблокирован',
} as const;

const blockTitle = (name: string): string => `Заблокировать ${name}?`;
const grantTitle = (name: string): string => `Дать ${name} право администратора?`;

const PERSONAL_ADMIN_LOG_EVENT = 'admin: user personal admin';

/** MC-24: the personal right first, then the roles that give it, then «нет». */
function adminRightText({ personal, roles }: AdminUserDetail['adminRight']): string {
  if (personal) return TEXT.adminPersonal;
  if (roles.length > 0) return `есть: роль ${roles.map((role) => role.name).join(' · ')}`;
  return TEXT.adminNone;
}

const ROLE_COLUMNS: readonly DataTableColumn[] = [{ header: 'Роль' }];

/** Where a page action's refusal is shown: the header's status button, «Назначить роль», the admin right, a role row. */
type ActionPlace = 'status' | 'assign' | 'admin' | `role:${string}`;

type Failure = { place: ActionPlace; text: ReactNode };

type UserPageProps = { id: string };

/**
 * UXRD AD-04: one employee — roles, personal rights and denials, the admin right, blocking and, for a local
 * account, «Сбросить пароль». Every change ends with a new read of the employee (Invariant 4); a missing
 * employee is «Запись не найдена» (AD-15).
 */
export function UserPage({ id }: UserPageProps) {
  const titles = useAdminTitles();
  const tErrors = useTranslations('errors');
  const rolesHeadingId = useId();
  const adminHeadingId = useId();
  const user = useResource(() => adminApi.users.get(id), `user:${id}`);
  const roles = useResource(adminApi.roles.list, 'roles');
  const [gone, setGone] = useState(false);
  const [pending, setPending] = useState<ActionPlace | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [blocking, setBlocking] = useState(false);
  const [granting, setGranting] = useState(false);
  const [resetting, setResetting] = useState(false);

  /**
   * Error handling of a refused page action, already logged by its caller. `USER_NOT_FOUND` turns the page
   * into «Запись не найдена» at once; another 404 (a role removed meanwhile) has no text and the roles are
   * read again. True when the refusal still shows its text at the action.
   */
  const showsText = (error: unknown): boolean => {
    if (!isNotFound(error)) return true;
    if (isApiRequestError(error) && error.code === IdentityErrorCode.USER_NOT_FOUND) setGone(true);
    else roles.reload();
    return false;
  };

  /** An action on the page itself: its refusal is text at the action, its success a notice when it has `doneText`. */
  async function act(
    place: ActionPlace,
    logEvent: string,
    request: () => Promise<unknown>,
    doneText?: string,
  ): Promise<void> {
    setFailure(null);
    setPending(place);
    try {
      await request();
      logger.info(`${logEvent}: saved`, { userId: id });
      if (doneText !== undefined) toast.success(doneText);
    } catch (error) {
      const refusal = describeRefusal(tErrors, error, { logEvent });
      if (showsText(error) && refusal !== null) setFailure({ place, text: refusal.text });
    } finally {
      setPending(null);
      user.reload();
    }
  }

  /**
   * An action inside a dialog: the dialog logs and shows its refusal, so the error goes on to it. On
   * `USER_NOT_FOUND` the page becomes «Запись не найдена» in the same render, which takes the dialog away.
   */
  const track = async (request: () => Promise<unknown>): Promise<void> => {
    setFailure(null);
    try {
      await request();
    } catch (error) {
      showsText(error);
      throw error;
    } finally {
      user.reload();
    }
  };

  if (gone || isNotFound(user.error)) return <ThreadNotice variant="record-not-found" section="users" />;

  if (user.data === undefined) return <RecordPlaceholder section="users" resource={user} loadFailed={TEXT.loadFailed} />;

  const detail = user.data;
  const active = detail.status === 'active';
  const personalAdmin = detail.adminRight.personal;
  const held = new Set(detail.roles.map((role) => role.id));
  const assignable = (roles.data ?? []).filter((role) => !held.has(role.id));
  const errorAt = (place: ActionPlace): ReactNode => (failure?.place === place ? failure.text : undefined);
  const busy = pending !== null;

  const roleRow = (role: AdminUserDetail['roles'][number]): DataTableRow => {
    const place: ActionPlace = `role:${role.id}`;
    return {
      key: role.id,
      name: role.name,
      cells: [
        <span key="name" className="block truncate" title={role.name}>
          {role.name}
        </span>,
      ],
      actions: [
        {
          label: TEXT.removeRole,
          onSelect: () => void act(place, 'admin: user role remove', () => adminApi.users.removeRole(id, role.id)),
          pending: pending === place,
          // One page action at a time: the other rows wait for the read that follows it.
          disabled: busy,
        },
      ],
      error: errorAt(place),
    };
  };

  return (
    <>
      <PageHeader area={titles.panel}
        title={detail.name}
        parent={titles.parent('users')}
        badge={
          <>
            {/* The email gives way before the name does: the title stays readable in a narrow header. */}
            <span className="min-w-0 shrink-[100] truncate text-xs leading-4 text-muted-foreground" title={detail.email}>
              {detail.email}
            </span>
            <UserStatusBadge status={detail.status} />
          </>
        }
      >
        {isLocalAccount(detail) && (
          <ActionButton disabled={busy} onClick={() => setResetting(true)}>
            {TEXT.resetPassword}
          </ActionButton>
        )}
        {/* One button for both states, so focus returned to it after the confirmation stays on «Разблокировать». */}
        <ActionButton
          disabled={busy}
          pending={pending === 'status'}
          onClick={
            active
              ? () => setBlocking(true)
              : () => void act('status', 'admin: user unblock', () => adminApi.users.unblock(id), TEXT.unblocked)
          }
        >
          {active ? TEXT.block : TEXT.unblock}
        </ActionButton>
      </PageHeader>

      <div className="flex max-w-240 flex-col gap-8">
        {errorAt('status') !== undefined && <ActionError>{errorAt('status')}</ActionError>}

        <section aria-labelledby={rolesHeadingId} className="flex flex-col gap-3">
          <h2 id={rolesHeadingId} className="text-base leading-6 font-semibold">
            {TEXT.roles}
          </h2>
          <DataTable
            caption={TEXT.roles}
            columns={ROLE_COLUMNS}
            state={{
              status: 'ready',
              rows: detail.roles.map(roleRow),
              empty: { Icon: ShieldIcon, title: TEXT.noRoles },
            }}
          />
          <div className="flex flex-col items-start gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={busy || roles.status !== 'ready' || assignable.length === 0}
                render={<Button variant="outline" size="sm" className={CONTROL_SIZE} />}
              >
                {pending === 'assign' && <Spinner />}
                {TEXT.assignRole}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-auto min-w-40">
                {assignable.map((role) => (
                  <DropdownMenuItem
                    key={role.id}
                    className="pointer-coarse:min-h-11"
                    onClick={() =>
                      void act('assign', 'admin: user role assign', () => adminApi.users.assignRole(id, role.id))
                    }
                  >
                    {role.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {errorAt('assign') !== undefined && <ActionError>{errorAt('assign')}</ActionError>}
          </div>
        </section>

        <GrantsSection holder={{ kind: 'user', id }} />

        <section aria-labelledby={adminHeadingId} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <h2 id={adminHeadingId} className="text-base leading-6 font-semibold">
              {TEXT.adminRight}
            </h2>
            <span className="text-data">{adminRightText(detail.adminRight)}</span>
            <ActionButton
              disabled={busy}
              pending={pending === 'admin'}
              onClick={
                personalAdmin
                  ? () => void act('admin', PERSONAL_ADMIN_LOG_EVENT, () => adminApi.users.setPersonalAdmin(id, false))
                  : () => setGranting(true)
              }
            >
              {personalAdmin ? TEXT.revokePersonal : TEXT.grantPersonal}
            </ActionButton>
          </div>
          {errorAt('admin') !== undefined && <ActionError>{errorAt('admin')}</ActionError>}
        </section>
      </div>

      <ConfirmDialog
        open={blocking}
        onOpenChange={setBlocking}
        title={blockTitle(detail.name)}
        body={TEXT.blockBody}
        confirmLabel={TEXT.block}
        onConfirm={async () => {
          await track(() => adminApi.users.block(id));
          toast.success(TEXT.blocked);
        }}
        logEvent="admin: user block"
      />
      <ConfirmDialog
        open={granting}
        onOpenChange={setGranting}
        title={grantTitle(detail.name)}
        body={TEXT.grantBody}
        confirmLabel={TEXT.grantConfirm}
        onConfirm={() => track(() => adminApi.users.setPersonalAdmin(id, true))}
        logEvent={PERSONAL_ADMIN_LOG_EVENT}
      />
      {isLocalAccount(detail) && (
        <ResetPasswordDialog
          open={resetting}
          onOpenChange={setResetting}
          user={{ id, name: detail.name }}
          track={track}
        />
      )}
    </>
  );
}

function Spinner() {
  return <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:animate-none" />;
}

type ActionButtonProps = { disabled: boolean; pending?: boolean; onClick: () => void; children: string };

function ActionButton({ disabled, pending = false, onClick, children }: ActionButtonProps) {
  return (
    <Button variant="outline" size="sm" className={CONTROL_SIZE} disabled={disabled} onClick={onClick}>
      {pending && <Spinner />}
      {children}
    </Button>
  );
}

/** A refused action's text at the action (Caption, `--destructive`), announced. */
function ActionError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className={cn(CAPTION, 'font-medium text-destructive')}>
      {children}
    </p>
  );
}
