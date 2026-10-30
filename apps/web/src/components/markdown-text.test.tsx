import { TextMessagePartProvider } from '@assistant-ui/react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownText } from './markdown-text';

function renderMarkdown(text: string) {
  return render(
    <TextMessagePartProvider text={text}>
      <MarkdownText />
    </TextMessagePartProvider>,
  );
}

describe('MarkdownText link and image policy', () => {
  it('renders a javascript: link as plain text without a link', async () => {
    renderMarkdown('[x](javascript:alert(1))');

    const text = await screen.findByText('x');
    expect(text.closest('a')).toBeNull();
    expect(screen.queryByRole('link', { name: 'x' })).toBeNull();
  });

  it('opens an external link in a new tab without opener or referrer', async () => {
    renderMarkdown('[s](https://example.com)');

    // jsdom drops the leading space of the inline sr-only hint from the accessible name; browsers keep it.
    const link = await screen.findByRole('link', { name: /^s ?\(откроется в новой вкладке\)$/ });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('(откроется в новой вкладке)')).toHaveClass('sr-only');
  });

  it('keeps a footnote fragment link in the same document', async () => {
    renderMarkdown('[f](#user-content-fn-1)');

    const link = await screen.findByRole('link', { name: 'f' });
    expect(link).toHaveAttribute('href', '#user-content-fn-1');
    expect(link).not.toHaveAttribute('target');
  });

  it('renders an https image without a referrer, lazily', async () => {
    renderMarkdown('![a](https://img.test/a.png)');

    const image = await screen.findByRole('img', { name: 'a' });
    expect(image).toHaveAttribute('src', 'https://img.test/a.png');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('decoding', 'async');
  });

  it('replaces an http image with a new-tab link instead of fetching it', async () => {
    renderMarkdown('![a](http://img.test/a.png)');

    const link = await screen.findByRole('link', {
      name: /^Изображение: a ?\(откроется в новой вкладке\)$/,
    });
    expect(link).toHaveAttribute('href', 'http://img.test/a.png');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows a placeholder for an image source no link may point at', async () => {
    renderMarkdown('![a](data:image/png;base64,iVBORw0KGgo=)');

    expect(await screen.findByText('[Изображение недоступно: a]')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('labels the code block copy button in Russian', async () => {
    renderMarkdown('```ts\nconst a = 1\n```');

    expect(await screen.findByRole('button', { name: 'Копировать' })).toBeInTheDocument();
  });
});
