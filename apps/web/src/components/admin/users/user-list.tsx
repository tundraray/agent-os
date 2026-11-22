'use client';

import { useState } from 'react';
import { SearchXIcon } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { AdminUserSummary, UserStatus } from '@agent-os/contracts';
import { CONTROL_SIZE } from '@/components/admin/admin-form';
import { useAdminTitles } from '@/components/admin/admin-header';
import { DataTable, resourceTableState, type DataTableColumn, type DataTableRow } from '@/components/admin/data-table';
import { PageHeader } from '@/components/shell/page-header';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EMPLOYEE_SEARCH_DELAY_MS, useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePagedResource, type Page } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { isListChanged } from '@/lib/admin/admin-errors';
import { builtinRoleName } from '@/i18n/builtin-name';
import { formatListTime, type Formatter } from '@/i18n/formats';
import type { Locale } from '@/i18n/pick-locale';
import { adminRecordPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { AccountDialog } from './account-dialog';

const EMPTY_VALUE = '—';

type UsersTranslator = ReturnType<typeof useTranslations<'admin.users'>>;

async function loadUsersPage(query: string, cursor: string | null): Promise<Page<AdminUserSummary>> {
  const page = await adminApi.users.list({ query, cursor });
  return { items: page.users, nextCursor: page.nextCursor };
}

/** A non-empty `login` is a local account (design-admin.md, DC-4). */
export const isLocalAccount = (user: Pick<AdminUserSummary, 'login'>): boolean =>
  user.login !== null && user.login !== '';

/** «Включён» / «Отключён» of the list and the employee's page (MC-22). */
export function UserStatusBadge({ status }: { status: UserStatus }) {
  const t = useTranslations('admin.users');
  return status === 'active' ? (
    <StateBadge state="ok">{t('active')}</StateBadge>
  ) : (
    <StateBadge state="off">{t('disabled')}</StateBadge>
  );
}

function EmployeeCell({ user }: { user: AdminUserSummary }) {
  const t = useTranslations('admin.users');
  // A local account shows the badge and the login before the email.
  const local = isLocalAccount(user);
  const contact = local ? `${user.login} · ${user.email}` : user.email;
  return (
    <div className="flex min-w-0 flex-col py-1.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate" title={user.name}>
          {user.name}
        </span>
        {local && <StateBadge variant="source">{t('local')}</StateBadge>}
      </span>
      <span className="truncate text-xs leading-4 text-muted-foreground" title={contact}>
        {contact}
      </span>
    </div>
  );
}

type RowContext = { t: UsersTranslator; format: Formatter; locale: Locale };

function rowOf(user: AdminUserSummary, { t, format, locale }: RowContext): DataTableRow {
  const roles = user.roles.map((role) => builtinRoleName(role.name, locale)).join(' · ');
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
      user.lastSignInAt === null ? t('never') : formatListTime(format, user.lastSignInAt),
    ],
  };
}

/**
 * UXRD AD-03: the employees in the server's order, 50 a page with «Показать ещё», searched by name, login and
 * email. The search reads 300 ms after the last keystroke, and an answer for an older text never shows (DC-3).
 * «Завести учётную запись» opens AD-16; a created account reads the list again.
 */
export function UserList() {
  const titles = useAdminTitles();
  const title = titles.section('users');
  const t = useTranslations('admin.users');
  const tErrors = useTranslations('errors');
  const format = useFormatter();
  const locale = useLocale();
  const [query, setQuery] = useState('');
  const searched = useDebouncedValue(query.trim(), EMPLOYEE_SEARCH_DELAY_MS);
  const list = usePagedResource((cursor) => loadUsersPage(searched, cursor), searched);
  const [creating, setCreating] = useState(false);

  const columns: readonly DataTableColumn[] = [
    { header: t('employee') },
    { header: t('status') },
    { header: t('roles'), shrinks: true },
    { header: t('lastSignIn') },
  ];

  /**
   * A failed «Показать ещё»: a cursor the server no longer accepts reads the plan's Notes 6 text; any other
   * failure is a read failure, not a refused save, so it does not take `describeAdminError`'s «Не удалось сохранить».
   */
  const loadMoreErrorText = (error: unknown): string =>
    isListChanged(error) ? tErrors('admin.listChanged') : t('loadFailed');

  const state = resourceTableState({ ...list, data: list.items }, t('loadFailed'), (items) => ({
    rows: items.map((user) => rowOf(user, { t, format, locale })),
    // Always «Нет совпадений»: an empty list without a search is unreachable, the administrator reading
    // it is an employee, so the Empty state is never drawn and has no text of its own in MC-22.
    empty: { Icon: SearchXIcon, title: t('noMatches') },
    noMatches: t('noMatches'),
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
      <PageHeader area={titles.panel} title={title}>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t('search')}
          placeholder={t('search')}
          className={cn(CONTROL_SIZE, 'min-w-0 flex-1 text-data md:w-72 md:flex-none md:text-data')}
        />
        <Button size="sm" className={CONTROL_SIZE} onClick={() => setCreating(true)}>
          {t('create')}
        </Button>
      </PageHeader>
      <DataTable caption={title} columns={columns} state={state} />
      <AccountDialog open={creating} onOpenChange={setCreating} onCreated={list.reload} />
    </>
  );
}
