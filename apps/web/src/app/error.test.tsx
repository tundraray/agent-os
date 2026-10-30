import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ShellError from './error';

describe('ShellError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a fixed message and logs only the digest, never the error text', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error('secret render failure'), { digest: 'digest-123' });

    render(<ShellError error={error} retry={() => {}} />);

    expect(screen.getByRole('heading', { name: 'Что-то пошло не так' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Обновить страницу' })).toBeInTheDocument();
    expect(screen.queryByText(/secret render failure/)).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith('chat shell: render failed', { digest: 'digest-123' });
  });
});
