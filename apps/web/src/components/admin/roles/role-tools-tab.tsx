'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { InfoIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  toolCoverage,
  type RoleLevel,
  type RoleLevels,
  type RoleServerLevel,
} from '@agent-os/contracts';
import { ShellLink } from '@/components/shell/shell-link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useResource, type Resource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { adminPath, adminRecordPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_SIZE, FormWarning } from '../admin-form';
import {
  DataTable,
  LoadError,
  type DataTableColumn,
  type DataTableRow,
} from '../data-table';
import {
  FilterRadios,
  LevelSelect,
  LevelTotal,
  ServerName,
  ToolsToggle,
  type LevelFilter,
} from '../levels/level-select';
import {
  coverageTool,
  NO_ROLE_LEVEL,
  ROLE_LEVELS,
  rolePickStart,
  roleGives,
  samePicked,
  type RoleLevelValue,
} from '../levels/role-coverage';
import { LEVEL_HEAD, ROLE_LEVEL_TABLE } from '../levels/level-table';
import { SaveBar, saveOnShortcut } from '../levels/save-bar';
import {
  FIRST_OPEN_GROUPS,
  ToolPicker,
  type OpenGroups,
} from '../levels/tool-picker';
import {
  useLevelDraft,
  type DraftRow,
  type LevelDraft,
} from '../levels/use-level-draft';

/** The query parameter that opens a role's «Инструменты» on one server's row (access-levels C3 web «Адреса»). */
const SERVER_PARAM = 'server';

/**
 * The only way the deep link «a role's «Инструменты» with a server's row opened» is built:
 * `/admin/roles/<id>?server=<имя>` — the server page's «Выбрать инструменты» (ST-02) leads here.
 */
export const roleToolsServerPath = (roleId: string, server: string): string =>
  `${adminRecordPath('roles', roleId)}?${new URLSearchParams({ [SERVER_PARAM]: server }).toString()}`;

/** The server the address asks to open, read once when the tab mounts: it is where the administrator came in. */
const linkedServer = (): string | null =>
  new URLSearchParams(window.location.search).get(SERVER_PARAM);

type RoleDraft = LevelDraft<RoleLevel, readonly string[]>;

const rowsOf = (levels: RoleLevels): DraftRow<RoleLevel, readonly string[]>[] =>
  levels.servers.map((row) => ({
    key: row.server,
    value: { level: row.level, marks: row.picked },
  }));

export type RoleLevelsState = {
  read: Resource<RoleLevels>;
  /** The servers as last saved: the save's answer, otherwise the read. */
  servers: readonly RoleServerLevel[] | undefined;
  draft: RoleDraft;
};

/**
 * The role's levels and their draft, owned by the role's page and not by the tab, so switching tabs keeps unsaved
 * changes and the opened rows (access-levels KD-7).
 */
export function useRoleLevels(roleId: string): RoleLevelsState {
  const read = useResource(
    () => adminApi.roles.levels(roleId),
    `role-levels:${roleId}`,
  );
  const { shown, draft } = useLevelDraft<
    RoleLevels,
    RoleLevel,
    readonly string[]
  >({
    read: read.data,
    rowsOf,
    blank: NO_ROLE_LEVEL,
    sameMarks: samePicked,
    startPick: (key, from, levels) =>
      rolePickStart(
        levels?.servers.find((server) => server.server === key)?.tools ?? null,
        from.level,
      ),
    save: (changed) =>
      adminApi.roles.saveLevels(roleId, {
        // Marks of a level left behind stay in the draft's memory; only `pick` sends them.
        servers: changed.map(({ key, value }) => ({
          server: key,
          level: value.level,
          picked: value.level === 'pick' ? [...value.marks] : [],
        })),
      }),
    logEvent: 'admin: role levels',
  });
  return { read, servers: shown?.servers, draft };
}

type RoleToolsTabProps = {
  /** The role's name as the page shows it. */
  roleName: string;
  builtinKind: 'super_admin' | 'everyone' | null;
  levels: RoleLevelsState;
};

/** UXRD LV-01–LV-04: the role's «Инструменты» — the level editor, or the read-only summary of «Супер-администратор». */
export function RoleToolsTab({
  roleName,
  builtinKind,
  levels,
}: RoleToolsTabProps) {
  const t = useTranslations('admin.roles.tools');
  const tLevels = useTranslations('admin.levels');
  const { read, servers } = levels;
  const caption = t('caption', { role: roleName });

  if (read.status === 'error' && servers === undefined)
    return <LoadError message={t('loadFailed')} onRetry={read.reload} />;
  if (servers === undefined)
    return (
      <DataTable
        caption={caption}
        columns={[
          { header: tLevels('column.server') },
          { header: tLevels('column.access') },
          { header: tLevels('column.total') },
        ]}
        state={{ status: 'loading' }}
      />
    );
  if (servers.length === 0) return <NoServers />;
  if (builtinKind === 'super_admin')
    return <SuperAdminSummary caption={caption} servers={servers} />;
  return (
    <div className="flex flex-col gap-3">
      {builtinKind === 'everyone' && (
        <FormWarning>{t('everyoneWarning')}</FormWarning>
      )}
      <p className="text-data text-muted-foreground">{t('description')}</p>
      <LevelEditor caption={caption} servers={servers} draft={levels.draft} />
    </div>
  );
}

/** MC-38 «Серверов пока нет» with the link to «MCP-серверы». */
function NoServers() {
  const t = useTranslations('admin.roles.tools');
  return (
    <div className="flex flex-col items-center gap-1 py-12 text-center">
      <p className="text-sm leading-5 font-medium text-foreground">
        {t('noServers')}
      </p>
      <p className={cn(CAPTION, 'text-muted-foreground')}>
        {t('noServersBefore')}
        <ShellLink
          href={adminPath('servers')}
          className="underline underline-offset-2 hover:text-foreground"
        >
          {t('noServersLink')}
        </ShellLink>
        {t('noServersAfter')}
      </p>
    </div>
  );
}

/**
 * LV-04: what «Супер-администратор» gets — every tool of an enabled server except the ones switched off for
 * everyone, by the coverage rule; a server that does not work for agents reads its badge and «—».
 */
function SuperAdminSummary({
  caption,
  servers,
}: {
  caption: string;
  servers: readonly RoleServerLevel[];
}) {
  const t = useTranslations('admin.roles.tools');
  const tLevels = useTranslations('admin.levels');
  const gives = (server: RoleServerLevel) => {
    if (server.status !== 'enabled' || server.tools === null) return null;
    const n = server.tools.filter(
      (tool) =>
        toolCoverage({
          tool: coverageTool(tool),
          superAdmin: true,
          roles: [],
          personal: { level: 'none', marks: [] },
        }).state === 'available',
    ).length;
    return n === 0 ? null : { n, total: server.tools.length };
  };
  const columns: readonly DataTableColumn[] = [
    { header: tLevels('column.server') },
    { header: tLevels('column.total') },
  ];
  const rows: DataTableRow[] = servers.map((server) => ({
    key: server.server,
    name: server.server,
    href: adminRecordPath('servers', server.server),
    cells: [
      <ServerName key="name" name={server.server} status={server.status} />,
      <LevelTotal key="total" gives={gives(server)} />,
    ],
  }));
  return (
    <div className="flex flex-col gap-3">
      <p
        className={cn(CAPTION, 'flex items-start gap-2 text-muted-foreground')}
      >
        <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        {t('superAdmin')}
      </p>
      <DataTable
        caption={caption}
        columns={columns}
        state={{ status: 'ready', rows }}
      />
    </div>
  );
}

const table = ROLE_LEVEL_TABLE;

/**
 * LV-01–LV-03: access-level-editor, variant «Серверы роли» — the filter, a row per registered server, «Выборочно»
 * expanded under its row, and the save bar. The draft and the opened rows belong to the page; the filter and the
 * groups live while the tab is open.
 */
function LevelEditor({
  caption,
  servers,
  draft,
}: {
  caption: string;
  servers: readonly RoleServerLevel[];
  draft: RoleDraft;
}) {
  const t = useTranslations('admin.levels');
  const pickerId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [linked] = useState(linkedServer);
  const [openGroups, setOpenGroups] = useState<ReadonlyMap<string, OpenGroups>>(
    new Map(),
  );
  const saving = draft.status === 'saving';
  const { setExpanded } = draft;

  // The deep link opens its server's row (shown only while the row is at «Выборочно») and puts the focus on its
  // level choice. The panel focuses the page's `h1` on the frame the page appears (`AdminScreen`), so the choice
  // takes it a frame later.
  useEffect(() => {
    if (linked === null) return;
    setExpanded(linked, true);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() =>
        tableRef.current
          ?.querySelector<HTMLElement>(
            `tr[data-server="${CSS.escape(linked)}"] [role="combobox"]`,
          )
          ?.focus(),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [linked, setExpanded]);

  // «Выборочно» opens its row; leaving it collapses the row (access-level-editor, States).
  const setLevel = (server: string, level: RoleLevel): void => {
    draft.setLevel(server, level);
    setExpanded(server, level === 'pick');
  };

  const needle = query.trim().toLocaleLowerCase();
  const visible = servers.filter(
    (server) =>
      server.server.toLocaleLowerCase().includes(needle) &&
      (filter === 'all' ||
        draft.value(server.server).level !== 'none' ||
        draft.isChanged(server.server)),
  );
  const filtered = visible.length < servers.length;

  const reset = (): void => {
    setQuery('');
    setFilter('all');
  };

  return (
    <div
      className={cn(table.container, 'flex flex-col gap-3')}
      onKeyDown={(event) => saveOnShortcut(event, draft.submit)}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') {
              event.stopPropagation();
              setQuery('');
            }
          }}
          aria-label={t('searchServer')}
          placeholder={t('searchServer')}
          disabled={saving}
          className={cn(CONTROL_SIZE, 'text-data md:w-72 md:text-data')}
        />
        <FilterRadios value={filter} onChange={setFilter} disabled={saving} />
        {filtered && (
          <span className={cn(CAPTION, 'text-muted-foreground md:ml-auto')}>
            {t('shown', { n: visible.length, total: servers.length })}
          </span>
        )}
      </div>
      <Table ref={tableRef} className={table.table}>
        <caption className="sr-only">{caption}</caption>
        <TableHeader className={table.header}>
          <TableRow className="h-8 hover:bg-transparent">
            <TableHead className={LEVEL_HEAD}>{t('column.server')}</TableHead>
            <TableHead className={cn(LEVEL_HEAD, 'w-56')}>
              {t('column.access')}
            </TableHead>
            <TableHead className={cn(LEVEL_HEAD, 'w-28')}>
              {t('column.total')}
            </TableHead>
            <TableHead className={cn(LEVEL_HEAD, 'w-36')}>
              <span className="sr-only">{t('tools')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className={table.body}>
          {visible.length === 0 ? (
            <TableRow className={cn(table.pickerRow, 'hover:bg-transparent')}>
              <TableCell
                colSpan={4}
                className={cn(table.pickerCell, 'px-3 py-3')}
              >
                <span className="flex flex-wrap items-center gap-2 text-data text-muted-foreground">
                  {t('noMatches')}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={CONTROL_SIZE}
                    onClick={reset}
                  >
                    {t('resetFilter')}
                  </Button>
                </span>
              </TableCell>
            </TableRow>
          ) : (
            visible.map((server) => {
              const value = draft.value(server.server);
              const canPick = server.tools !== null;
              const open =
                value.level === 'pick' &&
                canPick &&
                draft.isExpanded(server.server);
              const id = `${pickerId}-${server.server}`;
              return (
                <ServerRows
                  key={server.server}
                  server={server}
                  value={value}
                  changed={draft.isChanged(server.server)}
                  disabled={saving}
                  toggleCell={
                    value.level === 'pick' && canPick ? (
                      <ToolsToggle
                        server={server.server}
                        expanded={open}
                        controls={id}
                        onToggle={() => setExpanded(server.server, !open)}
                      />
                    ) : null
                  }
                  onLevelChange={(level) => setLevel(server.server, level)}
                  picker={
                    open && server.tools !== null ? (
                      <ToolPicker
                        server={server.server}
                        id={id}
                        tools={server.tools}
                        picked={value.marks}
                        savedPicked={
                          server.level === 'pick' ? server.picked : []
                        }
                        onPickedChange={(picked) =>
                          draft.setMarks(server.server, picked)
                        }
                        openGroups={
                          openGroups.get(server.server) ?? FIRST_OPEN_GROUPS
                        }
                        onOpenGroupsChange={(next) =>
                          setOpenGroups((current) =>
                            new Map(current).set(server.server, next),
                          )
                        }
                        disabled={saving}
                      />
                    ) : null
                  }
                />
              );
            })
          )}
        </TableBody>
      </Table>
      <SaveBar
        unit="servers"
        changedCount={draft.changedCount}
        status={draft.status}
        error={draft.error}
        onDiscard={() => {
          draft.discard();
          draft.collapseAll();
          searchRef.current?.focus();
        }}
        onSave={draft.submit}
      />
    </div>
  );
}

type ServerRowsProps = {
  server: RoleServerLevel;
  value: RoleLevelValue;
  changed: boolean;
  disabled: boolean;
  toggleCell: ReactNode;
  onLevelChange: (level: RoleLevel) => void;
  /** The expanded «Выборочно» part, a row of one cell under the server's row. */
  picker: ReactNode;
};

/** Parts 3–5: the server's row and, when expanded, the row of its tools; stacked while the columns do not fit. */
function ServerRows({
  server,
  value,
  changed,
  disabled,
  toggleCell,
  onLevelChange,
  picker,
}: ServerRowsProps) {
  const t = useTranslations('admin.levels');
  return (
    <>
      <TableRow
        data-server={server.server}
        className={cn(table.row, picker !== null && 'border-b-0')}
      >
        <TableCell className={cn(table.cell, table.line, 'whitespace-normal')}>
          <ServerName
            name={server.server}
            status={server.status}
            changed={changed}
          />
        </TableCell>
        <TableCell className={cn(table.cell, table.line)}>
          <LevelSelect
            label={t('accessName.server', { server: server.server })}
            variant="role"
            levels={ROLE_LEVELS}
            value={value.level}
            onChange={onLevelChange}
            canPick={server.tools !== null}
            disabled={disabled}
          />
        </TableCell>
        <TableCell className={table.cell}>
          <LevelTotal gives={roleGives(server.tools, value)} />
        </TableCell>
        <TableCell className={cn(table.cell, table.end)}>
          {toggleCell}
        </TableCell>
      </TableRow>
      {picker !== null && (
        <TableRow
          className={cn(table.pickerRow, 'border-border hover:bg-transparent')}
        >
          <TableCell
            colSpan={4}
            className={cn(table.pickerCell, 'px-3 pb-3 whitespace-normal')}
          >
            {picker}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
