'use client';

import { useState, type ReactNode } from 'react';
import { PlusIcon, ShieldCheckIcon, UserIcon, UsersIcon } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CHAT_BUILTIN_KEY, type BannedRecord, type RecordSummary } from '@agent-os/contracts';
import { CONTROL_SIZE } from '@/components/admin/admin-form';
import { RecordPlaceholder, useAdminTitles } from '@/components/admin/admin-header';
import {
  DataTable,
  resourceTableState,
  type DataTableColumn,
  type DataTableRow,
} from '@/components/admin/data-table';
import { DeleteRecordDialog } from '@/components/library/delete-record-dialog';
import { KnowledgePage } from '@/components/library/knowledge-page';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { ShellLink } from '@/components/shell/shell-link';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { isNotFound } from '@/lib/admin/admin-errors';
import { builtinName, builtinRoleName } from '@/lib/i18n/builtin-name';
import { formatListTime } from '@/lib/i18n/formats';
import type { LibraryTranslator } from '@/lib/i18n/messages';
import type { Locale } from '@/lib/i18n/pick-locale';
import { describeLibraryError } from '@/lib/library/library-errors';
import { recordAction } from '@/lib/library/record-action';
import { adminLibraryTabPath, adminNewRecordPath, adminRecordPath, LIBRARY_TABS, type AdminPage, type LibraryTab } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { CloseAccessDialog, EmployeeRecordPage, panelRecordHref, type ClosableRecord } from './employee-record-page';
import { KnowledgeSettingsForm } from './knowledge-settings-form';
import { LibrarySettingsForm } from './library-settings-form';
import { useTakenHandoff } from '@/components/library/record-editor';
import { NewSystemRecordPage, SystemRecordPage } from './system-record-page';

const EMPTY_VALUE = '—';

type SectionTranslator = ReturnType<typeof useTranslations<'admin.library'>>;

const systemColumns = (t: SectionTranslator): readonly DataTableColumn[] => [
  { header: t('record') },
  { header: t('kind') },
  { header: t('audience'), shrinks: true },
  { header: t('version'), align: 'end' },
];

const sharedColumns = (t: SectionTranslator): readonly DataTableColumn[] => [
  { header: t('record') },
  { header: t('author') },
  { header: t('roles'), shrinks: true },
  { header: t('inChat') },
];

const bansColumns = (t: SectionTranslator): readonly DataTableColumn[] => [
  { header: t('record') },
  { header: t('author') },
  { header: t('closedAt') },
];

type LibrarySectionProps = {
  /** A tab, a record or a new record, from the address (design-web.md KD-1). */
  page: AdminPage;
};

/**
 * UXRD AL-01: the panel's «Агенты и workflow». Each tab is an address, so a reload and «Назад» return it (DC-6);
 * a record is AL-03. Mounted by `AdminScreen` only, under `AdminGate`.
 */
export function LibrarySection({ page }: LibrarySectionProps) {
  if (page.kind === 'record') return <LibraryRecord key={page.key} id={page.key} />;
  if (page.kind === 'knowledge') return <KnowledgePage key={page.key} id={page.key} variant="panel" />;
  if (page.kind === 'new' && page.recordKind !== undefined) {
    return <NewSystemRecordPage key={page.recordKind} kind={page.recordKind} />;
  }
  return <LibraryTabs tab={page.kind === 'list' ? (page.tab ?? 'system') : 'system'} />;
}

/** `/admin/library/<id>`: the record read on open; any 404 is the panel's «Запись не найдена». */
function LibraryRecord({ id }: { id: string }) {
  const t = useTranslations('admin.library');
  const record = useResource(() => adminApi.library.get(id), `library:${id}`);
  // Taken on mount, before the record is read: leaving during the read must not leave the handoff behind.
  const handoff = useTakenHandoff(adminRecordPath('library', id));
  if (isNotFound(record.error)) return <ThreadNotice variant="record-not-found" section="library" />;
  if (record.data === undefined) {
    return <RecordPlaceholder section="library" resource={record} loadFailed={t('loadFailed')} />;
  }
  // A record without an author is the company's: AL-02, the administrator edits it; an employee's is AL-03.
  if (record.data.author === null) return <SystemRecordPage record={record.data} handoff={handoff} />;
  return <EmployeeRecordPage record={record.data} />;
}

function LibraryTabs({ tab }: { tab: LibraryTab }) {
  const t = useTranslations('admin.library');
  const titles = useAdminTitles();
  const title = titles.section('library');
  const [query, setQuery] = useState('');

  return (
    <>
      <PageHeader area={titles.panel} title={title}>
        <CreateMenu />
      </PageHeader>
      <Tabs value={tab} className="gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            {LIBRARY_TABS.map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                nativeButton={false}
                className="pointer-coarse:h-11"
                render={<ShellLink href={adminLibraryTabPath(value)} />}
              >
                {t(`tabs.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          {tab === 'shared' && (
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('search')}
              placeholder={t('search')}
              className={cn(CONTROL_SIZE, 'min-w-0 flex-1 text-data md:ml-auto md:w-72 md:flex-none md:text-data')}
            />
          )}
        </div>
        <TabsContent value={tab}>
          {tab === 'system' && (
            <div className="flex flex-col gap-8">
              <SystemTab caption={t('tabs.system')} />
              <LibrarySettingsForm />
              <KnowledgeSettingsForm />
            </div>
          )}
          {tab === 'shared' && <SharedTab caption={t('tabs.shared')} query={query.trim()} />}
          {tab === 'bans' && <BansTab caption={t('tabs.bans')} />}
        </TabsContent>
      </Tabs>
    </>
  );
}

/** «Создать» (AL-01): «Агент» and «Workflow» lead to the empty forms of AL-02. */
function CreateMenu() {
  const t = useTranslations('library.screen');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" className={CONTROL_SIZE} />}>
        <PlusIcon aria-hidden />
        {t('create')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-36">
        {(['agent', 'workflow'] as const).map((kind) => (
          <DropdownMenuItem key={kind} render={<ShellLink href={adminNewRecordPath(kind)} />}>
            {t(kind)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The record's name; `extra` follows it on the same line. */
function NameCell({ name, extra }: { name: string; extra?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate" title={name}>
        {name}
      </span>
      {extra}
    </span>
  );
}

/** «Видят» of a company record: roles with `Users`, employees with `User` (AL-01). */
function AudienceCell({ record }: { record: RecordSummary }) {
  const t = useTranslations('admin.library');
  const locale = useLocale();
  if (record.builtinKey === CHAT_BUILTIN_KEY) return <>{t('everyoneWithRights')}</>;
  if (record.audience.everyone === true) return <>{t('everyone')}</>;
  const holders = [
    ...record.audience.roles.map((role) => ({ key: role.id, name: builtinRoleName(role.name, locale), Icon: UsersIcon })),
    ...(record.audience.users ?? []).map((user) => ({ key: user.id, name: user.name, Icon: UserIcon })),
  ];
  if (holders.length === 0) return <>{EMPTY_VALUE}</>;
  return (
    <span className="flex min-w-0 items-center gap-3 truncate">
      {holders.map(({ key, name, Icon }) => (
        <span key={key} className="inline-flex min-w-0 items-center gap-1" title={name}>
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{name}</span>
        </span>
      ))}
    </span>
  );
}

type SystemRowContext = {
  t: SectionTranslator;
  tLibrary: LibraryTranslator;
  locale: Locale;
  onDelete: (record: RecordSummary) => void;
};

function systemRow(record: RecordSummary, { t, tLibrary, locale, onDelete }: SystemRowContext): DataTableRow {
  // A built-in record is never deleted (AC-12.2).
  const deletable = record.canDelete && record.builtinKey === null;
  const name = builtinName(record, locale);
  return {
    key: record.id,
    name,
    href: panelRecordHref(record.id),
    cells: [
      <NameCell
        key="name"
        name={name}
        extra={record.builtinKey !== null && <StateBadge variant="source">{t('builtin')}</StateBadge>}
      />,
      tLibrary('kind', { kind: record.kind }),
      <AudienceCell key="audience" record={record} />,
      record.version,
    ],
    actions: deletable ? [{ label: t('delete'), onSelect: () => onDelete(record) }] : undefined,
  };
}

/**
 * «Системные»: agents and workflows of the company; never empty, the built-in ones are always there. «Удалить»
 * in the row's menu, except on a built-in record; after the delete the list is read again and the row leaves.
 */
function SystemTab({ caption }: { caption: string }) {
  const t = useTranslations('admin.library');
  const tLibrary = useTranslations('library');
  const locale = useLocale();
  const list = useResource(adminApi.library.system, 'library:system');
  const [deleting, setDeleting] = useState<RecordSummary | null>(null);
  const state = resourceTableState(list, t('loadFailed'), (records) => ({
    rows: records.map((record) => systemRow(record, { t, tLibrary, locale, onDelete: setDeleting })),
  }));
  return (
    <>
      <DataTable caption={caption} columns={systemColumns(t)} state={state} actionsAs="menu" />
      {deleting !== null && (
        <DeleteRecordDialog
          record={deleting}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          variant="admin"
          onDeleted={list.reload}
        />
      )}
    </>
  );
}

function AuthorCell({ author }: { author: { name: string; disabled: boolean } }) {
  const t = useTranslations('admin.library');
  return (
    <NameCell name={author.name} extra={author.disabled && <StateBadge state="off">{t('disabled')}</StateBadge>} />
  );
}

const matches = (record: RecordSummary, query: string, locale: Locale): boolean => {
  const lower = (text: string): string => text.toLocaleLowerCase(locale);
  const needle = lower(query);
  return lower(record.name).includes(needle) || (record.author !== null && lower(record.author.name).includes(needle));
};

/** A row of «Открытые ролям» is an employee's record: the server never lists a company record there. */
const closable = (record: RecordSummary): ClosableRecord | null =>
  record.author === null ? null : { ...record, author: record.author };

/** «Открытые ролям» (AL-01): employees' records open to roles, searched by name or author; «Закрыть доступ» in the menu. */
function SharedTab({ caption, query }: { caption: string; query: string }) {
  const t = useTranslations('admin.library');
  const locale = useLocale();
  const list = useResource(adminApi.library.shared, 'library:shared');
  const [closing, setClosing] = useState<ClosableRecord | null>(null);

  const row = (record: RecordSummary): DataTableRow => {
    const target = closable(record);
    const roles = record.audience.roles.map((role) => builtinRoleName(role.name, locale)).join(', ');
    return {
      key: record.id,
      name: record.name,
      href: panelRecordHref(record.id),
      cells: [
        <span key="name" className="flex min-w-0 flex-col py-1.5">
          <span className="truncate" title={record.name}>
            {record.name}
          </span>
          <span className="truncate text-xs leading-4 text-muted-foreground" title={record.description}>
            {record.description}
          </span>
        </span>,
        record.author === null ? EMPTY_VALUE : <AuthorCell key="author" author={record.author} />,
        <span key="roles" className="block truncate" title={roles}>
          {roles === '' ? EMPTY_VALUE : roles}
        </span>,
        record.offerInChat ? t('yes') : t('no'),
      ],
      actions: target === null ? undefined : [{ label: t('close'), onSelect: () => setClosing(target) }],
    };
  };

  const state = resourceTableState(list, t('loadFailed'), (records) => {
    const shown = query === '' ? records : records.filter((record) => matches(record, query, locale));
    return {
      rows: shown.map(row),
      empty: { Icon: UsersIcon, title: t('sharedEmpty') },
      noMatches: query === '' ? undefined : t('noMatches'),
    };
  });

  return (
    <>
      <DataTable caption={caption} columns={sharedColumns(t)} state={state} actionsAs="menu" />
      {closing !== null && (
        <CloseAccessDialog
          record={closing}
          open
          onOpenChange={(open) => {
            if (!open) setClosing(null);
          }}
          onClosed={list.reload}
        />
      )}
    </>
  );
}

/** «Запреты» (AL-04): name, author and the date of the close; «Снять запрет» lifts it at once, without a dialog. */
function BansTab({ caption }: { caption: string }) {
  const list = useResource(adminApi.library.bans, 'library:bans');
  const format = useFormatter();
  const t = useTranslations('errors');
  const tSection = useTranslations('admin.library');
  const { libraryIndex } = useShellServices();
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: ReactNode } | null>(null);

  async function liftBan(record: BannedRecord): Promise<void> {
    setFailure(null);
    setPending(record.id);
    try {
      await recordAction({ recordId: record.id, kind: record.kind, action: 'unban', version: null }, () =>
        adminApi.library.liftBan(record.id),
      );
      toast.success(tSection('banLifted'));
      void libraryIndex.refresh();
    } catch (error) {
      setFailure({ id: record.id, text: describeLibraryError(t, error, { where: 'panel', kind: record.kind }).text });
    } finally {
      setPending(null);
      list.reload();
    }
  }

  const row = (record: BannedRecord): DataTableRow => ({
    key: record.id,
    name: record.name,
    cells: [
      <NameCell key="name" name={record.name} />,
      <AuthorCell key="author" author={record.author} />,
      formatListTime(format, record.closedAt),
    ],
    actions: [
      {
        label: tSection('liftBan'),
        onSelect: () => void liftBan(record),
        pending: pending === record.id,
        // One lift at a time: the other rows wait for the read that follows it.
        disabled: pending !== null,
      },
    ],
    error: failure?.id === record.id ? failure.text : undefined,
  });

  const state = resourceTableState(list, tSection('loadFailed'), (records) => ({
    rows: records.map(row),
    empty: { Icon: ShieldCheckIcon, title: tSection('bansEmpty') },
  }));

  return <DataTable caption={caption} columns={bansColumns(tSection)} state={state} />;
}
