import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar, SidebarProvider } from '@/components/ui/sidebar';
import { setTestMedia } from '@/test/setup';
import { SIDEBAR_ID } from './app-sidebar';
import { ChatHeaderView, type HeaderTitle } from './chat-header';

type ViewOptions = { title: HeaderTitle; workspaceOpen?: boolean };

function renderHeaderView({ title, workspaceOpen = false }: ViewOptions) {
  return render(
    <SidebarProvider defaultOpen>
      <ChatHeaderView
        title={title}
        workspaceOpen={workspaceOpen}
        onToggleWorkspace={vi.fn()}
        onNewChat={vi.fn()}
      />
    </SidebarProvider>,
  );
}

describe('ChatHeaderView — HD-03 title by HeaderTitle (AC-07.2, AC-07.3, AC-12.1)', () => {
  it.each([
    { state: 'text', text: 'Сверка договора с ООО «Ромашка»', pending: false },
    { state: 'pending', text: 'Новая беседа', pending: true },
  ])('$state: the h1 shows «$text» and is the programmatic focus target', ({ text, pending }) => {
    renderHeaderView({ title: { kind: 'text', text, pending } });

    const heading = screen.getByRole('heading', { level: 1, name: text });
    expect(heading).toHaveTextContent(text);
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading).toHaveAttribute('data-shell-focus', 'page-title');
  });

  it('hidden (`/`): the h1 is the visually hidden «Новый чат» and shows no title', () => {
    renderHeaderView({ title: { kind: 'hidden' } });

    const heading = screen.getByRole('heading', { level: 1, name: 'Новый чат' });
    expect(heading.querySelector('.sr-only')).toHaveTextContent('Новый чат');
    expect(screen.queryByText('Новая беседа')).toBeNull();
  });

  it('loading: the h1 is busy with a skeleton and does not show «Новая беседа» yet', () => {
    renderHeaderView({ title: { kind: 'loading' } });

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAttribute('aria-busy', 'true');
    expect(heading).toHaveTextContent('');
    expect(heading.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByText('Новая беседа')).toBeNull();
  });

  it('empty (TH-06 / TH-07): the h1 shows no title, no skeleton and no «Новый чат»', () => {
    renderHeaderView({ title: { kind: 'empty' } });

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('');
    expect(heading).not.toHaveAttribute('aria-busy');
    expect(heading.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: 'Новый чат' })).toBeNull();
  });

  it.each([
    { workspaceOpen: false, expanded: 'false' },
    { workspaceOpen: true, expanded: 'true' },
  ])('HD-04 «Рабочая область»: workspaceOpen=$workspaceOpen → aria-expanded="$expanded"', ({ workspaceOpen, expanded }) => {
    renderHeaderView({ title: { kind: 'hidden' }, workspaceOpen });

    expect(screen.getByRole('button', { name: 'Рабочая область' })).toHaveAttribute('aria-expanded', expanded);
  });
});

describe('ChatHeaderView — HD-02 sidebar toggle (AC-07.1)', () => {
  it('«Боковая панель» collapses the sidebar to the icon strip and reports it in aria-expanded', async () => {
    setTestMedia({ width: 1280, queries: { '(min-width: 768px)': true } });
    const user = userEvent.setup();
    const { container } = render(
      <SidebarProvider defaultOpen>
        <Sidebar id={SIDEBAR_ID} collapsible="icon" />
        <ChatHeaderView
          title={{ kind: 'hidden' }}
          workspaceOpen={false}
          onToggleWorkspace={vi.fn()}
          onNewChat={vi.fn()}
        />
      </SidebarProvider>,
    );
    const sidebar = container.querySelector('[data-slot="sidebar"]');
    const toggle = screen.getByRole('button', { name: 'Боковая панель' });

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', SIDEBAR_ID);
    expect(container.querySelector(`#${SIDEBAR_ID}`)).not.toBeNull();
    expect(toggle).toHaveAttribute('aria-keyshortcuts', 'Control+B Meta+B');
    expect(sidebar).toHaveAttribute('data-state', 'expanded');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar).toHaveAttribute('data-state', 'collapsed');
    expect(sidebar).toHaveAttribute('data-collapsible', 'icon');
    expect(container.querySelector(`#${SIDEBAR_ID}`)).not.toBeNull();
  });
});
