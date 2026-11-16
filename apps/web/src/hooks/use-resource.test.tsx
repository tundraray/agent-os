import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/api-request';
import { EMPLOYEE_SEARCH_DELAY_MS, useDebouncedValue } from './use-debounced-value';
import { usePagedResource, useResource, type Page } from './use-resource';

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock('@/lib/logger', () => ({ logger: { error: logError } }));

afterEach(() => {
  vi.useRealTimers();
});

/** A read the test answers by hand, in any order. */
function controlledReads<T>() {
  const pending = new Map<string, PromiseWithResolvers<T>>();
  const read = vi.fn((arg: string) => {
    const resolvers = Promise.withResolvers<T>();
    pending.set(arg, resolvers);
    return resolvers.promise;
  });
  const answer = (arg: string, value: T) =>
    act(async () => {
      pending.get(arg)?.resolve(value);
    });
  const fail = (arg: string, error: unknown) =>
    act(async () => {
      pending.get(arg)?.reject(error);
    });
  return { read, answer, fail };
}

type Person = { name: string };

/** The employee screen's search in miniature: debounced text keys a paged read. */
function SearchProbe({ loadPage }: { loadPage: (query: string, cursor: string | null) => Promise<Page<Person>> }) {
  const [text, setText] = useState('');
  const query = useDebouncedValue(text, EMPLOYEE_SEARCH_DELAY_MS);
  const people = usePagedResource((cursor) => loadPage(query, cursor), query);
  return (
    <>
      <input aria-label="Поиск" value={text} onChange={(event) => setText(event.target.value)} />
      <ul aria-label="Сотрудники">
        {people.items.map((person) => (
          <li key={person.name}>{person.name}</li>
        ))}
      </ul>
    </>
  );
}

const shownNames = () => screen.queryAllByRole('listitem').map((item) => item.textContent);

describe('read on open (KD-4, DC-3, Invariant 4)', () => {
  it.each<[string, () => Promise<void>]>([
    [
      'an answer for a previous key is dropped',
      async () => {
        const reads = controlledReads<string>();
        const { result, rerender } = renderHook(({ key }) => useResource(() => reads.read(key), key), {
          initialProps: { key: 'roles' },
        });
        rerender({ key: 'users' });
        await reads.answer('users', 'Сотрудники');
        await reads.answer('roles', 'Роли');
        expect(result.current.status).toBe('ready');
        expect(result.current.data).toBe('Сотрудники');
      },
    ],
    [
      'a read error is kept as the original error and logged once',
      async () => {
        const reads = controlledReads<string>();
        const failure = new ApiRequestError({
          kind: 'not_found',
          method: 'GET',
          path: '/api/admin/roles/r1',
          status: 404,
          code: 'ROLE_NOT_FOUND',
        });
        const { result } = renderHook(() => useResource(() => reads.read('r1'), 'r1'));
        await reads.fail('r1', failure);
        expect(result.current.status).toBe('error');
        expect(result.current.error).toBe(failure);
        expect(logError).toHaveBeenCalledExactlyOnceWith('admin: read failed', {
          kind: 'not_found',
          method: 'GET',
          path: '/api/admin/roles/r1',
          status: 404,
          code: 'ROLE_NOT_FOUND',
          reason: undefined,
        });
      },
    ],
    [
      'reload keeps the rows on screen while reading and then shows only the new read',
      async () => {
        let answer = Promise.withResolvers<string[]>();
        const load = vi.fn(() => answer.promise);
        const { result } = renderHook(() => useResource(load, 'roles'));
        await act(async () => answer.resolve(['Аналитики']));
        answer = Promise.withResolvers<string[]>();
        act(() => result.current.reload());
        expect(result.current.status).toBe('ready');
        expect(result.current.data).toEqual(['Аналитики']);
        await act(async () => answer.resolve(['Юристы']));
        expect(result.current.status).toBe('ready');
        expect(result.current.data).toEqual(['Юристы']);
      },
    ],
    [
      'a «Показать ещё» error keeps the loaded rows',
      async () => {
        const reads = controlledReads<Page<string>>();
        const failure = new ApiRequestError({ kind: 'network', method: 'GET', path: '/api/admin/users' });
        const { result } = renderHook(() => usePagedResource((cursor) => reads.read(cursor ?? 'first'), 'users'));
        await reads.answer('first', { items: ['Аня', 'Борис'], nextCursor: 'c2' });
        act(() => result.current.loadMore());
        await reads.fail('c2', failure);
        expect(result.current.items).toEqual(['Аня', 'Борис']);
        expect(result.current.nextCursor).toBe('c2');
        expect(result.current.loadMoreError).toBe(failure);
        expect(result.current.status).toBe('ready');
      },
    ],
    [
      '«Показать ещё» pressed during a reload sends nothing, so the rows of the reload are shown',
      async () => {
        const reads = controlledReads<Page<string>>();
        const { result } = renderHook(() => usePagedResource((cursor) => reads.read(cursor ?? 'first'), 'users'));
        await reads.answer('first', { items: ['Аня'], nextCursor: 'c2' });
        act(() => result.current.reload());
        act(() => result.current.loadMore());
        await reads.answer('first', { items: ['Аня', 'Борис'], nextCursor: 'c2' });
        expect(reads.read.mock.calls.map(([cursor]) => cursor)).toEqual(['first', 'first']);
        expect(result.current.items).toEqual(['Аня', 'Борис']);
      },
    ],
    [
      'a search reads 300 ms after the last keystroke and shows the answer for «аня» even when «ан» answers later',
      async () => {
        vi.useFakeTimers();
        const reads = controlledReads<Page<Person>>();
        const loadPage = (query: string) => reads.read(query);
        render(<SearchProbe loadPage={loadPage} />);
        const search = screen.getByRole('textbox', { name: 'Поиск' });

        fireEvent.change(search, { target: { value: 'а' } });
        act(() => vi.advanceTimersByTime(100));
        fireEvent.change(search, { target: { value: 'ан' } });
        act(() => vi.advanceTimersByTime(299));
        expect(reads.read.mock.calls.map(([query]) => query)).toEqual(['']);
        act(() => vi.advanceTimersByTime(1));
        expect(reads.read.mock.calls.map(([query]) => query)).toEqual(['', 'ан']);

        fireEvent.change(search, { target: { value: 'аня' } });
        act(() => vi.advanceTimersByTime(300));
        expect(reads.read.mock.calls.map(([query]) => query)).toEqual(['', 'ан', 'аня']);

        await reads.answer('аня', { items: [{ name: 'Аня Петрова' }], nextCursor: null });
        await reads.answer('ан', { items: [{ name: 'Антон Смирнов' }, { name: 'Аня Петрова' }], nextCursor: null });
        expect(shownNames()).toEqual(['Аня Петрова']);
      },
    ],
  ])('%s', async (_name, play) => {
    await play();
  });
});
