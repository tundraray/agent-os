'use client';

import { useId, type ReactNode } from 'react';
import { CircleCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { ThemeId } from '@agent-os/contracts';
import { THEME_IDS, isThemeId } from '@/lib/theme';
import { cn } from '@/lib/utils';

/** The card «Как в организации» of the variant «Сотрудник»: the employee's own theme is empty (theming KD-1). */
export const ORGANIZATION_CHOICE = 'organization';
export type ThemeChoice = ThemeId | typeof ORGANIZATION_CHOICE;

/**
 * One half of a card's sample: the shell in the colours of `theme`, whatever the page's theme and mode. The
 * half carries its own `data-theme` (and `dark`), so only tokens are used inside — `dark:` utilities would
 * follow the page (design-engine.md, C3).
 */
function SampleHalf({ theme, dark }: { theme: ThemeId; dark: boolean }) {
  return (
    <span
      data-theme={theme}
      className={cn('flex flex-1 bg-background', dark && 'dark')}
    >
      <span className="flex w-1/3 flex-col gap-1.5 bg-sidebar p-1.5">
        <span className="flex h-2.5 rounded-sm bg-sidebar-accent">
          <span className="w-0.5 rounded-full bg-sidebar-primary" />
        </span>
        <span className="mx-1 h-1 rounded-full bg-muted-foreground" />
      </span>
      <span className="flex flex-1 flex-col gap-1.5 p-1.5">
        <span className="h-1.5 w-3/4 rounded-full bg-foreground" />
        <span className="h-1 w-1/2 rounded-full bg-muted-foreground" />
        <span className="mt-auto flex items-center gap-1">
          <span className="h-2.5 w-5 rounded-full bg-primary" />
          <span className="size-1.5 rounded-full bg-chart-1" />
          <span className="size-1.5 rounded-full bg-chart-2" />
          <span className="size-1.5 rounded-full bg-chart-3" />
        </span>
      </span>
    </span>
  );
}

function ThemeCard({
  value,
  sample,
  name,
  caption,
  checked,
}: {
  value: ThemeChoice;
  sample: ThemeId;
  name: string;
  caption?: string;
  checked: boolean;
}) {
  const nameId = useId();
  const captionId = useId();
  return (
    <Radio.Root
      value={value}
      aria-labelledby={nameId}
      aria-describedby={caption === undefined ? undefined : captionId}
      data-shell-focus={checked ? 'theme-picker' : undefined}
      className="group/card flex flex-col gap-2 rounded-lg border border-border bg-card p-2 text-left outline-none not-data-checked:hover:border-input focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-checked:border-2 data-checked:border-primary data-checked:p-[7px] pointer-coarse:min-h-11"
    >
      <span aria-hidden className="flex h-16 overflow-hidden rounded-md">
        <SampleHalf theme={sample} dark={false} />
        <SampleHalf theme={sample} dark />
      </span>
      <span className="flex flex-col gap-0.5 rounded-md px-1 py-0.5 group-hover/card:bg-accent">
        <span className="flex items-center gap-2 text-sm leading-5 text-foreground group-data-checked/card:font-medium">
          <span id={nameId}>{name}</span>
          {checked && (
            <CircleCheckIcon
              aria-hidden
              className="ml-auto size-4 text-primary"
            />
          )}
        </span>
        {caption !== undefined && (
          <span
            id={captionId}
            className="text-xs leading-4 text-muted-foreground"
          >
            {caption}
          </span>
        )}
      </span>
    </Radio.Root>
  );
}

/**
 * Theme cards of the design system's theme-picker. Given `organizationTheme`, it is the variant «Сотрудник»: the
 * first card is «Как в организации» with the organisation's sample and caption (MC-5); without it, the variant
 * «Организация» with the built-in themes only. The owner saves each choice and passes `error` after a refusal:
 * it stands under the grid in place of `hint` as an alert.
 */
export function ThemePicker({
  labelledBy,
  checked,
  organizationTheme,
  onChoose,
  hint,
  error,
}: {
  labelledBy: string;
  checked: ThemeChoice;
  organizationTheme?: ThemeId;
  onChoose: (choice: ThemeChoice) => void;
  hint: string;
  error: ReactNode;
}) {
  const t = useTranslations('account.theme');
  const hintId = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <RadioGroup
        aria-labelledby={labelledBy}
        aria-describedby={hintId}
        value={checked}
        onValueChange={(next: unknown) => {
          if (next === ORGANIZATION_CHOICE || isThemeId(next)) onChoose(next);
        }}
        className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3"
      >
        {organizationTheme !== undefined && (
          <ThemeCard
            value={ORGANIZATION_CHOICE}
            sample={organizationTheme}
            name={t('organization')}
            caption={t('organizationNow', {
              theme: t(`names.${organizationTheme}`),
            })}
            checked={checked === ORGANIZATION_CHOICE}
          />
        )}
        {THEME_IDS.map((id) => (
          <ThemeCard
            key={id}
            value={id}
            sample={id}
            name={t(`names.${id}`)}
            checked={checked === id}
          />
        ))}
      </RadioGroup>
      {error === null ? (
        <p id={hintId} className="text-xs leading-4 text-muted-foreground">
          {hint}
        </p>
      ) : (
        <p
          id={hintId}
          role="alert"
          className="text-xs leading-4 text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}
