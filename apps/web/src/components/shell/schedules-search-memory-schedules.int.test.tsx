// schedules-search-memory / schedules - web integration (Vitest + RTL + MSW 2, jsdom)
// Design Doc: docs/features/schedules-search-memory/design-schedules.md, «Страницы»: the open schedule page re-reads after its term.
//
// Harness (src/test/, as self-learning-web.int.test.tsx): `renderWithRuntime({ pathname })` mounts the shell with mocked next/navigation;
//   MSW server from '@/test/msw-server' (`onUnhandledRequest: 'error'`); answers built to pass the schemas of `packages/contracts`
//   (`ScheduleView`). Page TZ = 'Europe/Berlin' (vitest.config.ts).
// Mock boundary: network (MSW), next/navigation, the event source of LiveStore. The page and `schedulesApi` are real.
//
// Server-side proofs are not repeated here: schedule rules, rights and runs are apps/api schedules-search-memory-schedules (UC-1 .. UC-6).
// The schedule page is tested only for its re-read after the term (a pause of the pass sends no `tree` note).

import {
  ScheduleViewSchema,
  type ScheduleBody,
  type ScheduleView,
} from '@agent-os/contracts';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { fixtureId, threadList } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';
const THREAD_ID = fixtureId(91);
const AGENT_ID = fixtureId(92);
const SCHEDULE_ID = fixtureId(93);
const AGENT_NAME = 'Разбор логов';
const INSTRUCTION = 'Собери ошибки за ночь по сервисам оплаты';
/** Monday 7 January 2030, 09:00 in Berlin. */
const NEXT_RUN_AT = '2030-01-07T08:00:00.000Z';

/** The schedule as POST /api/schedules answers it. */
function createdSchedule(body: ScheduleBody): ScheduleView {
  return ScheduleViewSchema.parse({
    id: SCHEDULE_ID,
    name: body.instruction.slice(0, 100),
    instruction: body.instruction,
    rule: body.rule,
    timeZone: body.timeZone,
    target: body.target,
    createdAt: '2030-01-04T10:00:00.000Z',
    agent: { id: AGENT_ID, kind: 'agent', name: AGENT_NAME, available: true },
    conversation:
      body.target === 'this_conversation'
        ? { id: THREAD_ID, title: 'Беседа', deleted: false }
        : null,
    state: 'active',
    pausedBecause: null,
    nextRunAt: NEXT_RUN_AT,
    lastRun: null,
    access: body.access,
  } satisfies ScheduleView);
}

describe('schedules: the open page after its term', () => {
  // Risk: the pass pauses a schedule whose conversation is deleted at its term without touching any conversation, so no `tree` note
  //   comes; the open page must still re-read after the term instead of showing «Активно» until a reload.
  it('re-reads the schedule a few seconds after its next term and shows the pause the pass made', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true,
    });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(new Date('2030-01-07T07:59:00.000Z'));
    const active = createdSchedule({
      name: '',
      instruction: INSTRUCTION,
      agentId: AGENT_ID,
      rule: { kind: 'daily', time: '09:00' },
      timeZone: 'Europe/Berlin',
      target: 'this_conversation',
      conversationId: THREAD_ID,
      language: 'ru',
      access: 'read',
    });
    const paused: ScheduleView = {
      ...active,
      conversation: { id: THREAD_ID, title: 'Беседа', deleted: true },
      state: 'paused',
      pausedBecause: 'conversation_deleted',
      nextRunAt: null,
    };
    let reads = 0;
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
      http.get(`${API}/api/schedules/${SCHEDULE_ID}`, () => {
        reads += 1;
        return HttpResponse.json(
          Date.now() < Date.parse(NEXT_RUN_AT) ? active : paused,
        );
      }),
      http.get(`${API}/api/schedules/${SCHEDULE_ID}/runs`, () =>
        HttpResponse.json({ runs: [], nextCursor: null }),
      ),
    );
    renderWithRuntime({ pathname: `/schedules/${SCHEDULE_ID}` });

    expect(await screen.findByText('Активно')).toBeInTheDocument();
    const readsBeforeTerm = reads;

    // The term is a minute away: the re-read comes a few seconds after it, not before
    await vi.advanceTimersByTimeAsync(59_000);
    expect(reads).toBe(readsBeforeTerm);
    await vi.advanceTimersByTimeAsync(7_000);

    expect(await screen.findByText('На паузе')).toBeInTheDocument();
    expect(
      screen.getByText(/Беседа «Беседа» удалена, поэтому расписание на паузе/),
    ).toBeInTheDocument();
  });
});
