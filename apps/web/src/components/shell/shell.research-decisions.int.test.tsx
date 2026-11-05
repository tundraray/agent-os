// deep-research / chat-entry (web) Integration Test Skeletons - Design Doc: docs/features/deep-research/design-chat-entry.md (C3 web: «отправка и решения», KD-1, KD-2)
// PRD: docs/features/deep-research/prd.md v1.12 (FR-19, FR-27). UXRD: docs/features/deep-research/uxrd.md v1.7 (DR-01..DR-03, KD-1, KD-4, KD-8, KD-9, MC-7, MC-13, MC-15, MC-16, MC-17, MC-29, MC-30, MC-31).
// Generated: 2026-11-01 | Updated: 2026-11-01 for the no-source mode (Design Doc v1.6: KD-8, DC-8) | Part: chat-entry | Test type: Integration (Vitest + RTL + MSW 2, jsdom, REAL useChatRuntime / AI SDK Chat - not useLocalRuntime) | Budget slot: INT-4 of the part (extra: see the unique defect below)
// Implementation timing: created alongside the web slice that adds ResearchModeToggle, ResearchCard and the metadata handling in ChatRuntimeProvider / ThreadMessage.
//
// File name and placement follow the sibling files `shell.<topic>.int.test.tsx` in this folder (include 'src/**/*.test.{ts,tsx}' of vitest.config.ts). The web part has no browser E2E runner:
// the real-browser journey is the L1 scenario E2E-2 in docs/features/deep-research/chat-entry/l1-browser-scenarios.md, as chat-shell does.
//
// Why integration and not the component test: whether the decision turn is invisible and is not sent a second time depends on three things that only the real runtime combines - what `useChatRuntime` stores and re-sends,
//   the `sendAutomaticallyWhen` rule, and which messages `ThreadMessage` draws. A component test on useLocalRuntime has none of them. The AI SDK resets the chat error on every send (design KD-2): only the real runtime shows it.
//
// Harness (src/test/): renderWithRuntime({ pathname }) from '@/test/render-with-runtime' mounts ChatRuntimeProvider + ChatShell with mocked next/navigation. MSW server from '@/test/msw-server' (onUnhandledRequest: 'error');
//   fixtures from '@/test/fixtures' (sseFromChunks builds SSE v7 from a chunk list; `historyMessages` builds the restored thread; the plan adds fixtures for a `deepResearch` tool part, a `researchAnswer` message and a
//   ResearchLaunchView list). API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test'. TZ = 'Europe/Berlin'.
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters, ResearchCard, ResearchModeToggle, ThreadMessage, MessageError, useThreadResearch - real.
//   Do NOT mock lib/threads/*, lib/config.ts or @assistant-ui/*.
//
// Unique defect no other test catches (why this is an extra slot): the api rows (INT-1 A3, INT-3 T1) prove the stored marks and the state; none proves that the browser draws no message for a decision turn, sends no second automatic turn after a
// `deepResearch` call, keeps the error block off the old reply after the decision, or shows the card's error line (not an error stub in the feed) when the turn fails before streaming. A regression there is visible to every user of the cards.

import {
  RESEARCH_METADATA_KEYS,
  type DeepResearchToolResult,
  type HistoryMessage,
  type ResearchLaunchView,
  type ResearchSourceMode,
} from '@agent-os/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessageChunk } from 'ai';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deepResearchToolPart,
  deferred,
  historyMessages,
  researchAnswerMessage,
  researchDecisionPair,
  researchLaunchView,
  threadList,
  threadResearch,
  threadSummary,
  assistantTextChunks,
  sseFromChunks,
  type Deferred,
} from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';
const THREAD = 'a';
const GOAL_A = 'Почему выросли расходы на облако';
const GOAL_B = 'Как снизить задержки API';

const MC_15 = 'Не удалось запустить ресерч. Попробуйте ещё раз.';
const MC_16 = 'Не удалось остановить ресерч. Попробуйте ещё раз.';
const MC_29 = 'Не удалось отклонить предложение. Попробуйте ещё раз.';
const MC_30 = 'Доступно, когда агент закончит ответ.';
const MC_31 = 'Источники данных не подключены — ответ будет из знаний модели.';
const MC_17 = 'Ресерч запущен';
const MC_17_NO_SOURCES = 'Ресерч запущен. Источники данных не подключены — ответ будет из знаний модели.';

type ChatReply = (body: unknown) => Response | Promise<Response>;

/** Records what MSW received; every array and counter belongs to one test. */
type Traffic = { chatBodies: unknown[]; researchReads: number };

/**
 * Serves thread `a`: its summary, its history, the research list (a function of the read number, so a test can change
 * what the next read returns) and the chat turns, answered in order by `replies`.
 */
function serveThread({
  history,
  research,
  replies,
}: {
  history: HistoryMessage[];
  research: (read: number) => ResearchLaunchView[] | Promise<ResearchLaunchView[]>;
  replies: ChatReply[];
}): Traffic {
  const traffic: Traffic = { chatBodies: [], researchReads: 0 };
  server.use(
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([threadSummary({ id: THREAD, title: 'Беседа A' })]))),
    http.get(`${API}/api/threads/${THREAD}`, () => HttpResponse.json(threadSummary({ id: THREAD, title: 'Беседа A' }))),
    http.get(`${API}/api/threads/${THREAD}/messages`, () => HttpResponse.json({ messages: history })),
    http.get(`${API}/api/threads/${THREAD}/research`, async () => {
      traffic.researchReads += 1;
      return HttpResponse.json(threadResearch(await research(traffic.researchReads)));
    }),
    http.post(`${API}/api/chat/assistant`, async ({ request }) => {
      const body: unknown = await request.json();
      traffic.chatBodies.push(body);
      const reply = replies[traffic.chatBodies.length - 1];
      if (reply === undefined) throw new Error(`no reply queued for chat request ${traffic.chatBodies.length}`);
      return reply(body);
    }),
  );
  return traffic;
}

/** The last message of a chat request body. */
function lastMessageOf(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || !('messages' in body) || !Array.isArray(body.messages)) return undefined;
  return body.messages.at(-1);
}

/** An SSE reply that sends `before`, waits for `gate`, then sends `after` - the latch that holds a turn mid-stream. */
function heldStream(before: UIMessageChunk[], gate: Deferred<void>, after: UIMessageChunk[]): Response {
  const encoder = new TextEncoder();
  const event = (chunk: UIMessageChunk | '[DONE]') =>
    encoder.encode(`data: ${chunk === '[DONE]' ? chunk : JSON.stringify(chunk)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of before) controller.enqueue(event(chunk));
      await gate.promise;
      for (const chunk of after) controller.enqueue(event(chunk));
      controller.enqueue(event('[DONE]'));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

/** The chunks of a reply whose only part is a `deepResearch` call; a decision reply carries its label in the stream. */
function toolReply({
  messageId,
  toolCallId,
  goal,
  result,
  decisionReplyOf,
}: {
  messageId: string;
  toolCallId: string;
  goal: string;
  result: DeepResearchToolResult;
  decisionReplyOf?: string;
}): { head: UIMessageChunk[]; tail: UIMessageChunk[] } {
  return {
    head: [
      decisionReplyOf === undefined
        ? { type: 'start', messageId }
        : {
            type: 'start',
            messageId,
            messageMetadata: { [RESEARCH_METADATA_KEYS.researchDecisionReply]: { launchKey: decisionReplyOf } },
          },
      { type: 'tool-input-available', toolCallId, toolName: 'deepResearch', input: { goal } },
    ],
    tail: [{ type: 'tool-output-available', toolCallId, output: result }, { type: 'finish' }],
  };
}

const replyNow =
  (chunks: { head: UIMessageChunk[]; tail: UIMessageChunk[] }): ChatReply =>
  () =>
    sseFromChunks([...chunks.head, ...chunks.tail]);

const replyHeld =
  (chunks: { head: UIMessageChunk[]; tail: UIMessageChunk[] }, gate: Deferred<void>): ChatReply =>
  () =>
    heldStream(chunks.head, gate, chunks.tail);

/** The drawn feed: the text of every user and assistant message root, in order. */
function feedRoots(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-role="user"], [data-role="assistant"]'));
}

const card = (goal: string) => screen.getByRole('group', { name: `Ресерч: ${goal}` });

/** A restored assistant message holding the card of one launch: its `deepResearch` call and result. */
function cardMessage(id: string, launch: ResearchLaunchView): HistoryMessage {
  return {
    id,
    role: 'assistant',
    parts: [deepResearchToolPart({ toolCallId: launch.launchKey, goal: launch.goal, result: { launch } })],
  };
}

const statusText = () => screen.getAllByRole('status').map((region) => region.textContent ?? '');

beforeEach(() => {
  // handleChatError and the research poll log failures; the tests assert what the user sees instead.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Shell: the research mode and the decisions on a research card (FR-19, KD-1, KD-2)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  Mode turn and decision turns: the mode is sent once, a decision turn leaves no trace in the feed and is not re-sent
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-19.1 (web half): "Given пользователь явно выбрал глубокое исследование для сообщения, When он его отправил, Then по нему запущено расследование этого пользователя в этой беседе, а беседа показывает, что оно идёт."
  // AC-19.3 (web half): "Given предложение показано, When пользователь подтвердил, Then запущено расследование с показанной целью и в пределах показанного бюджета, а беседа показывает, что оно идёт."
  // AC-19.4 (web half): "Given предложение показано, When пользователь отклонил его, Then расследование не запущено, а беседа продолжается как обычно."
  // AC-19.7 (web half): "Given предложение уже подтверждено, When пользователь подтверждает его повторно, Then новое расследование не запускается, и у этого предложения остаётся ровно одно расследование."
  // DC-1 (card half): "...ход решения ничего не меняет, а карточка переходит в текущее состояние запуска без строки ошибки."
  // DC-7: "Когда пользователь нажимает кнопку карточки, лента ни в одной вкладке и после перезагрузки не получает ни сообщения пользователя, ни реплики ассистента; меняется только карточка. Пока во вкладке стримится ответ, кнопки решений неактивны (UXRD KD-8)."
  // AC-27.1 (card half): "Given в развёртывании не подключён ни один источник данных, When агент предлагает глубокое исследование, Then вместе с целью и оценкой бюджета предложение предупреждает, что источники данных не подключены и ответ будет опираться на знания модели." (MC-31 on the proposal card)
  // AC-27.2 (card half): "Given в развёртывании не подключён ни один источник данных, When пользователь явно выбрал глубокое исследование и отправил сообщение, Then беседа показывает то же предупреждение там же, где показывает, что расследование идёт (AC-19.1), с момента запуска."
  // AC-27.4 (card half): "Given подключён хотя бы один источник, Then беседа не показывает предупреждения режима без источников ни в предложении, ни в идущем расследовании, ни в ответе."
  // DC-8 (FR-27, card half): "Пока у запуска нет расследования, карточка показывает MC-31 по режиму развёртывания в момент чтения; после старта — по режиму своего расследования, и рестарт с другим набором источников её не меняет." (the mode comes in the view; one thread with two cards of different modes is INT-5 P5)
  // Use cases: UC-1 (label and reset of the mode), UC-2 (second half, card side), UC-3 (second tab's card), UC-12 (card half), UC-E1 (card errors and the follow-up read). Flow 1 (card side), Flow 2, Flow 4 (card side). UXRD KD-1, KD-4, KD-8, KD-9, Error Flows (MC-15, MC-16, MC-29).
  //
  // Primary failure mode (turns red when): the mode is not in the sent message's metadata, or stays on for the next message; a button press adds a visible user message or a visible assistant reply, in this tab or after a reload; the turn that ended in a
  // `deepResearch` call is sent a second time by `sendAutomaticallyWhen`; a decision on a settled card shows an error line instead of the settled state; a turn that failed before the first chunk leaves an error stub in the feed or a disabled
  // button instead of MC-15 / MC-29 / MC-16; the TH-08 block stays on the errored reply after a decision turn; a research answer message is hidden by the rule that hides the decision reply; buttons stay active while an answer streams;
  // the card of a launch without sources loses MC-31 when the view passes from the tool result to the server read, or in a state of the decision turn (the warning is drawn only in the first state), or the explicit launch shows it only after the first
  // poll; the announcement of the start in that mode is the plain MC-17; a card with a source shows MC-31.
  // Behavior: user toggles DR-01 and sends -> POST /api/chat/assistant whose last message carries `deepResearch: true` -> reply with the `deepResearch` tool part -> card «Идёт»; user presses a card button -> the runtime appends a user message with
  //   `researchDecision` {action, launchKey} and the button's label -> POST /api/chat/assistant -> reply with the tool result (a ResearchLaunchView, or `decisionError`) -> only the card changes; GET /api/threads/:id/research is read once after the turn
  // @category: core-functionality
  // @dependency: ChatRuntimeProvider (toCreateMessage, sendAutomaticallyWhen), AssistantChatTransport, useChatRuntime (real), ResearchModeToggle, ResearchCard, useThreadResearch, ThreadMessage (hiding by metadata), MessageError, MSW (SSE v7)
  // @complexity: high
  //
  // Verification items (table; each row asserts the request bodies MSW received, the DOM, and the number of POST /api/chat requests):
  // - R1 mode (UC-1, AC-19.1): DR-01 pressed (`aria-pressed` true), message sent -> the last message of the body has `deepResearch: true` and a plain text part; the toggle is off again and the next body has no `deepResearch`; the sent message shows
  //   the DR-02 label and, after the thread is restored from history with that metadata, still shows it; the card of the reply is «Идёт»;
  //   with the tool result's view `sourceMode` `model_knowledge` the card carries MC-31 under the budget from its first display (before any GET /research) and the `status` announcement is the no-source variant of MC-17 (AC-27.2); with `sources` neither appears (AC-27.4)
  // - R2 decision turn leaves no trace (UC-2, DC-7, AC-19.3, AC-19.4): thread with a card «Ждёт подтверждения» -> «Запустить» -> exactly one more POST whose last message has `researchDecision` {confirm, launchKey of the card} and the text of the
  //   button label; the feed shows no new user message and no new reply; the card goes «Запуск» (button label «Запускаем…») while the turn runs and «Идёт» after; no second POST follows the reply; «Не нужно» on another card -> «Отклонение» then
  //   «Не запущен» with «Вы отказались.»; the thread restored from history with both hidden pairs (decision messages and replies marked `researchDecisionReply`) draws neither, and draws an answer message that follows a pair;
  //   with `sourceMode` `model_knowledge` in the history's view the proposal card shows MC-31 before «Запустить» (AC-27.1) and keeps it through «Запуск», «Идёт» and after the one GET /research that follows the turn; the declined card «Не запущен» keeps it too
  //   (the mode is read from the view each time, not from the first state); with `sources` none of the three states shows it (AC-27.4)
  // - R3 settled, failed and busy cards (UC-3, UC-E1, DC-1, AC-19.7): the tool result for a launch already running / not launched / failed -> the card shows that state, no error line (MC-15, MC-16, MC-29 absent); a decision turn answered with an HTTP 500
  //   before the first chunk -> no error stub and no TH-08 block in the feed, the card shows the line of its action (MC-15 / MC-29 / MC-16), buttons enabled again, and one GET /research afterwards moves the card to the applied state if the server reports it;
  //   a turn aborted from the composer behaves the same; an errored last reply loses its TH-08 block when the decision turn is sent; while a reply streams every decision button is disabled with the description MC-30 and no request is queued
  describe('INT-4', () => {
    it('INT-4 R1: the research mode is sent once in the message metadata, resets after the send, the launch label survives a reload, and a launch without sources shows its warning from the first display with the no-source announcement', async () => {
      // Arrange: three turns - a launch without sources, a plain message, a launch with a source
      const noSources = researchLaunchView({ launchKey: 'call-1', goal: GOAL_A, sourceMode: 'model_knowledge' });
      const withSources = researchLaunchView({ launchKey: 'call-2', goal: GOAL_B, sourceMode: 'sources' });
      const readAfterLaunch = deferred<ResearchLaunchView[]>();
      const traffic = serveThread({
        history: historyMessages([
          { role: 'user', text: 'Первый вопрос' },
          { role: 'assistant', text: 'Первый ответ' },
        ]),
        research: (read) => (read === 1 ? [] : read === 2 ? readAfterLaunch.promise : [noSources, withSources]),
        replies: [
          replyNow(toolReply({ messageId: 'r-1', toolCallId: 'call-1', goal: GOAL_A, result: { launch: noSources } })),
          () => sseFromChunks(assistantTextChunks('Обычный ответ', 'r-2')),
          replyNow(toolReply({ messageId: 'r-3', toolCallId: 'call-2', goal: GOAL_B, result: { launch: withSources } })),
        ],
      });
      const user = userEvent.setup();
      const view = renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await screen.findByText('Первый ответ');
      await waitFor(() => expect(traffic.researchReads).toBe(1));
      const toggle = screen.getByRole('button', { name: 'Глубокий ресерч' });
      const composer = () => screen.getByRole('textbox', { name: 'Сообщение' });

      // Act 1: the mode on, send
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
      expect(composer()).toHaveAttribute('placeholder', 'Опишите, что нужно исследовать…');
      expect(screen.getByRole('button', { name: 'Запустить ресерч' })).toBeInTheDocument();
      await user.type(composer(), 'Почему выросли расходы?{Enter}');
      const runningCard = await screen.findByRole('group', { name: `Ресерч: ${GOAL_A}` });

      // Assert 1: before the read after the turn returns, the card is «Идёт» with MC-31 and the no-source MC-17 sounded
      await waitFor(() => expect(traffic.researchReads).toBe(2));
      expect(within(runningCard).getByText('Ресерч идёт')).toBeInTheDocument();
      expect(within(runningCard).getByText(MC_31)).toBeInTheDocument();
      expect(statusText()).toContain(MC_17_NO_SOURCES);
      expect(lastMessageOf(traffic.chatBodies[0])).toMatchObject({
        role: 'user',
        parts: [{ type: 'text', text: 'Почему выросли расходы?' }],
        metadata: { deepResearch: true },
      });
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
      const launchMessage = feedRoots(view.container).find((root) => root.textContent?.includes('Почему выросли расходы?'));
      expect(launchMessage).toHaveTextContent('Глубокий ресерч');
      readAfterLaunch.resolve([noSources]);
      await waitFor(() => expect(traffic.researchReads).toBe(2));
      expect(within(card(GOAL_A)).getByText(MC_31)).toBeInTheDocument();

      // Act 2: a plain message - the mode stayed off
      await user.type(composer(), 'Просто вопрос{Enter}');
      await screen.findByText('Обычный ответ');
      // Act 3: the mode again, a launch with a source
      await user.click(toggle);
      await user.type(composer(), 'Как снизить задержки?{Enter}');
      const sourcedCard = await screen.findByRole('group', { name: `Ресерч: ${GOAL_B}` });

      // Assert 2: one request per send, the mode only where it was on, a sourced launch has no warning and the plain MC-17
      expect(traffic.chatBodies).toHaveLength(3);
      const second = lastMessageOf(traffic.chatBodies[1]);
      expect(second).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Просто вопрос' }] });
      expect(second).not.toHaveProperty(['metadata', 'deepResearch']);
      expect(lastMessageOf(traffic.chatBodies[2])).toMatchObject({ metadata: { deepResearch: true } });
      expect(within(sourcedCard).getByText('Ресерч идёт')).toBeInTheDocument();
      expect(within(sourcedCard).queryByText(MC_31)).toBeNull();
      await waitFor(() => expect(statusText()).toContain(MC_17));
      const plainMessage = feedRoots(view.container).find((root) => root.textContent?.includes('Просто вопрос'));
      expect(plainMessage).not.toHaveTextContent('Глубокий ресерч');

      // Act 4: reload - the thread restored from history with the mode's metadata
      view.unmount();
      serveThread({
        history: [
          ...historyMessages([{ role: 'user', text: 'Первый вопрос' }]),
          {
            id: 'u-launch',
            role: 'user',
            metadata: { [RESEARCH_METADATA_KEYS.deepResearch]: true },
            parts: [{ type: 'text', text: 'Почему выросли расходы?' }],
          },
          cardMessage('r-1', noSources),
        ],
        research: () => [noSources],
        replies: [],
      });
      const reloaded = renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await screen.findByRole('group', { name: `Ресерч: ${GOAL_A}` });

      // Assert 3: the label survives the reload, on the launch message only
      const restored = feedRoots(reloaded.container).filter((root) => root.dataset.role === 'user');
      expect(restored.map((root) => root.textContent?.includes('Глубокий ресерч'))).toEqual([false, true]);
    });

    it.each<{ sourceMode: ResearchSourceMode; warned: boolean }>([
      { sourceMode: 'model_knowledge', warned: true },
      { sourceMode: 'sources', warned: false },
    ])(
      'INT-4 R2 ($sourceMode): confirm and decline send one hidden decision turn each, add nothing to the feed in the tab or after a reload, do not re-send the turn that ended in deepResearch, and move only the card, which keeps its no-source warning in every state and shows none when a source is connected',
      async ({ sourceMode, warned }) => {
        // Arrange: two proposal cards in one thread
        const proposalA = researchLaunchView({ launchKey: 'call-a', mode: 'proposal', state: 'proposed', goal: GOAL_A, sourceMode });
        const proposalB = researchLaunchView({ launchKey: 'call-b', mode: 'proposal', state: 'proposed', goal: GOAL_B, sourceMode });
        const runningA = { ...proposalA, state: 'running' as const };
        const declinedB = { ...proposalB, state: 'not_launched' as const, notLaunchedReason: 'declined' as const };
        const confirmGate = deferred();
        const declineGate = deferred();
        let server_: ResearchLaunchView[] = [proposalA, proposalB];
        const traffic = serveThread({
          history: [
            ...historyMessages([{ role: 'user', text: 'Вопрос про расходы' }]),
            cardMessage('a-1', proposalA),
            { id: 'u-2', role: 'user', parts: [{ type: 'text', text: 'Вопрос про задержки' }] },
            cardMessage('a-2', proposalB),
          ],
          research: () => server_,
          replies: [
            replyHeld(
              toolReply({ messageId: 'd-1', toolCallId: 'd-call-1', goal: GOAL_A, result: { launch: runningA }, decisionReplyOf: 'call-a' }),
              confirmGate,
            ),
            replyHeld(
              toolReply({ messageId: 'd-2', toolCallId: 'd-call-2', goal: GOAL_B, result: { launch: declinedB }, decisionReplyOf: 'call-b' }),
              declineGate,
            ),
          ],
        });
        const user = userEvent.setup();
        const view = renderWithRuntime({ pathname: `/chat/${THREAD}` });
        await screen.findByRole('group', { name: `Ресерч: ${GOAL_A}` });
        await waitFor(() => expect(traffic.researchReads).toBe(1));
        const feedBefore = feedRoots(view.container).map((root) => root.id);
        expect(feedBefore).toEqual(['m1', 'a-1', 'u-2', 'a-2']);
        expect(within(card(GOAL_A)).queryByText(MC_31) !== null).toBe(warned);

        // Act 1: «Запустить», the reply held mid-stream
        await user.click(within(card(GOAL_A)).getByRole('button', { name: 'Запустить' }));
        await waitFor(() => expect(traffic.chatBodies).toHaveLength(1));

        // Assert 1: «Запуск» while the turn streams; the decision and its streaming reply are not drawn
        expect(await within(card(GOAL_A)).findByRole('button', { name: 'Запускаем…' })).toBeInTheDocument();
        expect(within(card(GOAL_A)).queryByText(MC_31) !== null).toBe(warned);
        expect(lastMessageOf(traffic.chatBodies[0])).toMatchObject({
          role: 'user',
          parts: [{ type: 'text', text: 'Запустить' }],
          metadata: { [RESEARCH_METADATA_KEYS.researchDecision]: { action: 'confirm', launchKey: 'call-a' } },
        });
        await waitFor(() => expect(view.container.querySelector('[data-role="assistant"][id="d-1"]')).toBeNull());
        expect(feedRoots(view.container).map((root) => root.id)).toEqual(feedBefore);

        // Act 2: the reply ends; the server now reports the launch running
        server_ = [runningA, proposalB];
        confirmGate.resolve();

        // Assert 2: «Идёт», one read after the turn, no second POST, nothing new in the feed
        await waitFor(() => expect(within(card(GOAL_A)).getByText('Ресерч идёт')).toBeInTheDocument());
        await waitFor(() => expect(traffic.researchReads).toBe(2));
        expect(traffic.chatBodies).toHaveLength(1);
        expect(within(card(GOAL_A)).queryByText(MC_31) !== null).toBe(warned);
        expect(feedRoots(view.container).map((root) => root.id)).toEqual(feedBefore);

        // Act 3: «Не нужно» on the other card
        await user.click(within(card(GOAL_B)).getByRole('button', { name: 'Не нужно' }));
        expect(await within(card(GOAL_B)).findByRole('button', { name: 'Отклоняем…' })).toBeInTheDocument();
        server_ = [runningA, declinedB];
        declineGate.resolve();

        // Assert 3: «Не запущен» with its reason, warning per mode, still no trace in the feed, one read after the turn
        await waitFor(() => expect(within(card(GOAL_B)).getByText('Ресерч не запущен')).toBeInTheDocument());
        expect(within(card(GOAL_B)).getByText('Вы отказались.')).toBeInTheDocument();
        expect(within(card(GOAL_B)).queryByText(MC_31) !== null).toBe(warned);
        await waitFor(() => expect(traffic.researchReads).toBe(3));
        expect(traffic.chatBodies).toHaveLength(2);
        expect(lastMessageOf(traffic.chatBodies[1])).toMatchObject({
          parts: [{ type: 'text', text: 'Не нужно' }],
          metadata: { [RESEARCH_METADATA_KEYS.researchDecision]: { action: 'decline', launchKey: 'call-b' } },
        });
        expect(feedRoots(view.container).map((root) => root.id)).toEqual(feedBefore);

        // Act 4: reload - both hidden pairs stored, an answer of A after the last pair
        view.unmount();
        const completedA = { ...runningA, state: 'completed' as const, answerMessageId: 'answer-a' };
        serveThread({
          history: [
            ...historyMessages([{ role: 'user', text: 'Вопрос про расходы' }]),
            cardMessage('a-1', proposalA),
            { id: 'u-2', role: 'user', parts: [{ type: 'text', text: 'Вопрос про задержки' }] },
            cardMessage('a-2', proposalB),
            ...researchDecisionPair({ idPrefix: 'p-1', decision: { action: 'confirm', launchKey: 'call-a' }, launch: runningA }),
            ...researchDecisionPair({ idPrefix: 'p-2', decision: { action: 'decline', launchKey: 'call-b' }, launch: declinedB }),
            researchAnswerMessage({ id: 'answer-a', answer: { launchKey: 'call-a', sourceMode } }),
          ],
          research: () => [completedA, declinedB],
          replies: [],
        });
        const reloaded = renderWithRuntime({ pathname: `/chat/${THREAD}` });
        await screen.findByRole('group', { name: `Ресерч: ${GOAL_A}` });

        // Assert 4: neither pair is drawn, the answer after the pair is, and the cards keep their states and warnings
        await waitFor(() => expect(feedRoots(reloaded.container).map((root) => root.id)).toEqual([...feedBefore, 'answer-a']));
        expect(screen.getAllByRole('group', { name: /^Ресерч: / })).toHaveLength(2);
        await waitFor(() => expect(within(card(GOAL_A)).getByText('Ресерч завершён')).toBeInTheDocument());
        expect(within(card(GOAL_B)).getByText('Ресерч не запущен')).toBeInTheDocument();
        expect(screen.queryAllByText(MC_31)).toHaveLength(warned ? 2 : 0);
      },
    );

    it.each<{ name: string; result: ResearchLaunchView; label: string }>([
      {
        name: 'already running',
        result: researchLaunchView({ launchKey: 'call-a', mode: 'proposal', goal: GOAL_A }),
        label: 'Ресерч идёт',
      },
      {
        name: 'not launched',
        result: researchLaunchView({ launchKey: 'call-a', mode: 'proposal', goal: GOAL_A, state: 'not_launched', notLaunchedReason: 'superseded' }),
        label: 'Ресерч не запущен',
      },
      {
        name: 'failed',
        result: researchLaunchView({ launchKey: 'call-a', mode: 'proposal', goal: GOAL_A, state: 'failed' }),
        label: 'Ресерч не удался',
      },
    ])('INT-4 R3 (settled card, $name): a decision on a settled launch moves the card to that state without an error line', async ({ result, label }) => {
      // Arrange: this tab still shows the proposal; the launch was settled elsewhere
      const proposal = researchLaunchView({ launchKey: 'call-a', mode: 'proposal', state: 'proposed', goal: GOAL_A });
      let server_: ResearchLaunchView[] = [proposal];
      const traffic = serveThread({
        history: [...historyMessages([{ role: 'user', text: 'Вопрос' }]), cardMessage('a-1', proposal)],
        research: () => server_,
        replies: [
          replyNow(toolReply({ messageId: 'd-1', toolCallId: 'd-call', goal: GOAL_A, result: { launch: result }, decisionReplyOf: 'call-a' })),
        ],
      });
      const user = userEvent.setup();
      renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await screen.findByRole('group', { name: `Ресерч: ${GOAL_A}` });
      await waitFor(() => expect(traffic.researchReads).toBe(1));
      server_ = [result];

      // Act
      await user.click(within(card(GOAL_A)).getByRole('button', { name: 'Запустить' }));

      // Assert
      await waitFor(() => expect(within(card(GOAL_A)).getByText(label)).toBeInTheDocument());
      await waitFor(() => expect(traffic.researchReads).toBe(2));
      expect(within(card(GOAL_A)).queryByRole('alert')).toBeNull();
      for (const line of [MC_15, MC_16, MC_29]) expect(screen.queryByText(line)).toBeNull();
      expect(traffic.chatBodies).toHaveLength(1);
    });

    it.each<{ action: string; button: string; start: 'proposed' | 'running'; line: string; applied: string }>([
      { action: 'confirm', button: 'Запустить', start: 'proposed', line: MC_15, applied: 'Ресерч идёт' },
      { action: 'decline', button: 'Не нужно', start: 'proposed', line: MC_29, applied: 'Ресерч не запущен' },
      { action: 'stop', button: 'Остановить', start: 'running', line: MC_16, applied: 'Ресерч остановлен' },
    ])(
      'INT-4 R3 (failed $action): a decision turn that fails before streaming or is aborted shows the card error and no stub or error block in the feed, and the read after it moves the card to the applied state',
      async ({ button, start, line, applied }) => {
        // Arrange: one card; the first decision turn answers 500 before any chunk, the second is aborted mid-stream
        const before = researchLaunchView({
          launchKey: 'call-a',
          mode: start === 'proposed' ? 'proposal' : 'explicit',
          state: start,
          goal: GOAL_A,
        });
        const appliedView: ResearchLaunchView =
          applied === 'Ресерч идёт'
            ? { ...before, state: 'running' }
            : applied === 'Ресерч не запущен'
              ? { ...before, state: 'not_launched', notLaunchedReason: 'declined' }
              : { ...before, state: 'stopped' };
        const abortedGate = deferred();
        let server_: ResearchLaunchView[] = [before];
        const traffic = serveThread({
          history: [...historyMessages([{ role: 'user', text: 'Вопрос' }]), cardMessage('a-1', before)],
          research: () => server_,
          replies: [
            () => HttpResponse.json({ message: 'provider unavailable' }, { status: 500 }),
            () => heldStream([{ type: 'start', messageId: 'd-2', messageMetadata: { researchDecisionReply: { launchKey: 'call-a' } } }], abortedGate, []),
          ],
        });
        const user = userEvent.setup();
        const view = renderWithRuntime({ pathname: `/chat/${THREAD}` });
        await screen.findByRole('group', { name: `Ресерч: ${GOAL_A}` });
        await waitFor(() => expect(traffic.researchReads).toBe(1));
        const feedBefore = feedRoots(view.container).map((root) => root.id);
        const press = async () => {
          await user.click(within(card(GOAL_A)).getByRole('button', { name: button }));
          // «Остановить» asks first (MC-9); its confirming button carries the same name.
          if (button === 'Остановить') {
            await user.click(within(card(GOAL_A)).getAllByRole('button', { name: 'Остановить' })[0]);
          }
        };

        // Act 1: the turn fails before its first chunk
        await press();

        // Assert 1: the card's line, buttons enabled, no stub and no TH-08 block; one read after the turn
        expect(await within(card(GOAL_A)).findByRole('alert')).toHaveTextContent(line);
        await waitFor(() => expect(traffic.researchReads).toBe(2));
        expect(view.container.querySelectorAll('[data-slot="message-error"]')).toHaveLength(0);
        expect(feedRoots(view.container).map((root) => root.id)).toEqual(feedBefore);
        expect(within(card(GOAL_A)).getByRole('button', { name: button })).not.toHaveAttribute('aria-disabled', 'true');

        // Act 2: the next try is aborted from the composer while it streams; the server applied it before the abort
        await press();
        await waitFor(() => expect(traffic.chatBodies).toHaveLength(2));
        server_ = [appliedView];
        const composerForm = screen.getByRole('textbox', { name: 'Сообщение' }).closest('form');
        if (composerForm === null) throw new Error('the composer is not a form');
        await user.click(await within(composerForm).findByRole('button', { name: 'Остановить' }));
        abortedGate.resolve();

        // Assert 2: the read after the aborted turn moves the card to the applied state, without an error line
        await waitFor(() => expect(within(card(GOAL_A)).getByText(applied)).toBeInTheDocument());
        await waitFor(() => expect(traffic.researchReads).toBe(3));
        expect(within(card(GOAL_A)).queryByRole('alert')).toBeNull();
        expect(view.container.querySelectorAll('[data-slot="message-error"]')).toHaveLength(0);
        expect(feedRoots(view.container).map((root) => root.id)).toEqual(feedBefore);
        expect(traffic.chatBodies).toHaveLength(2);
      },
    );

    it('INT-4 R3 (busy and stale error): buttons are disabled with MC-30 while a reply streams and queue nothing, and a decision turn removes the TH-08 block of the errored reply', async () => {
      // Arrange: a proposal card; the first message errors, the second streams under a latch, then a decision
      const proposal = researchLaunchView({ launchKey: 'call-a', mode: 'proposal', state: 'proposed', goal: GOAL_A });
      const running = { ...proposal, state: 'running' as const };
      const streamGate = deferred();
      const traffic = serveThread({
        history: [...historyMessages([{ role: 'user', text: 'Вопрос' }]), cardMessage('a-1', proposal)],
        research: (read) => (read <= 1 ? [proposal] : [running]),
        replies: [
          () =>
            heldStream(
              [{ type: 'start', messageId: 'r-held' }, { type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: 'Пишу' }],
              streamGate,
              [{ type: 'text-end', id: 't1' }, { type: 'finish' }],
            ),
          () =>
            sseFromChunks([
              { type: 'start', messageId: 'r-err' },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'Частичный' },
              { type: 'error', errorText: 'Agent error' },
            ]),
          replyNow(toolReply({ messageId: 'd-1', toolCallId: 'd-call', goal: GOAL_A, result: { launch: running }, decisionReplyOf: 'call-a' })),
        ],
      });
      const user = userEvent.setup();
      const view = renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await screen.findByRole('group', { name: `Ресерч: ${GOAL_A}` });
      await waitFor(() => expect(traffic.researchReads).toBe(1));
      const composer = () => screen.getByRole('textbox', { name: 'Сообщение' });

      // Act 1: a reply streams; the user presses «Запустить»
      await user.type(composer(), 'Ещё вопрос{Enter}');
      await screen.findByText('Пишу');
      const confirm = within(card(GOAL_A)).getByRole('button', { name: 'Запустить' });
      await user.click(confirm);

      // Assert 1: every decision button is disabled with MC-30; the press is not queued
      expect(confirm).toHaveAttribute('aria-disabled', 'true');
      expect(confirm).toHaveAccessibleDescription(MC_30);
      expect(within(card(GOAL_A)).getByRole('button', { name: 'Не нужно' })).toHaveAccessibleDescription(MC_30);
      streamGate.resolve();
      await screen.findByText('Пишу');
      await waitFor(() => expect(confirm).not.toHaveAttribute('aria-disabled', 'true'));
      expect(traffic.chatBodies).toHaveLength(1);

      // Act 2: the next reply errors - TH-08 under it; then the card's decision
      await user.type(composer(), 'Ещё раз{Enter}');
      expect(await screen.findByText('Не удалось получить ответ. Попробуйте перегенерировать.')).toBeInTheDocument();
      await user.click(within(card(GOAL_A)).getByRole('button', { name: 'Запустить' }));

      // Assert 2: the block leaves the errored reply, its partial text stays, the card runs, the feed gains nothing
      await waitFor(() => expect(within(card(GOAL_A)).getByText('Ресерч идёт')).toBeInTheDocument());
      expect(view.container.querySelectorAll('[data-slot="message-error"]')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Перегенерировать' })).toBeNull();
      expect(screen.getByText('Частичный')).toBeInTheDocument();
      expect(feedRoots(view.container).map((root) => root.id).filter((id) => id.startsWith('d-'))).toEqual([]);
      expect(traffic.chatBodies).toHaveLength(3);
      expect(lastMessageOf(traffic.chatBodies[2])).toMatchObject({
        metadata: { [RESEARCH_METADATA_KEYS.researchDecision]: { action: 'confirm', launchKey: 'call-a' } },
      });
    });
  });
});
