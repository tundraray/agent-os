// schedules-search-memory / schedules - web integration (Vitest + RTL + MSW 2, jsdom)
// Design Doc: docs/features/schedules-search-memory/design-schedules.md, Test Strategy UC-7 (the dialog from the message field);
//   UXRD SH-01 (menu item "Запланировать"), SH-02 (dialog), KD-1, MC-1, MC-2.
//
// Harness (src/test/, as self-learning-web.int.test.tsx): `renderWithRuntime({ pathname })` mounts the shell with mocked next/navigation;
//   MSW server from '@/test/msw-server' (`onUnhandledRequest: 'error'`); answers built to pass the schemas of `packages/contracts`
//   (`ScheduleBody`, `ScheduleView`, next-run preview). Page TZ = 'Europe/Berlin' (vitest.config.ts).
// Mock boundary: network (MSW), next/navigation, the event source of LiveStore. The composer, the menu, the dialog and `schedulesApi` are real.
//
// Server-side proofs are not repeated here: schedule rules, rights and runs are apps/api schedules-search-memory-schedules (UC-1 .. UC-6).
// The schedule page is tested only for its re-read after the term (a pause of the pass sends no `tree` note).
// Not tested: the rest of the "Schedules" pages (list, history) and the feed caption "По расписанию «{имя}»" — presentation of data the API test proves.

import {
  ScheduleBodySchema,
  ScheduleViewSchema,
  type ScheduleBody,
  type ScheduleNextRunResponse,
  type ScheduleView,
} from '@agent-os/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  conversationWithTurns,
  fixtureId,
  recordSummary,
  threadList,
  threadSummary,
} from '@/test/fixtures';
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
    conversation: { id: THREAD_ID, title: 'Беседа', deleted: false },
    state: 'active',
    pausedBecause: null,
    nextRunAt: NEXT_RUN_AT,
    lastRun: null,
  } satisfies ScheduleView);
}

/** The bodies of every POST /api/schedules the shell made. */
function recordCreates(): unknown[] {
  const bodies: unknown[] = [];
  const record = async ({ request }: { request: Request }) => {
    if (request.method !== 'POST') return;
    if (new URL(request.url).pathname !== '/api/schedules') return;
    bodies.push(JSON.parse(await request.clone().text()));
  };
  server.events.on('request:start', record);
  onTestFinished(() => {
    server.events.removeListener('request:start', record);
  });
  return bodies;
}

describe('schedules: the dialog from the message field', () => {
  // AC: AC-01.1 "Given an employee created the schedule 'weekdays at 9:00', when they open the list, then they see it with the nearest
  //   term" (the creation step, from the web side).
  // Catches: the dialog losing the typed text or chip, or leaving the text in the field after the schedule was made (the same instruction
  //   sent twice), or sending the wrong zone / conversation so the server schedules the wrong thing.
  it('UC-7: "+" -> "Запланировать" opens the dialog with the field text and agent; creating clears the field and names the next run', async () => {
    const thread = threadSummary({ id: THREAD_ID });
    server.use(
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(threadList([thread])),
      ),
      http.get(`${API}/api/threads/${THREAD_ID}`, () =>
        HttpResponse.json(thread),
      ),
      http.get(`${API}/api/threads/${THREAD_ID}/history`, () =>
        HttpResponse.json(
          conversationWithTurns(thread, ['Сводка за вчера', 'Готово']),
        ),
      ),
      http.get(`${API}/api/library`, () =>
        HttpResponse.json([recordSummary({ id: AGENT_ID, name: AGENT_NAME })]),
      ),
      http.post(`${API}/api/schedules/next-run`, () =>
        HttpResponse.json({
          nextRunAt: NEXT_RUN_AT,
        } satisfies ScheduleNextRunResponse),
      ),
      http.post(`${API}/api/schedules`, async ({ request }) =>
        HttpResponse.json(
          createdSchedule(ScheduleBodySchema.parse(await request.json())),
          { status: 201 },
        ),
      ),
    );
    const creates = recordCreates();
    const user = userEvent.setup();
    renderWithRuntime({ pathname: `/chat/${THREAD_ID}` });

    // The field holds a text and the agent's chip
    const field = await screen.findByRole('textbox', { name: 'Сообщение' });
    await user.click(screen.getByRole('button', { name: 'Добавить' }));
    await user.click(
      await screen.findByRole('menuitem', { name: new RegExp(AGENT_NAME) }),
    );
    await user.type(field, INSTRUCTION);

    // "+" -> "Запланировать": the dialog starts from the field's text and agent
    await user.click(screen.getByRole('button', { name: 'Добавить' }));
    await user.click(
      await screen.findByRole('menuitem', { name: /Запланировать/ }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Новое расписание',
    });
    expect(
      within(dialog).getByRole('textbox', { name: 'Инструкция' }),
    ).toHaveValue(INSTRUCTION);
    expect(
      within(dialog).getByRole('combobox', { name: 'Агент' }),
    ).toHaveTextContent(AGENT_NAME);
    expect(
      await within(dialog).findByText(
        /Следующее срабатывание: 7\sянв\.,\s09:00/,
      ),
    ).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole('button', { name: 'Создать расписание' }),
    );

    // The body: the instruction, the chip's agent, the rule, the browser's zone, the language and this conversation
    await vi.waitFor(() =>
      expect(creates).toEqual([
        {
          name: '',
          instruction: INSTRUCTION,
          agentId: AGENT_ID,
          rule: { kind: 'weekdays', days: [1, 2, 3, 4, 5], time: '09:00' },
          timeZone: 'Europe/Berlin',
          target: 'new_conversation',
          conversationId: THREAD_ID,
          language: 'ru',
        },
      ]),
    );

    // The dialog closed, the field and its chip are empty, the notice names the next run
    expect(
      await screen.findByText(
        /Расписание создано\. Следующее срабатывание — 7\sянв\.,\s09:00\./,
      ),
    ).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(field).toHaveValue('');
    expect(
      screen.queryByRole('button', { name: `Убрать: ${AGENT_NAME}` }),
    ).toBeNull();
  });
});

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
