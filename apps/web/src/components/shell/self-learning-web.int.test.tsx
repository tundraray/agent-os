// self-learning / training-web - integration tests (Vitest + RTL + MSW 2, jsdom)
// Design Doc: docs/features/self-learning/design-training-web.md, Test Strategy UC-1 (the start from the card), UC-3 (the training
//   conversation takes no message); UXRD SL-01, TR-01, MC-9, MC-10.
//
// Harness (src/test/, as deep-agents-web.int.test.tsx): `renderWithRuntime({ pathname })` mounts the shell with mocked next/navigation;
//   MSW server from '@/test/msw-server' (`onUnhandledRequest: 'error'`); answers built to pass the schemas of `packages/contracts`.
// Mock boundary: network (MSW), next/navigation, the event source of LiveStore.
//
// Server-side proofs are not repeated here: who may train, start, read the texts and activate is apps/api self-learning-training (TR-5).

import {
  TrainingErrorCode,
  type LibraryChoices,
  type MyRoleList,
  type StopResponse,
  type TrainingState,
} from '@agent-os/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import {
  conversationView,
  deepAgentContent,
  fixtureId,
  recordDetail,
  threadList,
  threadSummary,
} from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';
const AGENT_ID = fixtureId(81);
const TRAINING_ID = fixtureId(82);
const AGENT_NAME = 'Разбор заказов';

/** The page of Аня's self-learning deep agent, with the reads the record page makes. */
function recordPageHandlers() {
  return [
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
    http.get(`${API}/api/library/${AGENT_ID}`, () =>
      HttpResponse.json(
        recordDetail({
          id: AGENT_ID,
          kind: 'deep_agent',
          name: AGENT_NAME,
          content: deepAgentContent({ selfLearning: true }),
        }),
      ),
    ),
    http.get(`${API}/api/library/choices`, () =>
      HttpResponse.json({
        servers: ['logs'],
        defaultModel: 'anthropic/claude-haiku-4-5',
        defaultMaxTurns: 40,
      } satisfies LibraryChoices),
    ),
    http.get(`${API}/api/auth/me/roles`, () =>
      HttpResponse.json([] satisfies MyRoleList),
    ),
    http.get(`${API}/api/library/${AGENT_ID}/training`, () =>
      HttpResponse.json({
        canTrain: true,
        selfLearning: true,
        capUsd: 2,
        running: null,
        lastFinished: null,
      } satisfies TrainingState),
    ),
  ];
}

describe('self-learning / training-web - integration (jsdom + MSW)', () => {
  // UC-1, MC-9. Catches: a refused start that shows nothing (or navigates anyway); a started training that does not open its conversation.
  it('WEB-T1: «Обучить» shows the refusal TRAINING_RUNNING as its text, and a started training opens its conversation', async () => {
    let answer: 'running' | 'started' = 'running';
    server.use(
      ...recordPageHandlers(),
      http.post(`${API}/api/library/${AGENT_ID}/training`, () =>
        answer === 'running'
          ? HttpResponse.json(
              {
                statusCode: 409,
                error: 'Conflict',
                errorCode: TrainingErrorCode.TRAINING_RUNNING,
                message: 'A training is running',
              },
              { status: 409 },
            )
          : HttpResponse.json({ trainingId: TRAINING_ID }, { status: 201 }),
      ),
    );
    const user = userEvent.setup();
    const { router } = renderWithRuntime({ pathname: `/library/${AGENT_ID}` });

    await user.click(await screen.findByRole('button', { name: 'Обучить' }));
    expect(
      await screen.findByText(/A training is running/),
    ).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();

    answer = 'started';
    await user.click(await screen.findByRole('button', { name: 'Обучить' }));
    await vi.waitFor(() =>
      expect(router.push).toHaveBeenCalledWith(`/chat/${TRAINING_ID}`),
    );
  });

  // UC-3, TR-01, MC-10. Catches: a composer in the training conversation (a message would reach the trainer); a «Стоп» missing while it
  //   works, or one that stops anything but the conversation's root.
  it('WEB-T3: the training conversation has no composer and, while it works, «Стоп» stops its root', async () => {
    const thread = threadSummary({
      id: TRAINING_ID,
      title: `Обучение «${AGENT_NAME}»`,
    });
    const stops: string[] = [];
    server.use(
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(threadList([thread])),
      ),
      http.get(`${API}/api/threads/${TRAINING_ID}`, () =>
        HttpResponse.json(thread),
      ),
      http.get(`${API}/api/threads/${TRAINING_ID}/history`, () =>
        HttpResponse.json(
          conversationView({
            thread,
            chat: {
              status: 'working',
              failureReason: null,
              rootAgentId: TRAINING_ID,
              model: 'anthropic/claude-haiku-4-5',
            },
            training: {
              agentId: AGENT_ID,
              trainingId: TRAINING_ID,
              isRoot: true,
            },
          }),
        ),
      ),
      http.post(`${API}/api/agents/:agentId/stop`, ({ params }) => {
        stops.push(String(params.agentId));
        return HttpResponse.json({
          stopped: [TRAINING_ID],
        } satisfies StopResponse);
      }),
    );
    const user = userEvent.setup();
    renderWithRuntime({ pathname: `/chat/${TRAINING_ID}` });

    const readOnly = await screen.findByText(
      'Беседа обучения только для чтения.',
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    const line = readOnly.parentElement;
    if (line === null) throw new Error('no training line');
    await user.click(within(line).getByRole('button', { name: 'Стоп' }));
    await vi.waitFor(() => expect(stops).toEqual([TRAINING_ID]));
  });
});
