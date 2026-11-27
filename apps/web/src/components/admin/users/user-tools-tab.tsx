'use client';

import { Fragment, useId, useRef, useState, type ReactNode } from 'react';
import { InfoIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  toolCoverage,
  type AccessSource,
  type LevelTool,
  type ToolMark,
  type UserLevel,
  type UserLevels,
  type UserServerLevel,
} from '@agent-os/contracts';
import { ShellLink } from '@/components/shell/shell-link';
import { StateBadge } from '@/components/state-badge';
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
import { builtinRoleName } from '@/i18n/builtin-name';
import { adminApi } from '@/lib/admin/admin-api';
import { adminPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_SIZE } from '../admin-form';
import { DataTable, LoadError } from '../data-table';
import {
  FilterRadios,
  LevelSelect,
  LevelTotal,
  ServerName,
  ToolsToggle,
  type LevelFilter,
} from '../levels/level-select';
import { coverageTool, rolePickStart } from '../levels/role-coverage';
import { LEVEL_HEAD, USER_LEVEL_TABLE } from '../levels/level-table';
import { SaveBar, saveOnShortcut } from '../levels/save-bar';
import {
  FIRST_OPEN_GROUPS,
  PersonalToolPicker,
  type OpenGroups,
  type ToolAccess,
} from '../levels/tool-picker';
import {
  useLevelDraft,
  type DraftRow,
  type LevelDraft,
  type LevelValue,
} from '../levels/use-level-draft';

type Marks = readonly ToolMark[];
type UserLevelValue = LevelValue<UserLevel, Marks>;
type UserDraft = LevelDraft<UserLevel, Marks>;

const USER_LEVELS: readonly UserLevel[] = [
  'none',
  'read',
  'all',
  'pick',
  'denied',
];

const NO_USER_LEVEL: UserLevelValue = { level: 'none', marks: [] };

/** Marks compare as sets: each tool is marked once, so equal size and every mark found means equal. */
const sameMarks = (a: Marks, b: Marks): boolean =>
  a.length === b.length &&
  b.every((mark) =>
    a.some((other) => other.tool === mark.tool && other.effect === mark.effect),
  );

/**
 * The marks a personal «Выборочно» starts with (access-level-editor, «Серверы сотрудника»): what the role's start
 * would mark, «Разрешён»; after «Запрещено» every tool «Запрещён».
 */
function personalPickStart(
  tools: readonly LevelTool[] | null,
  from: UserLevel,
): Marks {
  if (from === 'denied')
    return (tools ?? []).map((tool) => ({ tool: tool.name, effect: 'deny' }));
  return rolePickStart(tools, from).map((tool) => ({ tool, effect: 'allow' }));
}

const rowsOf = (levels: UserLevels): DraftRow<UserLevel, Marks>[] =>
  levels.servers.map((row) => ({
    key: row.server,
    value: { level: row.personal.level, marks: row.personal.marks },
  }));

export type UserLevelsState = {
  read: Resource<UserLevels>;
  /** The levels as last saved: the save's answer, otherwise the read. */
  shown: UserLevels | undefined;
  draft: UserDraft;
};

/**
 * The employee's personal levels and their draft, owned by the employee's page and not by the tab, so switching
 * tabs keeps unsaved changes and the opened rows (access-levels KD-7).
 */
export function useUserLevels(userId: string): UserLevelsState {
  const read = useResource(
    () => adminApi.users.levels(userId),
    `user-levels:${userId}`,
  );
  const { shown, draft } = useLevelDraft<UserLevels, UserLevel, Marks>({
    read: read.data,
    rowsOf,
    blank: NO_USER_LEVEL,
    sameMarks,
    startPick: (key, from, levels) =>
      personalPickStart(
        levels?.servers.find((server) => server.server === key)?.tools ?? null,
        from.level,
      ),
    save: (changed) =>
      adminApi.users.saveLevels(userId, {
        // Marks of a level left behind stay in the draft's memory; only `pick` sends them.
        servers: changed.map(({ key, value }) => ({
          server: key,
          level: value.level,
          marks: value.level === 'pick' ? [...value.marks] : [],
        })),
      }),
    logEvent: 'admin: user levels',
  });
  return { read, shown, draft };
}

/** What the coverage rule gives one tool of the server with the personal level on screen (access-levels KD-3). */
const coverageOf = (
  server: UserServerLevel,
  superAdmin: boolean,
  value: UserLevelValue,
  tool: LevelTool,
) =>
  toolCoverage({
    tool: coverageTool(tool),
    superAdmin,
    roles: server.roles.map((role) => ({
      roleId: role.id,
      level: role.level,
      picked: role.picked,
    })),
    personal: value,
  });

/** «Итог»: the tools the employee gets on a working server; nothing, or a server that does not work, is «—». */
function userGives(
  server: UserServerLevel,
  superAdmin: boolean,
  value: UserLevelValue,
): { n: number; total: number } | null {
  if (server.status !== 'enabled' || server.tools === null) return null;
  const n = server.tools.filter(
    (tool) => coverageOf(server, superAdmin, value, tool).state === 'available',
  ).length;
  return n === 0 ? null : { n, total: server.tools.length };
}

type UserToolsTabProps = {
  /** The employee's name as the page shows it. */
  userName: string;
  levels: UserLevelsState;
};

/** UXRD EA-01: the employee's «Инструменты» — personal levels, effective access and where it comes from. */
export function UserToolsTab({ userName, levels }: UserToolsTabProps) {
  const t = useTranslations('admin.users.tools');
  const tLevels = useTranslations('admin.levels');
  const { read, shown } = levels;
  const caption = t('caption', { name: userName });

  if (read.status === 'error' && shown === undefined)
    return <LoadError message={t('loadFailed')} onRetry={read.reload} />;
  if (shown === undefined)
    return (
      <DataTable
        caption={caption}
        columns={[
          { header: tLevels('column.server') },
          { header: tLevels('column.personal') },
          { header: tLevels('column.total') },
          { header: tLevels('column.from') },
        ]}
        state={{ status: 'loading' }}
      />
    );
  if (shown.servers.length === 0) return <NoServers />;
  return (
    <div className="flex flex-col gap-3">
      {shown.superAdmin && (
        <p
          className={cn(
            CAPTION,
            'flex items-start gap-2 text-muted-foreground',
          )}
        >
          <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {t('superAdmin', { name: userName })}
        </p>
      )}
      <LevelEditor
        caption={caption}
        servers={shown.servers}
        superAdmin={shown.superAdmin}
        draft={levels.draft}
      />
    </div>
  );
}

/** MC-40 «Серверов пока нет» with the link to «MCP-серверы». */
function NoServers() {
  const t = useTranslations('admin.users.tools');
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
      </p>
    </div>
  );
}

const table = USER_LEVEL_TABLE;

/**
 * EA-01: access-level-editor, variant «Серверы сотрудника» — the filter, a row per registered server with the
 * personal level, the effective total and «Откуда», the tools expandable on every server with tools, and the save
 * bar. The draft and the opened rows belong to the page; the filter and the groups live while the tab is open.
 */
function LevelEditor({
  caption,
  servers,
  superAdmin,
  draft,
}: {
  caption: string;
  servers: readonly UserServerLevel[];
  superAdmin: boolean;
  draft: UserDraft;
}) {
  const t = useTranslations('admin.levels');
  const pickerId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [openGroups, setOpenGroups] = useState<ReadonlyMap<string, OpenGroups>>(
    new Map(),
  );
  const saving = draft.status === 'saving';

  // «Выборочно» opens its row; the tools stay expandable at every other level (variant «Серверы сотрудника»).
  const setLevel = (server: string, level: UserLevel): void => {
    draft.setLevel(server, level);
    if (level === 'pick') draft.setExpanded(server, true);
  };

  const needle = query.trim().toLocaleLowerCase();
  const visible = servers.filter(
    (server) =>
      server.server.toLocaleLowerCase().includes(needle) &&
      (filter === 'all' ||
        userGives(server, superAdmin, draft.value(server.server)) !== null ||
        draft.isChanged(server.server)),
  );
  const filtered = visible.length < servers.length;

  const reset = (): void => {
    setQuery('');
    setFilter('all');
  };

  return (
    <div
      className={cn(table.container, 'flex min-w-0 flex-col gap-3')}
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
      <Table className={table.table}>
        <caption className="sr-only">{caption}</caption>
        <TableHeader className={table.header}>
          <TableRow className="h-8 hover:bg-transparent">
            {/* A quarter of the table: the name keeps room, «Откуда» takes what the fixed columns leave. */}
            <TableHead className={cn(LEVEL_HEAD, 'w-1/4')}>
              {t('column.server')}
            </TableHead>
            <TableHead className={cn(LEVEL_HEAD, 'w-56')}>
              {t('column.personal')}
            </TableHead>
            <TableHead className={cn(LEVEL_HEAD, 'w-24')}>
              {t('column.total')}
            </TableHead>
            <TableHead className={LEVEL_HEAD}>{t('column.from')}</TableHead>
            <TableHead className={cn(LEVEL_HEAD, 'w-36')}>
              <span className="sr-only">{t('tools')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className={table.body}>
          {visible.length === 0 ? (
            <TableRow className={cn(table.pickerRow, 'hover:bg-transparent')}>
              <TableCell
                colSpan={5}
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
              const tools = server.tools ?? [];
              const canExpand = tools.length > 0;
              const open = canExpand && draft.isExpanded(server.server);
              const id = `${pickerId}-${server.server}`;
              return (
                <ServerRows
                  key={server.server}
                  server={server}
                  value={value}
                  gives={userGives(server, superAdmin, value)}
                  from={
                    <AccessFrom
                      server={server}
                      superAdmin={superAdmin}
                      value={value}
                    />
                  }
                  changed={draft.isChanged(server.server)}
                  disabled={saving}
                  toggleCell={
                    canExpand ? (
                      <ToolsToggle
                        server={server.server}
                        expanded={open}
                        controls={id}
                        onToggle={() => draft.setExpanded(server.server, !open)}
                      />
                    ) : null
                  }
                  onLevelChange={(level) => setLevel(server.server, level)}
                  picker={
                    open ? (
                      <ServerTools
                        id={id}
                        server={server}
                        superAdmin={superAdmin}
                        value={value}
                        onMarksChange={(marks) =>
                          draft.setMarks(server.server, marks)
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
          searchRef.current?.focus();
        }}
        onSave={draft.submit}
      />
    </div>
  );
}

/** A level's name as MC-37 gives it, the same on every screen. */
function useLevelName(): (level: UserLevel) => string {
  const t = useTranslations('admin.levels');
  return (level) =>
    level === 'denied' ? t('personal.denied.label') : t(`role.${level}.label`);
}

/** The name of a source of access in «Откуда» and in a tool's line. */
function useSourceName(
  server: UserServerLevel,
): (source: AccessSource) => string {
  const t = useTranslations('admin.levels.from');
  const locale = useLocale();
  return (source) => {
    if (source.kind === 'super_admin') return t('superAdmin');
    if (source.kind === 'personal') return t('personal');
    const role = server.roles.find((entry) => entry.id === source.roleId);
    return role === undefined ? '' : builtinRoleName(role.name, locale);
  };
}

/**
 * «Откуда» (MC-40): «Супер-администратор»; otherwise «запрещён лично» first under a personal «Запрещено», then
 * every role with its level, «Все сотрудники» among them, and «лично» while the personal level gives something.
 */
function AccessFrom({
  server,
  superAdmin,
  value,
}: {
  server: UserServerLevel;
  superAdmin: boolean;
  value: UserLevelValue;
}) {
  const t = useTranslations('admin.levels');
  const locale = useLocale();
  const levelName = useLevelName();
  const parts = superAdmin
    ? [t('from.superAdmin')]
    : [
        ...server.roles.map((role) =>
          t('from.role', {
            role: builtinRoleName(role.name, locale),
            level: levelName(role.level),
          }),
        ),
        ...(value.level === 'none' || value.level === 'denied'
          ? []
          : [t('from.personal')]),
      ];
  const denied = !superAdmin && value.level === 'denied';
  if (parts.length === 0 && !denied)
    return <span className="text-data">{t('nothing')}</span>;
  // A line breaks between the sources only; a source longer than the column is cut with an ellipsis.
  return (
    <span
      className={cn(
        CAPTION,
        'flex min-w-0 flex-wrap items-center gap-x-1 text-muted-foreground',
      )}
    >
      {denied && <StateBadge state="closed">{t('coverage.denied')}</StateBadge>}
      {/* The space between the sources is a text node: the flex gap spaces them on screen, it keeps the text read. */}
      {parts.map((part, index) => (
        <Fragment key={part}>
          {index > 0 && ' '}
          <span className="max-w-full truncate" title={part}>
            {index < parts.length - 1 ? `${part} ·` : part}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** The expanded tools of one server: each with its effective access, the personal choice under «Выборочно». */
function ServerTools({
  id,
  server,
  superAdmin,
  value,
  onMarksChange,
  openGroups,
  onOpenGroupsChange,
  disabled,
}: {
  id: string;
  server: UserServerLevel;
  superAdmin: boolean;
  value: UserLevelValue;
  onMarksChange: (marks: Marks) => void;
  openGroups: OpenGroups;
  onOpenGroupsChange: (open: OpenGroups) => void;
  disabled: boolean;
}) {
  const sourceName = useSourceName(server);
  const accessOf = (tool: LevelTool): ToolAccess => {
    const { state, sources } = coverageOf(server, superAdmin, value, tool);
    return {
      state,
      from: sources.length === 0 ? null : sources.map(sourceName).join(' · '),
    };
  };
  return (
    <PersonalToolPicker
      server={server.server}
      id={id}
      tools={server.tools ?? []}
      accessOf={accessOf}
      marks={value.level === 'pick' ? value.marks : null}
      savedMarks={server.personal.level === 'pick' ? server.personal.marks : []}
      onMarksChange={onMarksChange}
      openGroups={openGroups}
      onOpenGroupsChange={onOpenGroupsChange}
      disabled={disabled}
    />
  );
}

type ServerRowsProps = {
  server: UserServerLevel;
  value: UserLevelValue;
  gives: { n: number; total: number } | null;
  from: ReactNode;
  changed: boolean;
  disabled: boolean;
  toggleCell: ReactNode;
  onLevelChange: (level: UserLevel) => void;
  /** The expanded tools, a row of one cell under the server's row. */
  picker: ReactNode;
};

/** Parts 3–5: the server's row and, when expanded, the row of its tools; stacked while the columns do not fit. */
function ServerRows({
  server,
  value,
  gives,
  from,
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
            label={t('accessName.personal', { server: server.server })}
            variant="personal"
            levels={USER_LEVELS}
            value={value.level}
            onChange={onLevelChange}
            canPick={server.tools !== null}
            disabled={disabled}
          />
        </TableCell>
        <TableCell className={table.cell}>
          <LevelTotal gives={gives} />
        </TableCell>
        <TableCell
          className={cn(
            table.cell,
            table.line,
            table.last,
            'whitespace-normal',
          )}
        >
          {from}
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
            colSpan={5}
            className={cn(table.pickerCell, 'px-3 pb-3 whitespace-normal')}
          >
            {picker}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
