'use client';

import { useId } from 'react';
import { CircleCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { useShellServices } from '@/components/shell/shell-actions';
import { THEME_SECTION_ID } from '@/lib/shell-route';
import { THEME_IDS, chooseTheme, isThemeId, type ThemeId } from '@/lib/theme';
import { useCurrentTheme } from '@/lib/use-current-theme';
import { cn } from '@/lib/utils';

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

/**
 * TP-01 of the theming UXRD, the variant «Сотрудник» without the organisation's card (theme-picker): each card
 * shows its theme in light and dark; a click, an arrow or Space applies the theme to the whole page at once and
 * keeps it in this browser. The checked card follows the attribute on `<html>`; it is the target of the menu's
 * «Тема: …» (KD-5).
 */
export function ThemeSection() {
  const t = useTranslations('account.theme');
  const { announcer } = useShellServices();
  const headingId = useId();
  const hintId = useId();
  const current = useCurrentTheme();

  return (
    <section
      id={THEME_SECTION_ID}
      aria-labelledby={headingId}
      className="flex max-w-160 flex-col gap-4"
    >
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {t('heading')}
      </h2>
      <div className="flex flex-col gap-1.5">
        <RadioGroup
          aria-labelledby={headingId}
          aria-describedby={hintId}
          value={current}
          onValueChange={(next: unknown) => {
            if (!isThemeId(next)) return;
            chooseTheme(next);
            announcer.getState().announce('account.theme.announced', {
              theme: t(`names.${next}`),
            });
          }}
          className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3"
        >
          {THEME_IDS.map((id) => (
            <Radio.Root
              key={id}
              value={id}
              data-shell-focus={id === current ? 'theme-picker' : undefined}
              className="group/card flex flex-col gap-2 rounded-lg border border-border bg-card p-2 text-left outline-none not-data-checked:hover:border-input focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-checked:border-2 data-checked:border-primary data-checked:p-[7px]"
            >
              <span
                aria-hidden
                className="flex h-16 overflow-hidden rounded-md"
              >
                <SampleHalf theme={id} dark={false} />
                <SampleHalf theme={id} dark />
              </span>
              <span className="flex items-center gap-2 rounded-md px-1 py-0.5 text-sm leading-5 text-foreground group-hover/card:bg-accent group-data-checked/card:font-medium">
                {t(`names.${id}`)}
                {id === current && (
                  <CircleCheckIcon
                    aria-hidden
                    className="ml-auto size-4 text-primary"
                  />
                )}
              </span>
            </Radio.Root>
          ))}
        </RadioGroup>
        <p id={hintId} className="text-xs leading-4 text-muted-foreground">
          {t('hint')}
        </p>
      </div>
    </section>
  );
}
