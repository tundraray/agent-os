import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ResearchModeToggle } from './research-mode-toggle';

function ControlledToggle({ initial }: { initial: boolean }) {
  const [pressed, setPressed] = useState(initial);
  return <ResearchModeToggle pressed={pressed} onPressedChange={setPressed} />;
}

// NFR-05 (aria half), UXRD Accessibility: `aria-pressed` tells whether the mode is on; focus stays on the toggle (DR-01 focus row).
describe('ResearchModeToggle — DR-01 (NFR-05, UXRD Accessibility)', () => {
  it.each([
    { input: 'click', initial: false, expected: 'true' },
    { input: 'click', initial: true, expected: 'false' },
    { input: 'Enter', initial: false, expected: 'true' },
    { input: 'Space', initial: false, expected: 'true' },
    { input: 'Space', initial: true, expected: 'false' },
  ] as const)('$input from aria-pressed=$initial gives aria-pressed=$expected and keeps focus', async ({ input, initial, expected }) => {
    const user = userEvent.setup();
    render(<ControlledToggle initial={initial} />);
    const toggle = screen.getByRole('button', { name: 'Глубокий ресерч' });
    expect(toggle).toHaveAttribute('aria-pressed', String(initial));

    if (input === 'click') {
      await user.click(toggle);
    } else {
      toggle.focus();
      await user.keyboard(input === 'Enter' ? '{Enter}' : ' ');
    }

    expect(toggle).toHaveAttribute('aria-pressed', expected);
    expect(toggle).toHaveFocus();
  });
});
