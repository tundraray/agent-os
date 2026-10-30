import { describe, expect, it } from 'vitest';
import { resolveMainView, type MainView, type MainViewInput } from './resolve-main-view';
import { ThreadsApiError } from './threads-api-error';

const base: MainViewInput = {
  routeThreadId: undefined,
  mainRemoteId: undefined,
  switchError: undefined,
  historyStatus: undefined,
};

describe('resolveMainView', () => {
  it.each<{ name: string; input: Partial<MainViewInput>; expected: MainView }>([
    {
      name: 'rule 1: a not_found switch error for the route thread → not-found',
      input: { routeThreadId: 'x', switchError: { threadId: 'x', error: new ThreadsApiError('not_found', 404) } },
      expected: { kind: 'not-found' },
    },
    {
      name: 'rule 1: any other switch error for the route thread → load-error / switch',
      input: { routeThreadId: 'x', switchError: { threadId: 'x', error: new ThreadsApiError('network') } },
      expected: { kind: 'load-error', retry: 'switch' },
    },
    {
      name: 'rule 1: a switch error that is not a ThreadsApiError → load-error / switch',
      input: { routeThreadId: 'x', switchError: { threadId: 'x', error: new Error('boom') } },
      expected: { kind: 'load-error', retry: 'switch' },
    },
    {
      name: 'rule 1 wins over a ready history of the same thread',
      input: {
        routeThreadId: 'x',
        mainRemoteId: 'x',
        historyStatus: 'ready',
        switchError: { threadId: 'x', error: new ThreadsApiError('not_found', 404) },
      },
      expected: { kind: 'not-found' },
    },
    {
      name: 'rule 2: a switch error of another thread is ignored; the main thread is not the route thread → switching',
      input: { routeThreadId: 'x', mainRemoteId: 'y', switchError: { threadId: 'y', error: new ThreadsApiError('http', 500) } },
      expected: { kind: 'switching' },
    },
    {
      name: 'rule 2: a direct link whose thread has no remote id yet → switching (no welcome)',
      input: { routeThreadId: 'x', mainRemoteId: undefined },
      expected: { kind: 'switching' },
    },
    {
      name: 'rule 2 wins over the history status of the previous main thread',
      input: { routeThreadId: 'x', mainRemoteId: 'y', historyStatus: 'load_failed' },
      expected: { kind: 'switching' },
    },
    {
      name: 'rule 3: history not_found → not-found',
      input: { routeThreadId: 'x', mainRemoteId: 'x', historyStatus: 'not_found' },
      expected: { kind: 'not-found' },
    },
    {
      name: 'rule 3: history load_failed → load-error / history',
      input: { routeThreadId: 'x', mainRemoteId: 'x', historyStatus: 'load_failed' },
      expected: { kind: 'load-error', retry: 'history' },
    },
    {
      name: 'rule 4: the URL thread is open but its history load has not started → switching',
      input: { routeThreadId: 'x', mainRemoteId: 'x', historyStatus: undefined },
      expected: { kind: 'switching' },
    },
    {
      name: 'rule 4: the URL thread is open and its history is loading → switching',
      input: { routeThreadId: 'x', mainRemoteId: 'x', historyStatus: 'loading' },
      expected: { kind: 'switching' },
    },
    {
      name: 'rule 5: the URL thread with a ready history → thread',
      input: { routeThreadId: 'x', mainRemoteId: 'x', historyStatus: 'ready' },
      expected: { kind: 'thread', deleted: false },
    },
    {
      name: 'rule 5: the URL thread deleted while open → thread with the deleted notice',
      input: { routeThreadId: 'x', mainRemoteId: 'x', historyStatus: 'deleted' },
      expected: { kind: 'thread', deleted: true },
    },
    {
      name: 'rule 5: a new chat on `/` → thread',
      input: { routeThreadId: undefined, historyStatus: undefined },
      expected: { kind: 'thread', deleted: false },
    },
    {
      name: 'rule 5: a new chat on `/` ignores a switch error of a thread it no longer shows',
      input: { routeThreadId: undefined, switchError: { threadId: 'x', error: new ThreadsApiError('not_found', 404) } },
      expected: { kind: 'thread', deleted: false },
    },
    {
      name: 'rule 5: a chat created on `/` whose history is ready → thread',
      input: { routeThreadId: undefined, mainRemoteId: 't-new', historyStatus: 'ready' },
      expected: { kind: 'thread', deleted: false },
    },
  ])('$name', ({ input, expected }) => {
    expect(resolveMainView({ ...base, ...input })).toEqual(expected);
  });
});
