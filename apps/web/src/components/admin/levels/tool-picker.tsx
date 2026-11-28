'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type {
  GrantEffect,
  LevelTool,
  ToolCoverageState,
  ToolMark,
} from '@agent-os/contracts';
import { StateBadge, type StateBadgeState } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_EDGE, CONTROL_SIZE } from '../admin-form';

export type ToolGroup = 'changes' | 'reads';

const GROUPS: readonly ToolGroup[] = ['changes', 'reads'];

/** Which groups are open; the tab keeps it while the page is open, so a group stays as it was left. */
export type OpenGroups = Readonly<Record<ToolGroup, boolean>>;

/** «Меняют» open, «Читают» closed when a row is expanded for the first time (UXRD KD-9). */
export const FIRST_OPEN_GROUPS: OpenGroups = { changes: true, reads: false };

const groupOf = (tool: LevelTool): ToolGroup =>
  tool.readOnly ? 'reads' : 'changes';

const titleOf = (tool: LevelTool): string => tool.title ?? tool.name;

/** By the title and the technical name, case-insensitive (access-level-editor, part 6). */
const matches = (tool: LevelTool, query: string): boolean => {
  const needle = query.trim().toLocaleLowerCase();
  return (
    needle === '' ||
    titleOf(tool).toLocaleLowerCase().includes(needle) ||
    tool.name.toLocaleLowerCase().includes(needle)
  );
};

/** The marks the saved and the current state name that the server's list no longer holds (part 9). */
const orphansOf = (
  tools: readonly LevelTool[],
  names: readonly string[],
): string[] => {
  const listed = new Set(tools.map((tool) => tool.name));
  return [...new Set(names)].filter((name) => !listed.has(name));
};

type GroupView = {
  group: ToolGroup;
  inGroup: readonly LevelTool[];
  /** The group's tools the search shows. */
  shown: readonly LevelTool[];
  open: boolean;
};

/** The non-empty groups; a closed group with matches opens by itself while the search holds. */
const groupViews = (
  tools: readonly LevelTool[],
  query: string,
  openGroups: OpenGroups,
): GroupView[] =>
  GROUPS.flatMap((group) => {
    const inGroup = tools.filter((tool) => groupOf(tool) === group);
    if (inGroup.length === 0) return [];
    const shown = inGroup.filter((tool) => matches(tool, query));
    const open = openGroups[group] || (query.trim() !== '' && shown.length > 0);
    return [{ group, inGroup, shown, open }];
  });

type FrameProps = {
  id: string;
  query: string;
  onQueryChange: (query: string) => void;
  disabled: boolean;
  children: ReactNode;
};

/** Parts 5–6: the bordered block under the row and the tool search over its groups. */
function PickerFrame({
  id,
  query,
  onQueryChange,
  disabled,
  children,
}: FrameProps) {
  const t = useTranslations('admin.levels');
  return (
    <div
      id={id}
      className="ml-6 flex min-w-0 flex-col gap-2 rounded-md border border-border p-3 max-md:ml-0"
    >
      <Input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query !== '') {
            event.stopPropagation();
            onQueryChange('');
          }
        }}
        placeholder={t('searchTool')}
        aria-label={t('searchTool')}
        disabled={disabled}
        className={cn(CONTROL_SIZE, 'text-data md:max-w-80')}
      />
      {children}
    </div>
  );
}

/** A search no tool matches: one line instead of the empty groups (UXRD MC-36). */
function NoTools({ onReset }: { onReset: () => void }) {
  const t = useTranslations('admin.levels');
  return (
    <p className="flex flex-wrap items-center gap-2 text-data text-muted-foreground">
      {t('noTools')}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={CONTROL_SIZE}
        onClick={onReset}
      >
        {t('resetSearch')}
      </Button>
    </p>
  );
}

/** `true` while a search is typed and no tool of any group matches it. */
const nothingFound = (views: readonly GroupView[], query: string): boolean =>
  query.trim() !== '' && views.every((view) => view.shown.length === 0);

type ToolPickerProps = {
  server: string;
  /** The id `ToolsToggle` points at. */
  id: string;
  tools: readonly LevelTool[];
  picked: readonly string[];
  /** The saved marks: an orphan unchecked before the save can be checked back. */
  savedPicked: readonly string[];
  onPickedChange: (picked: readonly string[]) => void;
  openGroups: OpenGroups;
  onOpenGroupsChange: (open: OpenGroups) => void;
  disabled: boolean;
};

/**
 * Parts 6–9 of access-level-editor, variant «Серверы роли» (UXRD LV-02): the search, the groups «Меняют» and
 * «Читают» with a three-state checkbox, the tools with their badges and the orphans under «Нет на сервере».
 */
export function ToolPicker({
  server,
  id,
  tools,
  picked,
  savedPicked,
  onPickedChange,
  openGroups,
  onOpenGroupsChange,
  disabled,
}: ToolPickerProps) {
  const t = useTranslations('admin.levels');
  const [query, setQuery] = useState('');
  const pickedSet = new Set(picked);
  const orphans = orphansOf(tools, [...savedPicked, ...picked]);
  const views = groupViews(tools, query, openGroups);

  const toggle = (names: readonly string[], on: boolean): void => {
    const next = new Set(picked);
    for (const name of names) {
      if (on) next.add(name);
      else next.delete(name);
    }
    onPickedChange([...next]);
  };

  const checkbox = (title: string | null, name: string): ReactNode => (
    <Checkbox
      checked={pickedSet.has(name)}
      onCheckedChange={(on) => toggle([name], on)}
      aria-label={t('toolName', { title: title ?? name, name })}
      aria-describedby={badgesIdOf(id, name)}
      disabled={disabled}
      className={CONTROL_EDGE}
    />
  );

  return (
    <PickerFrame
      id={id}
      query={query}
      onQueryChange={setQuery}
      disabled={disabled}
    >
      {nothingFound(views, query) && <NoTools onReset={() => setQuery('')} />}
      {!nothingFound(views, query) &&
        views.map(({ group, inGroup, shown, open }) => {
          const shownPicked = shown.filter((tool) =>
            pickedSet.has(tool.name),
          ).length;
          const all = shown.length > 0 && shownPicked === shown.length;
          return (
            <ToolGroupBlock
              key={group}
              server={server}
              group={group}
              open={open}
              onOpenChange={(next) =>
                onOpenGroupsChange({ ...openGroups, [group]: next })
              }
              head={
                <Checkbox
                  checked={all}
                  indeterminate={shownPicked > 0 && !all}
                  onCheckedChange={() =>
                    toggle(
                      shown.map((tool) => tool.name),
                      !all,
                    )
                  }
                  aria-label={t(
                    group === 'changes' ? 'group.allChanges' : 'group.allReads',
                    { server },
                  )}
                  disabled={disabled || shown.length === 0}
                  className={CONTROL_EDGE}
                />
              }
              summary={t('group.picked', {
                k: inGroup.filter((tool) => pickedSet.has(tool.name)).length,
                m: inGroup.length,
              })}
            >
              {shown.map((tool) => (
                <ToolLine
                  key={tool.name}
                  title={titleOf(tool)}
                  name={tool.name}
                  badgesId={badgesIdOf(id, tool.name)}
                  muted={!tool.enabled}
                  start={checkbox(titleOf(tool), tool.name)}
                  badges={
                    <>
                      {tool.isNew && (
                        <StateBadge variant="source">{t('isNew')}</StateBadge>
                      )}
                      {!tool.enabled && (
                        <StateBadge state="off">{t('disabled')}</StateBadge>
                      )}
                    </>
                  }
                />
              ))}
            </ToolGroupBlock>
          );
        })}
      {orphans.length > 0 && (
        <Orphans>
          {orphans.map((name) => (
            <ToolLine
              key={name}
              title={null}
              name={name}
              badgesId={badgesIdOf(id, name)}
              start={checkbox(null, name)}
              badges={<StateBadge state="off">{t('orphan')}</StateBadge>}
            />
          ))}
        </Orphans>
      )}
    </PickerFrame>
  );
}

/** What the coverage rule gives one tool for the employee, and the text of what gives it. */
export type ToolAccess = { state: ToolCoverageState; from: string | null };

/** The badge of each effective-access state (access-level-editor, «Метки действующего доступа»). */
const ACCESS_BADGE: Record<ToolCoverageState, StateBadgeState> = {
  available: 'ok',
  none: 'off',
  denied: 'closed',
  disabled: 'off',
};

type PersonalChoice = 'unset' | GrantEffect;
const CHOICES: readonly PersonalChoice[] = ['unset', 'allow', 'deny'];

type PersonalToolPickerProps = {
  server: string;
  id: string;
  tools: readonly LevelTool[];
  /** What each tool gives the employee with the level on screen. */
  accessOf: (tool: LevelTool) => ToolAccess;
  /** The personal marks while the personal level is «Выборочно»; `null` — no personal choice. */
  marks: readonly ToolMark[] | null;
  /** The saved marks: an orphan changed before the save can be set back. */
  savedMarks: readonly ToolMark[];
  onMarksChange: (marks: readonly ToolMark[]) => void;
  openGroups: OpenGroups;
  onOpenGroupsChange: (open: OpenGroups) => void;
  disabled: boolean;
};

/**
 * Parts 6–9 of access-level-editor, variant «Серверы сотрудника» (UXRD EA-01): every tool with its effective
 * access badge and source; under a personal «Выборочно» also the choice «—» / «Разрешён» / «Запрещён». No group
 * checkbox.
 */
export function PersonalToolPicker({
  server,
  id,
  tools,
  accessOf,
  marks,
  savedMarks,
  onMarksChange,
  openGroups,
  onOpenGroupsChange,
  disabled,
}: PersonalToolPickerProps) {
  const t = useTranslations('admin.levels');
  const [query, setQuery] = useState('');
  const orphans =
    marks === null
      ? []
      : orphansOf(
          tools,
          [...savedMarks, ...marks].map((mark) => mark.tool),
        );
  const views = groupViews(tools, query, openGroups);

  const choose = (tool: string, choice: PersonalChoice): void => {
    const others = (marks ?? []).filter((mark) => mark.tool !== tool);
    onMarksChange(
      choice === 'unset' ? others : [...others, { tool, effect: choice }],
    );
  };

  const choice = (title: string, name: string): ReactNode => {
    if (marks === null) return undefined;
    const value: PersonalChoice =
      marks.find((mark) => mark.tool === name)?.effect ?? 'unset';
    return (
      <Select
        value={value}
        onValueChange={(next) => {
          const picked = CHOICES.find((candidate) => candidate === next);
          if (picked !== undefined) choose(name, picked);
        }}
        items={CHOICES.map((option) => ({
          value: option,
          label: t(`choice.${option}`),
        }))}
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          aria-label={t('choiceName', { title })}
          aria-describedby={badgesIdOf(id, name)}
          className={cn(CONTROL_SIZE, 'w-35 text-data')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CHOICES.map((option) => (
            <SelectItem
              key={option}
              value={option}
              className="pointer-coarse:min-h-11"
            >
              {t(`choice.${option}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };

  return (
    <PickerFrame
      id={id}
      query={query}
      onQueryChange={setQuery}
      disabled={disabled}
    >
      {nothingFound(views, query) && <NoTools onReset={() => setQuery('')} />}
      {!nothingFound(views, query) &&
        views.map(({ group, inGroup, shown, open }) => (
          <ToolGroupBlock
            key={group}
            server={server}
            group={group}
            open={open}
            onOpenChange={(next) =>
              onOpenGroupsChange({ ...openGroups, [group]: next })
            }
            summary={t('group.available', {
              k: inGroup.filter((tool) => accessOf(tool).state === 'available')
                .length,
              m: inGroup.length,
            })}
          >
            {shown.map((tool) => {
              const { state, from } = accessOf(tool);
              return (
                <ToolLine
                  key={tool.name}
                  title={titleOf(tool)}
                  name={tool.name}
                  badgesId={badgesIdOf(id, tool.name)}
                  muted={!tool.enabled}
                  end={choice(titleOf(tool), tool.name)}
                  badges={
                    <>
                      {tool.isNew && (
                        <StateBadge variant="source">{t('isNew')}</StateBadge>
                      )}
                      <StateBadge state={ACCESS_BADGE[state]}>
                        {state === 'disabled'
                          ? t('disabled')
                          : t(`coverage.${state}`)}
                      </StateBadge>
                      {state === 'available' && from !== null && (
                        <span
                          className={cn(
                            CAPTION,
                            'min-w-0 text-muted-foreground [overflow-wrap:anywhere]',
                          )}
                        >
                          {from}
                        </span>
                      )}
                    </>
                  }
                />
              );
            })}
          </ToolGroupBlock>
        ))}
      {orphans.length > 0 && (
        <Orphans>
          {orphans.map((name) => (
            <ToolLine
              key={name}
              title={null}
              name={name}
              badgesId={badgesIdOf(id, name)}
              end={choice(name, name)}
              badges={<StateBadge state="off">{t('orphan')}</StateBadge>}
            />
          ))}
        </Orphans>
      )}
    </PickerFrame>
  );
}

/** Part 9: the orphans under their Caption. */
function Orphans({ children }: { children: ReactNode }) {
  const t = useTranslations('admin.levels');
  return (
    <div className="flex flex-col">
      <p className={cn(CAPTION, 'py-1 text-muted-foreground')}>{t('orphan')}</p>
      {children}
    </div>
  );
}

type ToolGroupBlockProps = {
  server: string;
  group: ToolGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The group's checkbox, in the variant that has one. */
  head?: ReactNode;
  /** «отмечено {k} из {m}» or «доступно {k} из {m}». */
  summary: string;
  children: ReactNode;
};

/** Part 7: the chevron, the group's checkbox when the variant has it, the name and its count. */
function ToolGroupBlock({
  server,
  group,
  open,
  onOpenChange,
  head,
  summary,
  children,
}: ToolGroupBlockProps) {
  const t = useTranslations('admin.levels');
  const listId = useId();
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-h-8 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 pointer-coarse:size-11"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={t(
            group === 'changes' ? 'group.toggleChanges' : 'group.toggleReads',
            { server },
          )}
          onClick={() => onOpenChange(!open)}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
        </Button>
        {head}
        <span className="text-data font-medium">{t(`group.${group}`)}</span>
        <span className={cn(CAPTION, 'text-muted-foreground')}>{summary}</span>
      </div>
      {open && (
        <div id={listId} className="flex min-w-0 flex-col pl-9">
          {children}
        </div>
      )}
    </div>
  );
}

/** The id of a tool's badges, which describe its control; unique per picker, whose `id` is unique on the page. */
const badgesIdOf = (pickerId: string, tool: string): string =>
  `${pickerId}-badges-${tool}`;

type ToolLineProps = {
  /** `null` for an orphan: only its technical name is known. */
  title: string | null;
  name: string;
  muted?: boolean;
  /** The id of the badges, the description of the line's control. */
  badgesId: string;
  /** The role's checkbox, before the title. */
  start?: ReactNode;
  /** The employee's personal choice, after the badges. */
  end?: ReactNode;
  badges: ReactNode;
};

/**
 * Part 8: a 32 px line — the control, then a column with the title, the technical name (Mono, one ellipsis at its end)
 * and the badges, then the personal choice. The controls stay on the first line at the two edges; only the text column
 * wraps, so a long title never drops under its checkbox and the choice never moves to the start of a new line.
 */
function ToolLine({
  title,
  name,
  muted = false,
  badgesId,
  start,
  end,
  badges,
}: ToolLineProps) {
  return (
    <div className="flex min-w-0 items-start gap-x-2 max-md:py-1">
      {start !== undefined && (
        <span className="flex min-h-8 shrink-0 items-center">{start}</span>
      )}
      <span className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        {title !== null && (
          <span
            className={cn(
              // A long title without spaces wraps instead of widening the editor.
              'min-w-0 text-data [overflow-wrap:anywhere]',
              muted ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {title}
          </span>
        )}
        <span
          className="max-w-full min-w-0 truncate font-mono text-mono-compact text-muted-foreground max-md:basis-full"
          title={name}
        >
          {name}
        </span>
        <span
          id={badgesId}
          className="ml-auto flex min-w-0 flex-wrap items-center gap-2"
        >
          {badges}
        </span>
      </span>
      {end !== undefined && (
        <span className="flex min-h-8 shrink-0 items-center">{end}</span>
      )}
    </div>
  );
}
