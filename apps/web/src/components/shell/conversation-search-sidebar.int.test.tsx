// schedules-search-memory / conversation-search - web integration: the search field in the sidebar
// Design Doc: docs/features/schedules-search-memory/design-conversation-search.md, Test Strategy UC-4 (the search field in the sidebar).
// Generated: 2026-11-25 | Budget: 1 of the part's 4 integration skeletons (API: conversation-search.int.e2e-spec.ts; Thread: conversation-search-thread.int.test.tsx)
// Test Type: Integration (Vitest + RTL + MSW 2 + user-event, jsdom)
//
// Harness (like shell.list.int.test.tsx / app-sidebar.test.tsx): `renderWithRuntime`, MSW `server`, `threadList` / `threadSummary` fixtures
//   from '@/test/fixtures'; a search fixture built from `ConversationSearchResponse` of @agent-os/contracts. MSW answers
//   `GET /api/search?q=` with a per-request delay so an earlier answer can arrive after a later one (the test controls which resolves
//   first); real timers carry the debounce.
// Mock boundary: network (MSW) + next/navigation only; AppSidebar, search store, threadsApiClient, thread list are real.
//
// Not repeated here: the ranking, the owner filter and paging (API UC-1, UC-2), the target in the feed (UC-3), mobile drawer layout (checked in the browser).

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationSearchResponse } from '@agent-os/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  conversationMatch,
  deferred,
  searchResponse,
  threadList,
  threadSummary,
  type Deferred,
} from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';

describe('AppSidebar: search field (UC-4)', () => {
  // AC-12.3: "Given поиск ничего не нашёл, when сотрудник смотрит на результаты, then видит, что совпадений нет." (web side)
  // Behavior: the employee types fast (several requests in flight) and an older answer arrives after the newest one -> the list shows only
  //   the matches of the last text; an empty answer shows «Ничего не нашлось»; the earlier matches stay until the new ones arrive;
  //   the field is cleared (and with fewer than 2 characters) -> the list of conversations is back in place of the matches.
  // Catches: a late answer for an older text overwriting the matches of the current one; the empty state missing; the conversation list
  //   not restored after the field is cleared.
  // @category: core-functionality
  // @dependency: AppSidebar, search store, threadsApiClient, MSW
  // @complexity: medium
  it('UC-4: the sidebar shows the matches of the last typed text only, "nothing found" on an empty answer, and the conversation list after clearing', async () => {
    // Arrange: one conversation in the list; each search answer is held until the test releases it.
    const answers = new Map<string, Deferred<ConversationSearchResponse>>([
      ['опл', deferred<ConversationSearchResponse>()],
      ['оплата', deferred<ConversationSearchResponse>()],
      ['оплата сбой', deferred<ConversationSearchResponse>()],
    ]);
    const asked: string[] = [];
    server.use(
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(
          threadList([
            threadSummary({ id: 't-1', title: 'Квартальный отчёт' }),
          ]),
        ),
      ),
      http.get(`${API}/api/search`, async ({ request }) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
        asked.push(q);
        const answer = answers.get(q);
        if (answer === undefined)
          return new HttpResponse(null, { status: 500 });
        return HttpResponse.json(await answer.promise);
      }),
    );
    const user = userEvent.setup();
    renderWithRuntime({ pathname: '/' });
    expect(
      await screen.findByRole('link', { name: 'Квартальный отчёт' }),
    ).toBeInTheDocument();
    const field = screen.getByRole('searchbox', { name: 'Поиск по беседам' });

    // Act: two texts in flight; the newer answer arrives first, the older one after it.
    await user.type(field, 'опл');
    await waitFor(() => expect(asked).toEqual(['опл']));
    await user.type(field, 'ата');
    await waitFor(() => expect(asked).toEqual(['опл', 'оплата']));
    answers
      .get('оплата')
      ?.resolve(
        searchResponse([
          conversationMatch({ threadId: 't-2', title: 'Сбои оплаты', seq: 4 }),
        ]),
      );
    const matches = await screen.findByRole('list', { name: 'Совпадения' });
    answers
      .get('опл')
      ?.resolve(
        searchResponse([
          conversationMatch({ threadId: 't-3', title: 'Старый ответ', seq: 2 }),
        ]),
      );
    // Gives the late answer time to reach the store, so its absence below is not a race.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Assert: only the last text's matches; the conversation list is hidden while they stand.
    expect(await screen.findByText('Найдены совпадения')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /^Сбои оплаты, В сообщении, / }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Старый ответ/ })).toBeNull();
    expect(
      screen.queryByRole('link', { name: 'Квартальный отчёт' }),
    ).toBeNull();
    expect(matches).toBeInTheDocument();

    // Act: a new text; the earlier matches stay until its (empty) answer arrives.
    await user.type(field, ' сбой');
    await waitFor(() => expect(asked).toContain('оплата сбой'));
    expect(
      screen.getByRole('link', { name: /^Сбои оплаты, / }),
    ).toBeInTheDocument();
    answers.get('оплата сбой')?.resolve(searchResponse([]));

    // Assert: the empty state of MC-15 (the text is also announced in the status region, so the hint line is the unique anchor).
    expect(
      await screen.findByText(/^Поиск смотрит в названия бесед/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Сбои оплаты, / })).toBeNull();

    // Act: «✕» clears the field.
    await user.click(screen.getByRole('button', { name: 'Очистить поиск' }));

    // Assert: the conversation list is back in place of the matches.
    expect(field).toHaveValue('');
    expect(
      await screen.findByRole('link', { name: 'Квартальный отчёт' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Совпадения' })).toBeNull();
    expect(screen.queryByText('Ничего не нашлось')).toBeNull();
  });
});
