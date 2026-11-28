'use client';

import { ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { McpServerStatus, UserLevel } from '@agent-os/contracts';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_EDGE, CONTROL_SIZE } from '../admin-form';
import { ServerStatusBadge } from '../servers/server-list';

type LevelSelectProps<L extends UserLevel> = {
  /** «Доступ: {сервер}», «Доступ роли {роль}» or «Личный доступ: {сервер}» (access-level-editor, Accessibility). */
  label: string;
  /** `personal` — an employee's own level, with «Запрещено» and its phrases (UXRD MC-37). */
  variant: 'role' | 'personal';
  levels: readonly L[];
  value: L;
  onChange: (level: L) => void;
  /** `false` — the server has not given its tool list: «Выборочно» is unavailable with the reason. */
  canPick: boolean;
  disabled: boolean;
};

/**
 * Part 3 of access-level-editor: the level choice, as wide as its cell (200 px in the table, the line when stacked, at
 * most 384 px so it never stretches across the page); every item is the level and the phrase of what it gives. The list opens under the choice and is wide
 * enough for a phrase on one or two lines, within the screen.
 */
export function LevelSelect<L extends UserLevel>({
  label,
  variant,
  levels,
  value,
  onChange,
  canPick,
  disabled,
}: LevelSelectProps<L>) {
  const t = useTranslations('admin.levels');
  const text = (level: UserLevel) => {
    // A role has no «Запрещено»; its phrases are the personal ones only for an employee.
    const key =
      variant === 'role' && level !== 'denied'
        ? (`role.${level}` as const)
        : (`personal.${level}` as const);
    return {
      label: t(`${key}.label`),
      hint:
        level === 'pick' && !canPick ? t('pickUnavailable') : t(`${key}.hint`),
    };
  };
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const level = levels.find((candidate) => candidate === next);
        if (level !== undefined) onChange(level);
      }}
      items={levels.map((level) => ({
        value: level,
        label: text(level).label,
      }))}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        className={cn(CONTROL_SIZE, 'w-full max-w-sm text-data')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        align="start"
        className="w-80 min-w-(--anchor-width) max-w-[calc(100vw-2rem)]"
      >
        {levels.map((level) => {
          const { label: name, hint } = text(level);
          return (
            <SelectItem
              key={level}
              value={level}
              disabled={level === 'pick' && !canPick}
              className="pointer-coarse:min-h-11"
            >
              <span className="flex flex-col whitespace-normal">
                <span className="text-data">{name}</span>
                <span className={cn(CAPTION, 'text-muted-foreground')}>
                  {hint}
                </span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/** Part 3: «{n} из {N}» in tabular digits; a level that gives nothing reads «—». */
export function LevelTotal({
  gives,
}: {
  gives: { n: number; total: number } | null;
}) {
  const t = useTranslations('admin.levels');
  return (
    <span className="text-data tabular-nums">
      {gives === null ? t('nothing') : t('total', gives)}
    </span>
  );
}

/** Part 4: the 6 px dot after the name of a changed row, like a changed field of record-editor. */
export function ChangedDot() {
  return (
    <span
      aria-hidden
      className="inline-block size-1.5 shrink-0 rounded-full bg-muted-foreground"
    />
  );
}

/** Part 3 first cell and part 10: the server's name in Mono, the changed dot and its badge while it does not work. */
export function ServerName({
  name,
  status,
  changed = false,
}: {
  name: string;
  status: McpServerStatus;
  changed?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-mono-compact" title={name}>
          {name}
        </span>
        {changed && <ChangedDot />}
      </span>
      {status !== 'enabled' && <ServerStatusBadge status={status} />}
    </span>
  );
}

export type LevelFilter = 'all' | 'granted';

/** Part 1: «Все» / «С доступом». */
export function FilterRadios({
  value,
  onChange,
  disabled,
}: {
  value: LevelFilter;
  onChange: (filter: LevelFilter) => void;
  disabled: boolean;
}) {
  const t = useTranslations('admin.levels.filter');
  return (
    <RadioGroup
      aria-label={t('label')}
      value={value}
      onValueChange={(next) => {
        if (next === 'all' || next === 'granted') onChange(next);
      }}
      className="flex items-center gap-4"
    >
      {(['all', 'granted'] as const).map((option) => (
        <Label
          key={option}
          className="flex items-center gap-2 text-data font-normal text-foreground pointer-coarse:min-h-11"
        >
          <RadioGroupItem
            value={option}
            disabled={disabled}
            className={CONTROL_EDGE}
          />
          {t(option)}
        </Label>
      ))}
    </RadioGroup>
  );
}

/** Part 5: «Инструменты» with a 14 px chevron, only on a row with «Выборочно». */
export function ToolsToggle({
  server,
  expanded,
  controls,
  onToggle,
}: {
  server: string;
  expanded: boolean;
  /** The id of the expanded part. */
  controls: string;
  onToggle: () => void;
}) {
  const t = useTranslations('admin.levels');
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={CONTROL_SIZE}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={t('toolsOf', { server })}
      onClick={onToggle}
    >
      {t('tools')}
      <ChevronDownIcon
        aria-hidden
        className={cn(
          'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
          expanded && 'rotate-180',
        )}
      />
    </Button>
  );
}
