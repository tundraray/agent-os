import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setTestMedia } from '@/test/setup';
import { focusAfterNewChat, focusShellTarget, isFinePointer } from './focus';

/** The two focus targets as the shell renders them: the composer field and HD-03. */
function mountTargets(): { composer: HTMLTextAreaElement; pageTitle: HTMLHeadingElement } {
  const pageTitle = document.createElement('h1');
  pageTitle.tabIndex = -1;
  pageTitle.dataset.shellFocus = 'page-title';
  const composer = document.createElement('textarea');
  composer.dataset.shellFocus = 'composer';
  document.body.append(pageTitle, composer);
  return { composer, pageTitle };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('lib/focus — pointer rule (AC-03.1, UXRD 7.4)', () => {
  it.each([
    { pointer: 'fine', fine: true, target: 'composer' },
    { pointer: 'coarse', fine: false, target: 'page-title' },
  ] as const)('$pointer pointer: «Новый чат» focuses $target', async ({ pointer, fine, target }) => {
    setTestMedia({ pointer });
    const elements = mountTargets();

    focusAfterNewChat();

    expect(isFinePointer()).toBe(fine);
    const expected = target === 'composer' ? elements.composer : elements.pageTitle;
    await waitFor(() => expect(expected).toHaveFocus());
  });

  // L1-7: from an agent page the outgoing view's h1 takes focus first, then the route replaces it.
  it('focuses the target the transition renders after replacing the outgoing view', async () => {
    const { pageTitle: outgoing } = mountTargets();
    const pageTitle = document.createElement('h1');
    pageTitle.tabIndex = -1;
    pageTitle.dataset.shellFocus = 'page-title';

    focusShellTarget('page-title');
    await waitFor(() => expect(outgoing).toHaveFocus());
    outgoing.remove();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    document.body.append(pageTitle);

    await waitFor(() => expect(pageTitle).toHaveFocus());
  });
});
