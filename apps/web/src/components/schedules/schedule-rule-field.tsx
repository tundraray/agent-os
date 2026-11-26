'use client';

import { useId, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { useFormatter, useTranslations } from 'next-intl';
import {
  SCHEDULE_EVERY_HOURS_MAX,
  ScheduleNextRunRequestSchema,
  SchedulesErrorCodeSchema,
  type ScheduleRule,
} from '@agent-os/contracts';
import { CAPTION } from '@/components/admin/admin-form';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useResource } from '@/hooks/use-resource';
import { formats, type Formatter } from '@/i18n/formats';
import { isApiRequestError } from '@/lib/api/api-request';
import { schedulesApi } from '@/lib/schedules/schedules-api';
import { cn } from 'cn';

/**
 * «Когда» of the schedule dialog (schedule-rule.md): the kind of rule, its parameters, the preview of the next
 * run from the server and the time zone the times are in.
 */

type RuleKind = ScheduleRule['kind'];

const KINDS: readonly RuleKind[] = ['once', 'daily', 'weekdays', 'every_hours'];

/** ISO days 1–7 by their catalogue key: the week starts on Monday. */
export const DAYS = [
  [1, 'mon'],
  [2, 'tue'],
  [3, 'wed'],
  [4, 'thu'],
  [5, 'fri'],
  [6, 'sat'],
  [7, 'sun'],
] as const;

/** The preview asks the server once typing has paused (schedule-rule.md, Accessibility). */
const PREVIEW_DELAY_MS = 400;

/** A comfortable-density control: 36 px, 44 px under a coarse pointer (foundations, Spacing & Density). */
export const COMFORT_CONTROL = 'h-9 pointer-coarse:h-11';

/**
 * The values of every kind, so switching kinds keeps what was typed (schedule-rule.md, Variants). Times are
 * `HH:MM`, the date `YYYY-MM-DD`, the hours as typed.
 */
export type RuleDraft = {
  kind: RuleKind;
  once: { date: string; time: string };
  daily: { time: string };
  weekdays: { days: readonly number[]; time: string };
  every_hours: { hours: string };
};

/** Why the rule cannot be saved; the catalogue key of its MC-3 text. */
export type RuleError = 'past' | 'noDays' | 'hours';

const pad = (value: number): string => String(value).padStart(2, '0');

const localDate = (at: Date): string =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** Defaults of schedule-rule.md: «по дням недели» Mon–Fri 09:00; «один раз» tomorrow at this hour rounded up. */
export function defaultRuleDraft(now: Date): RuleDraft {
  const once = new Date(now);
  once.setDate(once.getDate() + 1);
  if (
    once.getMinutes() > 0 ||
    once.getSeconds() > 0 ||
    once.getMilliseconds() > 0
  )
    once.setHours(once.getHours() + 1, 0, 0, 0);
  return {
    kind: 'weekdays',
    once: { date: localDate(once), time: `${pad(once.getHours())}:00` },
    daily: { time: '09:00' },
    weekdays: { days: [1, 2, 3, 4, 5], time: '09:00' },
    every_hours: { hours: '1' },
  };
}

/** A saved rule in its kind's place, the other kinds at their defaults. */
export function ruleDraftOf(rule: ScheduleRule, now: Date): RuleDraft {
  const draft = { ...defaultRuleDraft(now), kind: rule.kind };
  switch (rule.kind) {
    case 'once':
      return { ...draft, once: { date: rule.date, time: rule.time } };
    case 'daily':
      return { ...draft, daily: { time: rule.time } };
    case 'weekdays':
      return { ...draft, weekdays: { days: rule.days, time: rule.time } };
    case 'every_hours':
      return { ...draft, every_hours: { hours: String(rule.hours) } };
  }
}

/** Minutes `timeZone` is ahead of UTC at `at`. */
function offsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((item) => item.type === type)?.value);
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
  );
  return Math.round(
    (wall - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000,
  );
}

/** «+3», «−5», «+5:30», «+0» after «UTC». */
function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const hours = Math.floor(Math.abs(minutes) / 60);
  const rest = Math.abs(minutes) % 60;
  return rest === 0 ? `${sign}${hours}` : `${sign}${hours}:${pad(rest)}`;
}

/** The offset of `timeZone` now, for «{zone} (UTC{offset})». */
export const utcOffset = (timeZone: string): string =>
  offsetLabel(offsetMinutes(timeZone, new Date()));

/**
 * The rule the draft makes, or why it cannot be saved (schedule-rule.md, «Ошибка»). A `once` in the past is
 * the server's call (KD-7): see `isPastRefusal`.
 */
export function checkRule(
  draft: RuleDraft,
): { rule: ScheduleRule } | { error: RuleError } {
  switch (draft.kind) {
    case 'once':
      return { rule: { kind: 'once', ...draft.once } };
    case 'daily':
      return { rule: { kind: 'daily', time: draft.daily.time } };
    case 'weekdays': {
      const { days, time } = draft.weekdays;
      return days.length === 0
        ? { error: 'noDays' }
        : {
            rule: {
              kind: 'weekdays',
              days: [...days].sort((a, b) => a - b),
              time,
            },
          };
    }
    case 'every_hours': {
      const { hours } = draft.every_hours;
      return /^\d+$/.test(hours) &&
        Number(hours) >= 1 &&
        Number(hours) <= SCHEDULE_EVERY_HOURS_MAX
        ? { rule: { kind: 'every_hours', hours: Number(hours) } }
        : { error: 'hours' };
    }
  }
}

/** The server refused a `once` rule because its moment has passed: 400 `VALIDATION_FAILED` (KD-7). */
export const isPastRefusal = (rule: ScheduleRule, error: unknown): boolean =>
  rule.kind === 'once' &&
  isApiRequestError(error) &&
  error.status === 400 &&
  error.code === SchedulesErrorCodeSchema.enum.VALIDATION_FAILED;

/** A run's day and time as the schedule's zone reads it: «26 нояб., 09:00». */
export function formatRunTime(
  format: Formatter,
  at: string,
  timeZone: string,
): string {
  return format.dateTime(new Date(at), {
    ...formats.dateTime.dayTime,
    timeZone,
  });
}

export type ScheduleRuleFieldProps = {
  draft: RuleDraft;
  onChange: (draft: RuleDraft) => void;
  /** The browser's zone for a new schedule, the saved one's own zone for an edit. */
  timeZone: string;
  /** Shown after a save attempt; any change of the rule clears it. A preview refused as past shows `past` too. */
  error: RuleError | null;
};

export function ScheduleRuleField({
  draft,
  onChange,
  timeZone,
  error,
}: ScheduleRuleFieldProps) {
  const t = useTranslations('schedules.rule');
  const tErrors = useTranslations('schedules.errors');
  const format = useFormatter();
  const id = useId();
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;

  // The preview reads only a rule that can be saved; an unsavable one shows «—».
  const checked = checkRule(draft);
  const requestKey =
    'rule' in checked ? JSON.stringify({ rule: checked.rule, timeZone }) : '';
  const readKey = useDebouncedValue(requestKey, PREVIEW_DELAY_MS);
  const preview = useResource(
    async () => {
      if (readKey === '') return null;
      const body = ScheduleNextRunRequestSchema.parse(JSON.parse(readKey));
      try {
        return await schedulesApi.nextRun(body);
      } catch (cause) {
        // A `once` already past is an expected answer while typing, not a failed read.
        if (isPastRefusal(body.rule, cause)) return { past: true as const };
        throw cause;
      }
    },
    readKey,
    'schedules',
  );
  const past =
    preview.status === 'ready' &&
    preview.data != null &&
    'past' in preview.data;
  // While the next read is on its way the last answer stays, so the line does not blink on every keystroke.
  const readyAt =
    preview.status === 'ready' &&
    preview.data != null &&
    'nextRunAt' in preview.data
      ? preview.data.nextRunAt
      : null;
  const [shownAt, setShownAt] = useState<string | null>(null);
  if (readyAt !== null && readyAt !== shownAt) setShownAt(readyAt);
  const noPreview =
    requestKey === '' || preview.status === 'error' || past || shownAt === null;
  // The preview's refusal of the rule on screen says a `once` has passed before any save.
  const shownError: RuleError | null =
    error ?? (readKey === requestKey && past ? 'past' : null);
  const invalid = (rule: RuleError): boolean => shownError === rule;
  const describedBy = (rule: RuleError): string | undefined =>
    invalid(rule) ? errorId : undefined;

  const set = (next: Partial<RuleDraft>): void =>
    onChange({ ...draft, ...next });
  /** An emptied time or date keeps the last value: the rule always has one. */
  const keep = (value: string, apply: (value: string) => void): void => {
    if (value !== '') apply(value);
  };
  const toggleDay = (day: number): void => {
    const { days } = draft.weekdays;
    set({
      weekdays: {
        ...draft.weekdays,
        days: days.includes(day)
          ? days.filter((item) => item !== day)
          : [...days, day],
      },
    });
  };

  const timeInput = (value: string, apply: (time: string) => void) => (
    <span className="flex items-center gap-2">
      <span aria-hidden className="text-sm text-muted-foreground">
        {t('at')}
      </span>
      <label htmlFor={`${id}-time`} className="sr-only">
        {t('time')}
      </label>
      <Input
        id={`${id}-time`}
        type="time"
        className={cn(COMFORT_CONTROL, 'w-28 text-sm md:text-sm')}
        value={value}
        onChange={(event) => keep(event.target.value, apply)}
      />
    </span>
  );

  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-sm font-medium text-foreground">
        {t('label')}
      </span>
      <RadioGroup
        aria-labelledby={labelId}
        value={draft.kind}
        onValueChange={(next) => {
          const kind = KINDS.find((item) => item === next);
          if (kind !== undefined) set({ kind });
        }}
        className="grid grid-cols-2 gap-1 sm:flex sm:flex-wrap"
      >
        {KINDS.map((kind) => (
          <Radio.Root
            key={kind}
            value={kind}
            className={cn(
              COMFORT_CONTROL,
              'inline-flex items-center justify-center rounded-md border border-border px-3 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring data-checked:bg-secondary data-checked:font-medium data-checked:text-foreground',
            )}
          >
            {t(`kind.${kind}`)}
          </Radio.Root>
        ))}
      </RadioGroup>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        {draft.kind === 'once' && (
          <>
            <span className="flex flex-col gap-1">
              <label
                htmlFor={`${id}-date`}
                className={cn(CAPTION, 'text-muted-foreground')}
              >
                {t('date')}
              </label>
              <Input
                id={`${id}-date`}
                type="date"
                className={cn(COMFORT_CONTROL, 'w-40 text-sm md:text-sm')}
                value={draft.once.date}
                aria-invalid={invalid('past')}
                aria-describedby={describedBy('past')}
                onChange={(event) =>
                  keep(event.target.value, (date) =>
                    set({ once: { ...draft.once, date } }),
                  )
                }
              />
            </span>
            <span className="flex flex-col gap-1">
              <label
                htmlFor={`${id}-once-time`}
                className={cn(CAPTION, 'text-muted-foreground')}
              >
                {t('time')}
              </label>
              <Input
                id={`${id}-once-time`}
                type="time"
                className={cn(COMFORT_CONTROL, 'w-28 text-sm md:text-sm')}
                value={draft.once.time}
                aria-invalid={invalid('past')}
                aria-describedby={describedBy('past')}
                onChange={(event) =>
                  keep(event.target.value, (time) =>
                    set({ once: { ...draft.once, time } }),
                  )
                }
              />
            </span>
          </>
        )}
        {draft.kind === 'daily' &&
          timeInput(draft.daily.time, (time) => set({ daily: { time } }))}
        {draft.kind === 'weekdays' && (
          <>
            <div
              role="group"
              aria-label={t('days')}
              aria-describedby={describedBy('noDays')}
              className="flex flex-wrap gap-1"
            >
              {DAYS.map(([day, key]) => {
                const pressed = draft.weekdays.days.includes(day);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={pressed}
                    aria-label={t(`dayLong.${key}`)}
                    aria-invalid={
                      day === 1 && invalid('noDays') ? true : undefined
                    }
                    onClick={() => toggleDay(day)}
                    className={cn(
                      COMFORT_CONTROL,
                      'w-10 rounded-md border text-sm outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring',
                      invalid('noDays')
                        ? 'border-destructive'
                        : 'border-border',
                      pressed
                        ? 'bg-secondary font-medium text-foreground'
                        : 'text-muted-foreground',
                    )}
                  >
                    {t(`dayShort.${key}`)}
                  </button>
                );
              })}
            </div>
            {timeInput(draft.weekdays.time, (time) =>
              set({ weekdays: { ...draft.weekdays, time } }),
            )}
          </>
        )}
        {draft.kind === 'every_hours' && (
          <span className="flex flex-col gap-1">
            <label
              htmlFor={`${id}-hours`}
              className={cn(CAPTION, 'text-muted-foreground')}
            >
              {t('hours')}
            </label>
            <Input
              id={`${id}-hours`}
              inputMode="numeric"
              autoComplete="off"
              className={cn(COMFORT_CONTROL, 'w-20 text-sm md:text-sm')}
              value={draft.every_hours.hours}
              aria-invalid={invalid('hours')}
              aria-describedby={describedBy('hours')}
              onChange={(event) =>
                set({ every_hours: { hours: event.target.value.trim() } })
              }
            />
          </span>
        )}
      </div>

      {shownError !== null && (
        <p id={errorId} className={cn(CAPTION, 'text-destructive')}>
          {tErrors(shownError, { max: SCHEDULE_EVERY_HOURS_MAX })}
        </p>
      )}
      <p role="status" className={cn(CAPTION, 'text-foreground')}>
        {noPreview
          ? t('noNext')
          : t('next', { at: formatRunTime(format, shownAt, timeZone) })}
      </p>
      <p className={cn(CAPTION, 'text-muted-foreground')}>
        {t('zone', {
          zone: timeZone,
          offset: utcOffset(timeZone),
        })}
      </p>
    </div>
  );
}
