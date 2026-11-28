'use client';

import { useId, useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { PlusIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type {
  BuiltinRoleKind,
  RoleLevel,
  RoleSummary,
  ServerAccess,
} from '@agent-os/contracts';
import { ShellLink } from '@/components/shell/shell-link';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PopoverContent } from '@/components/ui/popover';
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
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_EDGE, CONTROL_SIZE } from '../admin-form';
import { DataTable, LoadError } from '../data-table';
import { ChangedDot, LevelSelect, LevelTotal } from '../levels/level-select';
import {
  NO_ROLE_LEVEL,
  ROLE_LEVELS,
  roleGives,
  rolePickStart,
  samePicked,
} from '../levels/role-coverage';
import { LEVEL_HEAD, SERVER_ROLES_TABLE } from '../levels/level-table';
import { SaveBar, saveOnShortcut } from '../levels/save-bar';
import {
  useLevelDraft,
  type DraftRow,
  type LevelDraft,
} from '../levels/use-level-draft';
import { roleToolsServerPath } from '../roles/role-tools-tab';

type AccessRead = { access: ServerAccess; roles: readonly RoleSummary[] };

type AccessDraft = LevelDraft<RoleLevel, readonly string[]>;

const rowsOf = (
  access: ServerAccess,
): DraftRow<RoleLevel, readonly string[]>[] =>
  access.roles.map((role) => ({
    key: role.id,
    value: { level: role.level, marks: role.picked },
  }));

export type ServerAccessState = {
  read: Resource<AccessRead>;
  /** The server's access as last saved: the save's answer, otherwise the read. */
  access: ServerAccess | undefined;
  draft: AccessDraft;
};

/**
 * The roles' levels on one server and their draft, owned by the server's page so switching tabs keeps unsaved
 * changes (access-levels KD-7). The role list gives the «Супер-администратор» row and the roles to add
 * (access-levels «ServerAccess»).
 */
export function useServerAccess(server: string): ServerAccessState {
  const read = useResource(async (): Promise<AccessRead> => {
    const [access, roles] = await Promise.all([
      adminApi.servers.access(server),
      adminApi.roles.list(),
    ]);
    return { access, roles };
  }, `server-access:${server}`);
  const { shown, draft } = useLevelDraft<
    ServerAccess,
    RoleLevel,
    readonly string[]
  >({
    read: read.data?.access,
    rowsOf,
    blank: NO_ROLE_LEVEL,
    sameMarks: samePicked,
    startPick: (_role, from, access) =>
      rolePickStart(access?.tools ?? null, from.level),
    save: (changed) =>
      adminApi.servers.saveAccess(server, {
        // Marks of a level left behind stay in the draft's memory; only `pick` sends them.
        roles: changed.map(({ key, value }) => ({
          roleId: key,
          level: value.level,
          picked: value.level === 'pick' ? [...value.marks] : [],
        })),
      }),
    logEvent: 'admin: server access',
  });
  return { read, access: shown, draft };
}

/** A role as a row of «Роли сервера» shows it. */
type AccessRole = {
  id: string;
  name: string;
  builtinKind: BuiltinRoleKind | null;
  memberCount: number | null;
};

const table = SERVER_ROLES_TABLE;

/**
 * UXRD ST-02: access-level-editor, variant «Роли сервера» — «Супер-администратор» first with «Все» and no choice,
 * then «Все сотрудники» when it has access, then the other roles with access by name; «Дать доступ ролям» adds roles
 * at «Только чтение», and the save bar sends the changed roles only (UXRD KD-11).
 */
export function ServerAccessTab({
  server,
  state,
}: {
  server: string;
  state: ServerAccessState;
}) {
  const t = useTranslations('admin.servers.access');
  const tLevels = useTranslations('admin.levels');
  const locale = useLocale();
  const { read, access, draft } = state;
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const caption = t('caption', { server });

  if (read.status === 'error' && access === undefined)
    return <LoadError message={t('loadFailed')} onRetry={read.reload} />;
  const roles = read.data?.roles;
  if (access === undefined || roles === undefined)
    return (
      <DataTable
        caption={caption}
        columns={[
          { header: tLevels('column.role') },
          { header: tLevels('column.access') },
          { header: tLevels('column.total') },
        ]}
        state={{ status: 'loading' }}
      />
    );

  const saving = draft.status === 'saving';
  const nameOf = (role: AccessRole): string =>
    builtinRoleName(role.name, locale);
  const superAdmin = roles.find((role) => role.builtinKind === 'super_admin');
  const savedIds = new Set(access.roles.map((role) => role.id));
  // A role stays while it has access or a change: one moved to «Нет» keeps its row with the dot until the save.
  const rows: AccessRole[] = [
    ...access.roles,
    ...roles.filter(
      (role) =>
        role.builtinKind !== 'super_admin' &&
        !savedIds.has(role.id) &&
        draft.isChanged(role.id),
    ),
  ].sort(
    (a, b) =>
      Number(b.builtinKind === 'everyone') -
        Number(a.builtinKind === 'everyone') ||
      nameOf(a).localeCompare(nameOf(b), locale),
  );
  const shownIds = new Set(rows.map((role) => role.id));
  const addable = roles.filter(
    (role) => role.builtinKind !== 'super_admin' && !shownIds.has(role.id),
  );

  const needle = query.trim().toLocaleLowerCase();
  const found = (role: AccessRole): boolean =>
    nameOf(role).toLocaleLowerCase().includes(needle);
  const visible = rows.filter(found);
  const superAdminShown = superAdmin !== undefined && found(superAdmin);

  return (
    <div
      className={cn(table.container, 'flex flex-col gap-3')}
      onKeyDown={(event) => saveOnShortcut(event, draft.submit)}
    >
      <p className="text-data text-muted-foreground">
        {t('description', { server })}
      </p>
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
          aria-label={t('search')}
          placeholder={t('search')}
          disabled={saving}
          className={cn(CONTROL_SIZE, 'text-data md:w-72 md:text-data')}
        />
        <GrantRoles
          roles={addable.map((role) => ({ id: role.id, name: nameOf(role) }))}
          disabled={saving}
          onAdd={(ids) => {
            for (const id of ids) draft.setLevel(id, 'read');
          }}
        />
      </div>
      <Table className={table.table}>
        <caption className="sr-only">{caption}</caption>
        <TableHeader className={table.header}>
          <TableRow className="h-8 hover:bg-transparent">
            <TableHead className={LEVEL_HEAD}>
              {tLevels('column.role')}
            </TableHead>
            <TableHead className={cn(LEVEL_HEAD, 'w-56')}>
              {tLevels('column.access')}
            </TableHead>
            <TableHead className={cn(LEVEL_HEAD, 'w-28')}>
              {tLevels('column.total')}
            </TableHead>
            <TableHead className={cn(LEVEL_HEAD, 'w-44')}>
              <span className="sr-only">{t('pickTools')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className={table.body}>
          {superAdminShown && (
            <TableRow className={table.row}>
              <TableCell
                className={cn(table.cell, table.line, 'whitespace-normal')}
              >
                <RoleName role={superAdmin} name={nameOf(superAdmin)} />
              </TableCell>
              <TableCell className={cn(table.cell, table.line)}>
                <span className="text-data text-foreground">
                  {t('superAdmin')}
                </span>
              </TableCell>
              <TableCell className={table.cell}>
                {/* «Супер-администратор» gets what «Все» gives: every tool not switched off for everyone. */}
                <LevelTotal
                  gives={roleGives(access.tools, { level: 'all', marks: [] })}
                />
              </TableCell>
              <TableCell className={table.cell} />
            </TableRow>
          )}
          {visible.map((role) => {
            const value = draft.value(role.id);
            const name = nameOf(role);
            return (
              <TableRow key={role.id} className={table.row}>
                <TableCell
                  className={cn(table.cell, table.line, 'whitespace-normal')}
                >
                  <RoleName
                    role={role}
                    name={name}
                    changed={draft.isChanged(role.id)}
                  />
                </TableCell>
                <TableCell className={cn(table.cell, table.line)}>
                  <LevelSelect
                    label={tLevels('accessName.role', { role: name })}
                    variant="role"
                    levels={ROLE_LEVELS}
                    value={value.level}
                    onChange={(level) => draft.setLevel(role.id, level)}
                    canPick={access.tools !== null}
                    disabled={saving}
                  />
                </TableCell>
                <TableCell className={table.cell}>
                  <LevelTotal gives={roleGives(access.tools, value)} />
                </TableCell>
                <TableCell className={cn(table.cell, table.end)}>
                  {value.level === 'pick' && (
                    <ShellLink
                      href={roleToolsServerPath(role.id, server)}
                      className={cn(
                        CAPTION,
                        'inline-flex items-center text-foreground underline underline-offset-2 pointer-coarse:min-h-11',
                      )}
                    >
                      {t('pickTools')}
                    </ShellLink>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
          {rows.length === 0 && needle === '' && (
            <TableRow className={cn(table.pickerRow, 'hover:bg-transparent')}>
              <TableCell
                colSpan={4}
                className={cn(
                  table.pickerCell,
                  'px-3 py-6 whitespace-normal text-center',
                )}
              >
                <p className="text-sm leading-5 font-medium text-foreground">
                  {t('none')}
                </p>
                <p className={cn(CAPTION, 'text-muted-foreground')}>
                  {t('noneHint')}
                </p>
              </TableCell>
            </TableRow>
          )}
          {needle !== '' && visible.length === 0 && !superAdminShown && (
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
                    onClick={() => setQuery('')}
                  >
                    {tLevels('resetFilter')}
                  </Button>
                </span>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <SaveBar
        unit="roles"
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

/** Part 3 first cell of «Роли сервера»: the role's name and, under it, who it reaches. */
function RoleName({
  role,
  name,
  changed = false,
}: {
  role: AccessRole;
  name: string;
  changed?: boolean;
}) {
  const t = useTranslations('admin.servers.access');
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 text-data text-foreground [overflow-wrap:anywhere]">
          {name}
        </span>
        {changed && <ChangedDot />}
      </span>
      {role.builtinKind !== 'super_admin' && (
        <span className={cn(CAPTION, 'text-muted-foreground')}>
          {role.memberCount === null
            ? t('everyone')
            : t('members', { count: role.memberCount })}
        </span>
      )}
    </span>
  );
}

/**
 * «Дать доступ ролям»: a popover with the search and a checkbox per role that has «Нет» here; «Добавить ({n})» puts
 * them in the table at «Только чтение». With every role already shown the button is `aria-disabled` with MC-39.
 */
function GrantRoles({
  roles,
  disabled,
  onAdd,
}: {
  roles: readonly { id: string; name: string }[];
  disabled: boolean;
  onAdd: (ids: readonly string[]) => void;
}) {
  const t = useTranslations('admin.servers.access');
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const none = roles.length === 0;
  const needle = query.trim().toLocaleLowerCase();
  const shown = roles.filter((role) =>
    role.name.toLocaleLowerCase().includes(needle),
  );
  const picked = roles.filter((role) => checked.has(role.id));

  const changeOpen = (next: boolean): void => {
    if (next && (none || disabled)) return;
    setOpen(next);
    if (!next) {
      setQuery('');
      setChecked(new Set());
    }
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={changeOpen}>
      <PopoverPrimitive.Trigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(CONTROL_SIZE, 'md:ml-auto')}
            aria-disabled={none || disabled}
            aria-describedby={none ? reasonId : undefined}
          />
        }
      >
        <PlusIcon aria-hidden />
        {t('grant')}
      </PopoverPrimitive.Trigger>
      {none && (
        <span id={reasonId} className={cn(CAPTION, 'text-muted-foreground')}>
          {t('allGranted')}
        </span>
      )}
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t('search')}
          placeholder={t('search')}
          className={cn(CONTROL_SIZE, 'text-data md:text-data')}
        />
        <div className="flex max-h-64 flex-col overflow-y-auto">
          {shown.length === 0 ? (
            <p className={cn(CAPTION, 'py-2 text-muted-foreground')}>
              {t('noMatches')}
            </p>
          ) : (
            shown.map((role) => (
              <Label
                key={role.id}
                className="flex min-h-8 items-center gap-2 text-data font-normal text-foreground pointer-coarse:min-h-11"
              >
                <Checkbox
                  className={CONTROL_EDGE}
                  checked={checked.has(role.id)}
                  onCheckedChange={(on) =>
                    setChecked((current) => {
                      const next = new Set(current);
                      if (on) next.add(role.id);
                      else next.delete(role.id);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {role.name}
                </span>
              </Label>
            ))
          )}
        </div>
        <Button
          type="button"
          size="sm"
          className={cn(CONTROL_SIZE, 'self-end')}
          disabled={picked.length === 0}
          onClick={() => {
            onAdd(picked.map((role) => role.id));
            changeOpen(false);
          }}
        >
          {t('add', { count: picked.length })}
        </Button>
      </PopoverContent>
    </PopoverPrimitive.Root>
  );
}
