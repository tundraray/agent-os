// schedules-search-memory / memory-hygiene-web - integration tests (Vitest + RTL + MSW 2, jsdom)
// Design Doc: docs/features/schedules-search-memory/design-memory-hygiene.md, Test Strategy UC-5 (the history dialog); UXRD MH-03 (the
//   conflict warning) and the dialog's own states; PRD AC-17.2, AC-19.2 as the user sees them.
//
// Harness (as self-learning-web.int.test.tsx): `renderWithRuntime({ pathname })` with mocked next/navigation; MSW server from
//   '@/test/msw-server' (`onUnhandledRequest: 'error'`); answers built to pass the schemas of `packages/contracts`
//   (`AgentMemoryView` with the `deleted` flag, `MemoryHistoryView`, `RevertMemoryBody`). The page under test is the memory page of a
//   deep agent (`memoryPath(id)`, `components/library/memory-page.tsx` over the shared `memory-table.tsx`).
// Mock boundary: network (MSW) only.
//
// Server-side proofs are not repeated here: who may open the history or revert, the 409 rule itself and the versions' content are
//   apps/api memory-hygiene MH-3 / MH-4. «Моя память» passes the same `MemoryTable` its own history, revert and delete functions; its
//   «вы» author label is a prop of the same dialog and is not a second test.
// NFR-05 (360 px) is checked in a browser when the screen is built, not here.

import {
  AgentMemoryViewSchema,
  LibraryErrorCode,
  MemoryHistoryViewSchema,
  RevertMemoryBodySchema,
  type AgentMemoryView,
  type MemoryHistoryView,
  type MemoryVersionView,
  type RevertMemoryBody,
} from '@agent-os/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import {
  deepAgentContent,
  fixtureId,
  fixtureTime,
  recordDetail,
  threadList,
} from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';
import { memoryPath } from '@/lib/shell-route';

const API = 'http://api.test';
const AGENT_ID = fixtureId(91);
const RECORD_ID = fixtureId(92);
const DESCRIPTION = 'Старый адрес дашборда';
const FIRST_TEXT = 'Дашборд оплаты — grafana/d/billing-old';
const AGENT_TEXT = 'Дашборд оплаты переехал в grafana/d/billing';

/** A version of the record; the agent made it unless `changedBy` says otherwise. */
const version = (
  number: number,
  kind: MemoryVersionView['kind'],
  text: string | null,
  changedBy: string | null = null,
): MemoryVersionView => ({
  version: number,
  kind,
  text,
  changedAt: fixtureTime(number * 60),
  changedBy,
});

const historyOf = (versions: MemoryVersionView[]): MemoryHistoryView =>
  MemoryHistoryViewSchema.parse({
    description: DESCRIPTION,
    versions: [...versions].reverse(),
  });

const memoryOf = (deleted: boolean, text: string): AgentMemoryView =>
  AgentMemoryViewSchema.parse({
    selfLearning: true,
    records: [
      {
        id: RECORD_ID,
        description: DESCRIPTION,
        text,
        deleted,
        updatedAt: fixtureTime(120),
      },
    ],
  });

const conflictBody = {
  statusCode: 409,
  error: 'Conflict',
  errorCode: LibraryErrorCode.RECORD_VERSION_CONFLICT,
  message: 'The record has a newer version',
};

describe('schedules-search-memory / memory-hygiene-web - integration (jsdom + MSW)', () => {
  // AC: AC-17.2 "Given агент удалил запись, when автор агента открывает экран памяти, then видит удалённую запись с её историей."
  // AC: AC-19.2 "Given автор открыл историю, а агент после этого изменил запись, when автор откатывает запись, then откат отклонён, и
  //   автор видит новую версию агента."
  // Catches: a table that hides deleted rows (the person cannot find what the agent forgot); a dialog that sends a fresh current
  //   number on revert so the conflict never fires and the agent's newer text is overwritten; a 409 that leaves the old list and no
  //   warning on screen.
  it('UC-5: a deleted row opens its history; a revert shows «Возвращена» on top and the row live again; a second revert answered 409 re-reads the history and shows the conflict warning', async () => {
    // The server's record: created by the agent, then deleted by it.
    let versions = [
      version(1, 'created', FIRST_TEXT),
      version(2, 'deleted', null),
    ];
    const reverts: RevertMemoryBody[] = [];
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
      http.get(`${API}/api/library/${AGENT_ID}`, () =>
        HttpResponse.json(
          recordDetail({
            id: AGENT_ID,
            kind: 'deep_agent',
            name: 'Разбор оплаты',
            content: deepAgentContent({ selfLearning: true }),
          }),
        ),
      ),
      http.get(`${API}/api/library/${AGENT_ID}/memory`, () => {
        const top = versions[versions.length - 1];
        return HttpResponse.json(
          memoryOf(top?.kind === 'deleted', top?.text ?? FIRST_TEXT),
        );
      }),
      http.get(
        `${API}/api/library/${AGENT_ID}/memory/${RECORD_ID}/history`,
        () => HttpResponse.json(historyOf(versions)),
      ),
      http.post(
        `${API}/api/library/${AGENT_ID}/memory/${RECORD_ID}/revert`,
        async ({ request }) => {
          const body = RevertMemoryBodySchema.parse(await request.json());
          reverts.push(body);
          if (body.expectedVersion !== versions.length)
            return HttpResponse.json(conflictBody, { status: 409 });
          const source = versions.find((v) => v.version === body.version);
          versions = [
            ...versions,
            version(
              versions.length + 1,
              'reverted',
              source?.text ?? null,
              'Аня Смирнова',
            ),
          ];
          return HttpResponse.json(historyOf(versions));
        },
      ),
    );
    const user = userEvent.setup();
    renderWithRuntime({ pathname: memoryPath(AGENT_ID) });

    // MH-01: the deleted row stays, marked «Удалена»; expanded, it opens its history (MC-16).
    const row = await screen.findByRole('button', {
      name: new RegExp(`^${DESCRIPTION}`),
    });
    expect(row).toHaveTextContent('Удалена');
    await user.click(row);
    expect(screen.queryByText(FIRST_TEXT)).toBeNull();
    expect(
      screen.getByText('Агент удалил эту запись. Вернуть её можно из истории.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'История' }));

    // MH-02: newest first, the current one marked, the agent's changes signed «агент».
    const dialog = await screen.findByRole('dialog');
    const items = await within(dialog).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(/^Удалена · агент · .*Текущая$/);
    expect(items[1]).toHaveTextContent(FIRST_TEXT);
    expect(within(items[0]).queryByRole('button')).toBeNull();

    // A revert sends the number on top of the list the person saw and shows the history the route returned.
    await user.click(
      within(items[1]).getByRole('button', { name: /^Вернуть версию от / }),
    );
    await vi.waitFor(() =>
      expect(within(dialog).getAllByRole('listitem')).toHaveLength(3),
    );
    expect(reverts).toEqual([{ version: 1, expectedVersion: 2 }]);
    const afterRevert = within(dialog).getAllByRole('listitem');
    expect(afterRevert[0]).toHaveTextContent(
      /^Возвращена · Аня Смирнова · .*Текущая/,
    );
    expect(afterRevert[0]).toHaveTextContent(FIRST_TEXT);

    // Meanwhile the agent edits the record: the dialog still shows version 3 on top.
    versions = [...versions, version(4, 'changed', AGENT_TEXT)];
    const oldest = within(dialog).getAllByRole('listitem')[2];
    if (oldest === undefined) throw new Error('no oldest version');
    await user.click(
      within(oldest).getByRole('button', { name: /^Вернуть версию от / }),
    );

    // MH-03: the stale number is refused; the warning stands above the re-read list with the agent's version on top.
    expect(
      await within(dialog).findByText(
        'Запись изменилась, пока была открыта история. Новая версия — сверху; если прежняя всё ещё нужна, верните её ещё раз.',
        { ignore: '[role="status"]' },
      ),
    ).toBeInTheDocument();
    expect(reverts[1]).toEqual({ version: 1, expectedVersion: 3 });
    await vi.waitFor(() =>
      expect(within(dialog).getAllByRole('listitem')).toHaveLength(4),
    );
    const reread = within(dialog).getAllByRole('listitem');
    expect(reread[0]).toHaveTextContent(/^Изменена · агент · .*Текущая/);
    expect(reread[0]).toHaveTextContent(AGENT_TEXT);

    // The table under the dialog was read again after the revert: the row is live.
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      screen.getByRole('button', { name: new RegExp(`^${DESCRIPTION}`) }),
    ).not.toHaveTextContent('Удалена');
  });
});
