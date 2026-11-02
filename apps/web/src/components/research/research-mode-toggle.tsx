'use client';

import { TelescopeIcon } from 'lucide-react';
import { Toggle } from '@/components/ui/toggle';

/** Composer copy while the deep research mode is on (deep-research UXRD, MC-2, MC-3). */
export const RESEARCH_MODE_COMPOSER_COPY = {
  placeholder: 'Опишите, что нужно исследовать…',
  sendLabel: 'Запустить ресерч',
} as const;

export type ResearchModeToggleProps = {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
};

/**
 * DR-01: the deep research mode for one message (UXRD KD-1). The pressed state is the composer's, so the composer can
 * turn it off after a send; the toggle only reports presses and keeps focus where the user pressed it.
 */
export function ResearchModeToggle({ pressed, onPressedChange }: ResearchModeToggleProps) {
  return (
    <Toggle
      variant="outline"
      size="sm"
      pressed={pressed}
      onPressedChange={(next) => onPressedChange(next)}
      className="aria-pressed:border-primary aria-pressed:text-primary aria-pressed:bg-transparent aria-pressed:font-medium pointer-coarse:h-11 pointer-coarse:min-w-11"
    >
      <TelescopeIcon aria-hidden />
      Глубокий ресерч
    </Toggle>
  );
}
