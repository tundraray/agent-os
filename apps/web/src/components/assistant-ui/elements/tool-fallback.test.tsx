import type { ComponentProps } from 'react';
import { render, screen, within } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolFallback } from '@/components/assistant-ui/elements/tool-fallback.aui';
import type { ToolCallArtifact } from '@/lib/feed/to-feed';

// The block reads only the message time from the assistant-ui store; nothing else of the runtime is needed.
vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return {
    ...actual,
    useAuiState: <T,>(
      select: (state: { message: { createdAt: Date } }) => T,
    ): T =>
      select({ message: { createdAt: new Date('2026-11-16T10:00:00.000Z') } }),
  };
});

const AUTH_REQUIRED: ToolCallArtifact = {
  state: 'done',
  outcome: 'auth_required',
  server: 'backoffice',
  refusalReason: null,
  output: null,
  startedAt: '2026-11-16T10:00:00.000Z',
  finishedAt: '2026-11-16T10:00:01.000Z',
};

describe('ToolFallback', () => {
  // AC-14.5 (web), UXRD RF-01 «Токен не обновился», MC-10.
  it('an auth_required call shows «нужен вход в аккаунт», the MC-10 line with a link to /account and no result block', async () => {
    const user = userEvent.setup();
    const props: ComponentProps<typeof ToolFallback> = {
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'search_issues',
      args: { query: '5xx' },
      argsText: '{"query":"5xx"}',
      result: 'Unauthorized',
      isError: true,
      artifact: AUTH_REQUIRED,
      status: { type: 'complete' },
      addResult: vi.fn(),
      resume: vi.fn(),
      respondToApproval: vi.fn<() => Promise<void>>(),
    };
    render(<ToolFallback {...props} />);

    const trigger = screen.getByRole('button', {
      name: /^search_issues: нужен вход в аккаунт/,
    });
    // The line is visible while the block is still collapsed.
    const line = screen.getByText(
      (_, element) =>
        element?.tagName === 'P' &&
        element.textContent ===
          'Подключите аккаунт backoffice в разделе «Мой доступ»',
    );
    expect(
      within(line).getByRole('link', { name: 'Мой доступ' }),
    ).toHaveAttribute('href', '/account');

    await user.click(trigger);
    expect(
      screen.getByRole('region', { name: 'Аргументы' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Результат' })).toBeNull();
  });
});
