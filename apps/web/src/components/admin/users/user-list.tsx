'use client';

import { useState } from 'react';
import { SearchXIcon } from 'lucide-react';
import type { AdminUserSummary, UserStatus } from '@agent-os/contracts';
import { CONTROL_SIZE } from '@/components/admin/admin-form';
import { PANEL_TITLE } from '@/components/admin/admin-header';
import { adminSectionTitle } from '@/components/admin/admin-sections';
import { DataTable, resourceTableState, type DataTableColumn, type DataTableRow } from '@/components/admin/data-table';
import { PageHeader } from '@/components/shell/page-header';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EMPLOYEE_SEARCH_DELAY_MS, useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePagedResource, type Page } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { isListChanged } from '@/lib/admin/admin-errors';
import { ADMIN_TEXT } from '@/lib/admin/admin-texts';
import { formatTime } from '@/lib/agents/format';
import { adminRecordPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { AccountDialog } from './account-dialog';

/** UXRD MC-22 (the list's labels). */
const TEXT = {
  employee: 'Сотрудник',
  status: 'Статус',
  roles: 'Роли',
  lastSignIn: 'Последний вход',
  local: 'локальная',
  search: 'Найти по имени, логину или почте',
  active: 'Включён',
  disabled: 'Отключён',
  never: 'никогда',
  noMatches: 'Никого не нашли',
  create: 'Завести учётную запись',
  // Not in MC-22: the read failures follow the shell's «Не удалось загрузить …» texts, as in «Мой доступ».
  loadFailed: 'Не удалось загрузить сотрудников',
} as const;

const EMPTY_VALUE = '—';

const COLUMNS: readonly DataTableColumn[] = [
  { header: TEXT.employee },
  { header: TEXT.status },
  { header: TEXT.roles, shrinks: true },
  { header: TEXT.lastSignIn },
];

async function loadUsersPage(query: string, cursor: string | null): Promise<Page<AdminUserSummary>> {
  const page = await adminApi.users.list({ query, cursor });
  return { items: page.users, nextCursor: page.nextCursor };
}

/**
 * A failed «Показать ещё»: a cursor the server no longer accepts reads the plan's Notes 6 text; any other
 * failure is a read failure, not a refused save, so it does not take `describeAdminError`'s «Не удалось сохранить».
 */
const loadMoreErrorText = (error: unknown): string => (isListChanged(error) ? ADMIN_TEXT.listChanged : TEXT.loadFailed);

/** A non-empty `login` is a local account (design-admin.md, DC-4). */
export const isLocalAccount = (user: Pick<AdminUserSummary, 'login'>): boolean =>
  user.login !== null && user.login !== '';

/** «Включён» / «Отключён» of the list and the employee's page (MC-22). */
export function UserStatusBadge({ status }: { status: UserStatus }) {
  return status === 'active' ? (
    <StateBadge state="ok">{TEXT.active}</StateBadge>
  ) : (
    <StateBadge state="off">{TEXT.disabled}</StateBadge>
  );
}

function EmployeeCell({ user }: { user: AdminUserSummary }) {
  // A local account shows the badge and the login before the email.
  const local = isLocalAccount(user);
  const contact = local ? `${user.login} · ${user.email}` : user.email;
  return (
    <div className="flex min-w-0 flex-col py-1.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate" title={user.name}>
          {user.name}
        </span>
        {local && <StateBadge variant="source">{TEXT.local}</StateBadge>}
      </span>
      <span className="truncate text-xs leading-4 text-muted-foreground" title={contact}>
        {contact}
      </span>
    </div>
  );
}

function rowOf(user: AdminUserSummary): DataTableRow {
  const roles = user.roles.map((role) => role.name).join(' · ');
  return {
    key: user.id,
    name: user.name,
    href: adminRecordPath('users', user.id),
    cells: [
      <EmployeeCell key="employee" user={user} />,
      <UserStatusBadge key="status" status={user.status} />,
      <span key="roles" className="block truncate" title={roles}>
        {roles === '' ? EMPTY_VALUE : roles}
      </span>,
      user.lastSignInAt === null ? TEXT.never : formatTime(user.lastSignInAt),
    ],
  };
}

/**
 * UXRD AD-03: the employees in the server's order, 50 a page with «Показать ещё», searched by name, login and
 * email. The search reads 300 ms after the last keystroke, and an answer for an older text never shows (DC-3).
 * «Завести учётную запись» opens AD-16; a created account reads the list again.
 */
export function UserList() {
  const title = adminSectionTitle('users');
  const [query, setQuery] = useState('');
  const searched = useDebouncedValue(query.trim(), EMPLOYEE_SEARCH_DELAY_MS);
  const list = usePagedResource((cursor) => loadUsersPage(searched, cursor), searched);
  const [creating, setCreating] = useState(false);

  const state = resourceTableState({ ...list, data: list.items }, TEXT.loadFailed, (items) => ({
    rows: items.map(rowOf),
    // Always «Нет совпадений»: an empty list without a search is unreachable, the administrator reading
    // it is an employee, so the Empty state is never drawn and has no text of its own in MC-22.
    empty: { Icon: SearchXIcon, title: TEXT.noMatches },
    noMatches: TEXT.noMatches,
    more:
      list.nextCursor === null
        ? undefined
        : {
            onLoadMore: list.loadMore,
            loading: list.loadingMore,
            error: list.loadMoreError === undefined ? undefined : loadMoreErrorText(list.loadMoreError),
          },
  }));

  return (
    <>
      <PageHeader area={PANEL_TITLE} title={title}>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={TEXT.search}
          placeholder={TEXT.search}
          className={cn(CONTROL_SIZE, 'min-w-0 flex-1 text-data md:w-72 md:flex-none md:text-data')}
        />
        <Button size="sm" className={CONTROL_SIZE} onClick={() => setCreating(true)}>
          {TEXT.create}
        </Button>
      </PageHeader>
      <DataTable caption={title} columns={COLUMNS} state={state} />
      <AccountDialog open={creating} onOpenChange={setCreating} onCreated={list.reload} />
    </>
  );
}
