import { describe, expect, it, vi } from 'vitest';
import { syncUrlWithThread } from './url-sync';

function setup(pathname: string) {
  const history = { replaceState: vi.fn<History['replaceState']>() };
  const router = { replace: vi.fn<(href: string) => void>() };
  return { location: { pathname }, history, router };
}

describe('lib/threads/url-sync: syncUrlWithThread', () => {
  it.each([
    { from: '/', remoteId: 't-1', to: '/chat/t-1' },
    { from: '/chat/t-old', remoteId: 't-new', to: '/chat/t-new' },
    { from: '/', remoteId: 'a/b', to: '/chat/a%2Fb' },
  ])('replaces the entry $from with $to for a settled thread, without navigation', ({ from, remoteId, to }) => {
    const deps = setup(from);

    syncUrlWithThread({ remoteId, ...deps });

    expect(deps.history.replaceState).toHaveBeenCalledOnce();
    expect(deps.history.replaceState).toHaveBeenCalledWith(null, '', to);
    expect(deps.router.replace).not.toHaveBeenCalled();
  });

  it('replaces /chat/… with / through the router when the thread is gone', () => {
    const deps = setup('/chat/t-1');

    syncUrlWithThread({ remoteId: undefined, ...deps });

    expect(deps.router.replace).toHaveBeenCalledOnce();
    expect(deps.router.replace).toHaveBeenCalledWith('/');
    expect(deps.history.replaceState).not.toHaveBeenCalled();
  });

  it.each([
    { pathname: '/chat/t-1', remoteId: 't-1' },
    { pathname: '/chat/a%2Fb', remoteId: 'a/b' },
    { pathname: '/', remoteId: undefined },
  ])('does nothing on $pathname when it already matches thread $remoteId', ({ pathname, remoteId }) => {
    const deps = setup(pathname);

    syncUrlWithThread({ remoteId, ...deps });

    expect(deps.history.replaceState).not.toHaveBeenCalled();
    expect(deps.router.replace).not.toHaveBeenCalled();
  });
});
