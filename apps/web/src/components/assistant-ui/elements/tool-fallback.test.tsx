import { useState, type ComponentProps, type ReactNode } from 'react';
import { EDIT_RECORD_TOOL } from '@agent-os/contracts';
import { render, screen, within } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolFallback } from '@/components/assistant-ui/elements/tool-fallback.aui';
import { ShellServicesContext } from '@/components/shell/shell-actions';
import type { ToolCallArtifact } from '@/lib/feed/to-feed';
import { createShellServices } from '@/lib/threads/shell-services';

/** A record tool's block reads the library list from the shell's services. */
function ShellServices({ children }: { children: ReactNode }) {
  const [services] = useState(() => createShellServices());
  return (
    <ShellServicesContext.Provider value={services}>
      {children}
    </ShellServicesContext.Provider>
  );
}

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

  // UC-3, IM-03 (server AC-03.2): a schedule's run refused a change no one could confirm — MC-2, never the
  // general refusal and never a record tool's «Не сохранено:».
  it.each([
    { toolName: 'send_email', server: 'gmail' },
    { toolName: EDIT_RECORD_TOOL, server: null },
  ])(
    'an unattended refusal of $toolName shows the MC-2 line',
    ({ toolName, server }) => {
      const props: ComponentProps<typeof ToolFallback> = {
        type: 'tool-call',
        toolCallId: 'c2',
        toolName,
        args: {},
        argsText: '{}',
        result: 'The schedule may not change this without a confirmation.',
        isError: true,
        artifact: {
          ...AUTH_REQUIRED,
          outcome: 'refused',
          server,
          refusalReason: 'unattended',
        },
        status: { type: 'complete' },
        addResult: vi.fn(),
        resume: vi.fn(),
        respondToApproval: vi.fn<() => Promise<void>>(),
      };
      render(<ToolFallback {...props} />, { wrapper: ShellServices });

      expect(
        screen.getByText(
          'Расписанию это не разрешено — подтвердить было некому',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Не сохранено:/)).toBeNull();
      expect(screen.queryByText('Платформа отказала в вызове')).toBeNull();
    },
  );
});
