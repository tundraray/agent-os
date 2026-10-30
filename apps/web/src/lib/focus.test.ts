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

  it('focuses a target that appears only after the transition has rendered the new view', async () => {
    const pageTitle = document.createElement('h1');
    pageTitle.tabIndex = -1;
    pageTitle.dataset.shellFocus = 'page-title';

    focusShellTarget('page-title');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    document.body.append(pageTitle);

    await waitFor(() => expect(pageTitle).toHaveFocus());
  });
});
