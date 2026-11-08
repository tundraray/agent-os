// deep-research / chat-entry (web) Integration Test Skeletons - Design Doc: docs/features/deep-research/design-chat-entry.md (C3 web: «опрос и ответ», KD-6, Flow 3, Flow 5)
// PRD: docs/features/deep-research/prd.md v1.12 (FR-20, FR-21, FR-27). UXRD: docs/features/deep-research/uxrd.md v1.7 (DR-03, DR-04, KD-5, KD-9, MC-10, MC-11, MC-12, MC-18, MC-23, MC-31, MC-32, MC-33).
// Generated: 2026-11-01 | Updated: 2026-11-01 for the no-source mode (Design Doc v1.6: KD-8, DC-8, DC-9, UC-4, UC-12, UC-13, UC-E8) | Part: chat-entry | Test type: Integration (Vitest + RTL + MSW 2 + fake timers, jsdom, REAL useChatRuntime / AI SDK Chat) | Budget slot: INT-5 of the part (extra: see the unique defect below)
// Implementation timing: created alongside the web slice that adds useThreadResearch, ResearchAnswer and the append of missing answers.
//
// File name and placement follow the sibling files `shell.<topic>.int.test.tsx` in this folder. The measured figure of NFR-01 (5 s, with and without a streaming reply) is the L1 scenario (E2E-2): jsdom with fake timers proves the
// mechanism (which requests are made, when, and what is drawn), not wall-clock time.
//
// Why integration and not the component test: the answer reaches the feed without a turn, so it is added to the messages the real runtime holds while a chat may be streaming into the same list. Whether the runtime accepts a message added
//   this way, keeps the order, and does not start a turn is a property of useChatRuntime and the AI SDK that only the real runtime shows; a store test with a fake runtime cannot turn red when an upgrade breaks it.
//
// Harness (src/test/): as shell.research-decisions.int.test.tsx; polling is driven by vi.useFakeTimers() with `shouldAdvanceTime` off and the period of `useThreadResearch` (2 000 ms, a constant of apps/web next to the title polling settings).
// Mock boundary: network only (MSW) + next/navigation + timers (+ a `navigator.clipboard.writeText` stub in P5, a browser API boundary). useThreadResearch, ThreadsApiClient, ResearchCard, ResearchAnswer, ThreadMessage, runtime - real.
//
// Unique defect no other test catches (why this is an extra slot): the api rows prove that the answer is stored and listed; nothing else proves that an open tab fetches the missing answer, appends it at the end of the feed without a turn
// and not in the middle of a stream, keeps polling exactly as long as something is pending, and shows the card states without a reload. Without it the user sees «Завершён» with a link to a message that is not in the feed.

import {
  RESEARCH_METADATA_KEYS,
  type DeepResearchToolResult,
  type HistoryMessage,
  type ResearchAnswerMetadata,
  type ResearchLaunchView,
} from '@agent-os/contracts';
import { act, fireEvent, screen, within } from '@testing-library/react';
import type { UIMessageChunk } from 'ai';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RESEARCH_POLL_INTERVAL_MS } from '@/lib/threads/research-poll';
import {
  assistantTextChunks,
  deepResearchToolPart,
  deferred,
  researchDecisionPair,
  researchAnswerMessage,
  researchLaunchView,
  sseFromChunks,
  threadList,
  threadResearch,
  threadSummary,
  type Deferred,
} from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';
const THREAD = 'a';
const GOAL_A = 'Почему выросли расходы на облако';
const GOAL_B = 'Как снизить задержки API';
const GOAL_C = 'Что с резервными копиями';
const ANSWER_A = 'research-answer-inv-a';
const ANSWER_B = 'research-answer-inv-b';

const MC_12 = 'Ответа не будет. Чтобы попробовать снова, отправьте вопрос в режиме „Глубокий ресерч“.';
const MC_15 = 'Не удалось запустить ресерч. Попробуйте ещё раз.';
const MC_18 = 'Ресерч завершён. Ответ добавлен в конец беседы.';
const MC_18_NO_SOURCES = 'Ресерч завершён. Ответ из знаний модели добавлен в конец беседы.';
const MC_31 = 'Источники данных не подключены — ответ будет из знаний модели.';
const MC_32 = 'Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.';
const MC_33 = 'из знаний модели, без источника';

type ChatReply = (body: unknown) => Response | Promise<Response>;

/** What MSW received; every counter belongs to one test. The first GET /messages is the history load. */
type Traffic = { chatBodies: unknown[]; researchReads: number; messageReads: number };

/**
 * Serves thread `a`: its summary, its messages and its research list (functions of the read number, so a test changes
 * what the next read returns), and the chat turns, answered in order by `replies`.
 */
function serveThread({
  messages,
  research,
  replies = [],
}: {
  messages: (read: number) => HistoryMessage[];
  research: (read: number) => ResearchLaunchView[];
  replies?: ChatReply[];
}): Traffic {
  const traffic: Traffic = { chatBodies: [], researchReads: 0, messageReads: 0 };
  server.use(
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([threadSummary({ id: THREAD, title: 'Беседа A' })]))),
    http.get(`${API}/api/threads/${THREAD}`, () => HttpResponse.json(threadSummary({ id: THREAD, title: 'Беседа A' }))),
    http.get(`${API}/api/threads/${THREAD}/messages`, () => {
      traffic.messageReads += 1;
      return HttpResponse.json({ messages: messages(traffic.messageReads) });
    }),
    http.get(`${API}/api/threads/${THREAD}/research`, () => {
      traffic.researchReads += 1;
      return HttpResponse.json(threadResearch(research(traffic.researchReads)));
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

// The clock moves only when a test says so: `settle` lets the network and React run with the clock standing, and
// `nextPeriod` moves it by one poll period. RTL's `waitFor` / `findBy*` wait on the faked `setTimeout`; `until` replaces them.

/** Lets the network, React and the timers already due run, without moving the clock. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

/** Settles until `check` passes; the clock stands still, so no poll period passes while waiting. */
async function until(check: () => void): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      check();
      return;
    } catch {
      await settle();
    }
  }
  check();
}

/** Settles long enough for anything already started to finish, so the caller can assert that nothing more happened. */
async function quiet(): Promise<void> {
  for (let round = 0; round < 20; round += 1) await settle();
}

async function nextPeriod(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RESEARCH_POLL_INTERVAL_MS);
  });
  await settle();
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
function toolReplyChunks({
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
}): UIMessageChunk[] {
  return [
    decisionReplyOf === undefined
      ? { type: 'start', messageId }
      : {
          type: 'start',
          messageId,
          messageMetadata: { [RESEARCH_METADATA_KEYS.researchDecisionReply]: { launchKey: decisionReplyOf } },
        },
    { type: 'tool-input-available', toolCallId, toolName: 'deepResearch', input: { goal } },
    { type: 'tool-output-available', toolCallId, output: result },
    { type: 'finish' },
  ];
}

/** A user message sent in the research mode: the launch message of an explicit research. */
function launchMessage(id: string, text: string): HistoryMessage {
  return { id, role: 'user', metadata: { [RESEARCH_METADATA_KEYS.deepResearch]: true }, parts: [{ type: 'text', text }] };
}

const userMessage = (id: string, text: string): HistoryMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const assistantMessage = (id: string, text: string): HistoryMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
});

/** A restored assistant message holding the card of one launch: its `deepResearch` call and result. */
function cardMessage(id: string, launch: ResearchLaunchView): HistoryMessage {
  return {
    id,
    role: 'assistant',
    parts: [deepResearchToolPart({ toolCallId: launch.launchKey, goal: launch.goal, result: { launch } })],
  };
}

/** An answer message as the delivery loop stores it. */
function answerMessage(
  id: string,
  answer: Partial<ResearchAnswerMetadata> & Pick<ResearchAnswerMetadata, 'launchKey'>,
  text?: string,
): HistoryMessage {
  return researchAnswerMessage({ id, text, answer });
}

/** The drawn feed: the id of every user and assistant message root, in order. */
function feedIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-role="user"], [data-role="assistant"]')).map(
    (root) => root.id,
  );
}

function messageRoot(container: HTMLElement, id: string): HTMLElement {
  const root = container.querySelector<HTMLElement>(`[data-role][id="${id}"]`);
  if (root === null) throw new Error(`no message ${id} in the feed`);
  return root;
}

const card = (goal: string) => screen.getByRole('group', { name: `Ресерч: ${goal}` });
/** Every text the polite regions announce now: one per announcement span, or the region's own text. */
const statusText = () =>
  screen
    .getAllByRole('status')
    .flatMap((region) =>
      region.children.length > 0
        ? Array.from(region.children, (child) => child.textContent ?? '')
        : [region.textContent ?? ''],
    );
const composer = () => screen.getByRole('textbox', { name: 'Сообщение' });

// user-event and RTL's async helpers drain on the faked `setTimeout`, so interactions are dispatched directly.
function click(element: HTMLElement): void {
  act(() => {
    fireEvent.click(element);
  });
}

/** Types `text` into the composer and sends it with «Отправить». */
function sendMessage(text: string): void {
  act(() => {
    fireEvent.change(composer(), { target: { value: text } });
  });
  click(screen.getByRole('button', { name: 'Отправить' }));
}

beforeEach(() => {
  // Only the timers the poll runs on; the network, React's scheduler and `Date` stay real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // handleChatError and the research store log failures; the tests assert what the user sees instead.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Shell: polling the research state and appending the answer in the open thread (FR-20, FR-21, KD-6)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-5  Polling and answer append: the card follows the server, the answer joins the feed after any running stream, and polling stops with the last pending launch
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-20.1 (web half): "Given беседа открыта, When расследование завершено, Then ответ появляется в беседе без перезагрузки страницы (NFR-01), и беседа больше не показывает, что это расследование идёт."
  // AC-20.3 (web half): "Given в момент завершения расследования в беседе стримится другой ответ, Then ответ расследования показан отдельным сообщением и не склеен со стримящимся ни вживую, ни после перезагрузки."
  // AC-20.4 (web half): "Given расследование завершилось ошибкой, Then беседа показывает, что оно не удалось, и больше не показывает, что оно идёт."
  // AC-21.1 (card half): "...беседа показывает, что расследование остановлено, а ответ не дописывается."
  // AC-20.6 (links): "...каждый ответ ссылается на своё сообщение-запуск." (the «К запросу» anchor of each answer points at its own launch message)
  // AC-20.7 (web half): "Given в развёртывании подключён хотя бы один источник данных, и ответ дописан, Then у каждого его утверждения в беседе видно, на какое evidence оно опирается (AC-09.2)." (footnotes and the source list drawn from the appended message)
  // AC-27.3 (web half): "Given в беседу дописан ответ расследования в режиме без источников, Then беседа показывает предупреждение ответа и пометку знаний модели у каждого утверждения (AC-25.1, AC-25.2), в том числе после перезагрузки."
  // AC-27.4 (web half): "Given подключён хотя бы один источник, Then беседа не показывает предупреждения режима без источников ни в предложении, ни в идущем расследовании, ни в ответе."
  // DC-8 (FR-27, web half): "Пока у запуска нет расследования, карточка показывает MC-31 по режиму развёртывания в момент чтения; после старта — по режиму своего расследования, и рестарт с другим набором источников её не меняет." (here: one thread, two launches of different modes)
  // DC-9 (FR-27, web half): "Текстовая часть ответа в режиме без источников начинается с MC-32 и несёт MC-33 после каждого утверждения, поэтому «Копировать» и модель в следующих ходах получают ту же оговорку." (the stored text is INT-2 D5; here what the copy action takes from the appended message)
  // DC-5 (web half): "...этот ответ дописывается снова после перегенерированного ответа, а его карточка остаётся «Завершён»."
  // NFR-01 (mechanism only): "ответ ... появляется в открытой беседе не позже чем через 5 с после завершения. Если в этот момент в беседе стримится обычный ответ ..., 5 с отсчитываются от конца этого стрима."
  // Use cases: UC-4 (with a fixture connected), UC-E3, UC-E4 (card side), UC-E7 (web side), UC-E8 (web side), UC-9 (open tab), UC-12 (answer half), UC-13, UC-N1 (mechanism). Flow 3 (last two arrows), Flow 5 (outcome). KD-5 and KD-9 of the UXRD (scroll and focus rules, and what a claim looks like without a source, are component concerns).
  //
  // Primary failure mode (turns red when): the poll runs when no launch is pending, or does not run while one is `running` or `completed` with `answerPending`; a completed launch whose answer is missing from the feed is never fetched, or is fetched
  // and inserted in the middle of the streaming reply, or starts a chat turn; the answer is appended twice (a poll and a later history read); the card says «Завершён» with a link to a missing message; a failed or stopped launch draws an answer;
  // the poll is not read once after a turn that ended in a `deepResearch` call or after a failed decision turn;
  // an answer appended by the poll in a thread without sources is drawn with footnotes or «не проверено» labels (the message loses `sourceMode` on the way from GET /messages to the runtime), or differently from the same message restored from history;
  // one thread-wide mode replaces the mode of each launch (a card of a research that started without sources loses MC-31 after a restart with a source, or a card started with one gains it); an answer with a source shows MC-32 or MC-33;
  // the copy action takes something other than the stored text (the caveat is lost).
  // Behavior: thread opened with a `running` card -> useThreadResearch reads GET /api/threads/:id/research every period -> a launch turns `completed` with `answerMessageId` that the feed lacks -> the tab waits for the end of its own stream,
  //   reads GET /api/threads/:id/messages and appends the missing answer messages to the end of the feed -> the card shows «Завершён» with «К ответу»; no POST /api/chat is made; the poll stops when nothing is pending
  // @category: core-functionality
  // @dependency: useThreadResearch, ThreadsApiClient (research and messages), ResearchCard, ResearchAnswer, ThreadMessage, useChatRuntime (real, message append), MSW, fake timers
  // @complexity: high
  //
  // Verification items (table; each row counts the requests MSW received per period):
  // - P1 lifecycle (UC-4, AC-20.1, AC-20.4, AC-21.1 card half): `running` card -> GET /research once per period; the launch turns `completed` with an `answerMessageId` that the feed lacks -> one GET /messages, the answer is the last message of the feed
  //   (its `researchAnswer` rendered as DR-04: goal, outcome, groups, footnotes, source list), the card is «Завершён» with «К ответу» and the answer's header has «К запросу» pointing at the launch message; no POST /api/chat; after that no more
  //   GET /research; a second launch ending `failed` shows «Не удался» and `stopped` shows «Остановлен», and neither fetches messages;
  //   with `sourceMode` `sources` (UC-4, AC-20.7, AC-27.4) the card and the answer carry none of MC-31, MC-32, MC-33, every claim has its footnote, and the `status` announcement is the plain MC-18
  // - P2 running stream (UC-E3, AC-20.3, UC-N1 mechanism): a reply is streaming (the SSE body is held by a latch) when the poll reports the launch `completed` -> no GET /messages and no insertion until the stream ends; after it ends the answer is
  //   appended after the finished reply as a separate message (the text of the reply and of the answer are not merged); a reload (the history with both) draws the same order
  // - P3 answer taken away and returned (UC-9 open tab, DC-5): a launch `completed` with `answerPending: true` -> polling continues, the card is «Завершён» without «К ответу»; when the server reports `answerMessageId`, the answer is appended
  //   once after the regenerated reply; a launch that turns `failed` while pending shows «Не удался» (MC-12)
  // - P4 decision turn that left no reply (UC-E7 web side): thread whose stored tail is a decision message with no reply -> the decision message is not drawn; the answer that arrives is drawn at the end of the feed; and one GET /research is
  //   read after each turn that ended in a `deepResearch` call or in a failed decision turn even when nothing is pending
  // - P5 answers without sources (UC-12 answer half, UC-13, AC-27.3, AC-27.4, DC-8, DC-9; unique defect: the mode lost between the server message and the drawn answer, or one mode for the whole thread - both visible only when the message arrives
  //   through the poll into the real runtime and a second launch of another mode sits in the same list): GET /research lists a `running` launch with `sourceMode` `model_knowledge`; it turns `completed` and GET /messages returns its answer
  //   (`researchAnswer.sourceMode` `model_knowledge`, two claims without footnote numbers, text opening with MC-32 and carrying MC-33 after each claim) -> the answer is the last message, drawn with MC-32 under the goal line, MC-33 after each claim, no footnotes,
  //   no «не проверено» label and no source list; the card is «Завершён» with MC-31; the `status` announcement is the no-source variant of MC-18; the copy action of the answer hands the clipboard stub the stored text with MC-32 and both MC-33;
  //   a thread restored from history with the same message draws the same (AC-27.3 after a reload).
  //   Mixed thread (UC-13, DC-8): the same list holds a `proposed` launch with `sourceMode` `sources` (the process was restarted with a source) beside the `model_knowledge` running one -> the proposal card has no MC-31, the running card has it, and once that
  //   launch is answered its answer has MC-32 and MC-33 while a later `sources` answer of the proposal confirmed afterwards has footnotes and none of the three.
  describe('INT-5', () => {
    it('INT-5 P1: a running card is polled each period, a finished launch whose answer is missing is fetched and appended last without starting a turn, polling then stops, and failed or stopped launches add no answer', async () => {
      // Arrange: three explicit launches running, all with a source
      const runningA = researchLaunchView({ launchKey: 'call-a', goal: GOAL_A });
      const runningB = researchLaunchView({ launchKey: 'call-b', goal: GOAL_B });
      const runningC = researchLaunchView({ launchKey: 'call-c', goal: GOAL_C });
      const history = [
        launchMessage('u-a', 'Почему выросли расходы?'),
        cardMessage('r-a', runningA),
        launchMessage('u-b', 'Как снизить задержки?'),
        cardMessage('r-b', runningB),
        launchMessage('u-c', 'Что с бэкапами?'),
        cardMessage('r-c', runningC),
      ];
      const answer = answerMessage(
        ANSWER_A,
        { launchKey: 'call-a', goal: GOAL_A, launch: { messageId: 'u-a' } },
        'Текстовая часть ответа для модели',
      );
      const traffic = serveThread({
        messages: (read) => (read === 1 ? history : [...history, answer]),
        research: (read) =>
          read < 3
            ? [runningA, runningB, runningC]
            : [
                { ...runningA, state: 'completed', answerMessageId: ANSWER_A },
                { ...runningB, state: 'failed' },
                { ...runningC, state: 'stopped' },
              ],
      });
      const view = renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await until(() => expect(within(card(GOAL_A)).getByText('Ресерч идёт')).toBeInTheDocument());
      await until(() => expect(traffic.researchReads).toBe(1));

      // Act 1: one period - the launches are still running
      await nextPeriod();

      // Assert 1: one read per period, nothing else
      await until(() => expect(traffic.researchReads).toBe(2));
      expect(traffic.messageReads).toBe(1);

      // Act 2: the next period reports, in one read, A completed, B failed and C stopped
      await nextPeriod();

      // Assert 2: all three events are announced together, none replacing another
      await until(() => expect(statusText()).toEqual(expect.arrayContaining([MC_18, 'Ресерч не удался', 'Ресерч остановлен'])));
      expect(within(card(GOAL_B)).getByText('Ресерч не удался')).toBeInTheDocument();
      expect(within(card(GOAL_C)).getByText('Ресерч остановлен')).toBeInTheDocument();

      // Assert 3: one GET /messages, only A's answer; the answer is the last message, drawn as DR-04; no turn started
      await until(() => expect(feedIds(view.container).at(-1)).toBe(ANSWER_A));
      expect(feedIds(view.container)).toEqual(['u-a', 'r-a', 'u-b', 'r-b', 'u-c', 'r-c', ANSWER_A]);
      expect(traffic.messageReads).toBe(2);
      expect(traffic.chatBodies).toHaveLength(0);
      const drawn = messageRoot(view.container, ANSWER_A);
      expect(within(drawn).getByRole('heading', { name: 'Ответ ресерча' })).toBeInTheDocument();
      expect(within(drawn).getByText('Есть ответ')).toBeInTheDocument();
      expect(within(drawn).getByText(GOAL_A)).toBeInTheDocument();
      expect(within(drawn).getByRole('heading', { name: 'Установлено' })).toBeInTheDocument();
      expect(within(drawn).getByRole('link', { name: 'Источник 1' })).toBeInTheDocument();
      expect(within(drawn).getByRole('button', { name: 'Источники (1)' })).toBeInTheDocument();
      expect(drawn).not.toHaveTextContent('Текстовая часть ответа для модели');
      // AC-27.4: with a source neither the card nor the answer carries a no-source warning
      for (const text of [MC_31, MC_32, MC_33]) expect(view.container).not.toHaveTextContent(text);
      expect(within(card(GOAL_A)).getByText('Ресерч завершён')).toBeInTheDocument();
      expect(within(card(GOAL_A)).getByRole('link', { name: 'К ответу' })).toHaveAttribute('href', `#${ANSWER_A}`);

      // Act 4: two more periods
      await nextPeriod();
      await nextPeriod();
      await quiet();

      // Assert 4: nothing is pending - no more reads, the answer is drawn once
      expect(traffic.researchReads).toBe(3);
      expect(traffic.messageReads).toBe(2);
      expect(feedIds(view.container).filter((id) => id === ANSWER_A)).toHaveLength(1);

      // Act 5 / Assert 5: «К запросу» leads to the launch message, «К ответу» to the answer's header (AC-20.6)
      click(within(drawn).getByRole('link', { name: 'К запросу ресерча' }));
      expect(messageRoot(view.container, 'u-a')).toHaveFocus();
      click(within(card(GOAL_A)).getByRole('link', { name: 'К ответу' }));
      expect(within(drawn).getByRole('heading', { name: 'Ответ ресерча' })).toHaveFocus();
    });
    it('INT-5 P2: an answer that completes while another reply streams is appended only after that stream ends, as a separate message, in the same order after a reload', async () => {
      // Arrange: a running launch; the next chat reply is held mid-stream by a latch
      const runningA = researchLaunchView({ launchKey: 'call-a', goal: GOAL_A });
      const history = [launchMessage('u-a', 'Почему выросли расходы?'), cardMessage('r-a', runningA)];
      const answer = answerMessage(ANSWER_A, { launchKey: 'call-a', goal: GOAL_A, launch: { messageId: 'u-a' } });
      const gate = deferred();
      const [start, textStart, delta, ...tail] = assistantTextChunks('Обычный ответ', 'r-2');
      let stored: HistoryMessage[] = history;
      const traffic = serveThread({
        messages: () => stored,
        research: (read) => (read === 1 ? [runningA] : [{ ...runningA, state: 'completed', answerMessageId: ANSWER_A }]),
        replies: [() => heldStream([start, textStart, delta], gate, tail)],
      });
      const view = renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await until(() => expect(within(card(GOAL_A)).getByText('Ресерч идёт')).toBeInTheDocument());
      await until(() => expect(traffic.researchReads).toBe(1));

      // Act 1: a message is sent; its reply streams and stops at the latch
      sendMessage('Ещё вопрос');
      await until(() => expect(screen.getByText('Обычный ответ')).toBeInTheDocument());
      expect(traffic.chatBodies).toHaveLength(1);

      // Act 2: a period passes while the reply streams; the launch is now completed
      await nextPeriod();
      await until(() => expect(traffic.researchReads).toBe(2));
      await quiet();

      // Assert 2: nothing is read or inserted mid-stream; the card is «Завершён» without a link to a missing answer
      expect(traffic.messageReads).toBe(1);
      expect(feedIds(view.container)).not.toContain(ANSWER_A);
      expect(within(card(GOAL_A)).getByText('Ресерч завершён')).toBeInTheDocument();
      expect(within(card(GOAL_A)).queryByRole('link', { name: 'К ответу' })).toBeNull();

      // Act 3: the reply ends; the server has stored the answer after it (DC-3)
      const userId = feedIds(view.container).at(-2) ?? '';
      stored = [...history, userMessage(userId, 'Ещё вопрос'), assistantMessage('r-2', 'Обычный ответ'), answer];
      gate.resolve();

      // Assert 3: one GET /messages after the stream; the answer follows the finished reply as its own message
      await until(() => expect(feedIds(view.container).at(-1)).toBe(ANSWER_A));
      expect(feedIds(view.container)).toEqual(['u-a', 'r-a', userId, 'r-2', ANSWER_A]);
      expect(traffic.messageReads).toBe(2);
      expect(traffic.chatBodies).toHaveLength(1);
      expect(messageRoot(view.container, 'r-2')).toHaveTextContent('Обычный ответ');
      expect(messageRoot(view.container, 'r-2')).not.toHaveTextContent('Ответ ресерча');
      expect(messageRoot(view.container, ANSWER_A)).not.toHaveTextContent('Обычный ответ');
      expect(within(card(GOAL_A)).getByRole('link', { name: 'К ответу' })).toHaveAttribute('href', `#${ANSWER_A}`);

      // Act 4: reload - the history holds both
      view.unmount();
      serveThread({ messages: () => stored, research: () => [{ ...runningA, state: 'completed', answerMessageId: ANSWER_A }] });
      const reloaded = renderWithRuntime({ pathname: `/chat/${THREAD}` });

      // Assert 4: the same order
      await until(() => expect(feedIds(reloaded.container)).toEqual(['u-a', 'r-a', userId, 'r-2', ANSWER_A]));
    });

    it('INT-5 P3: a launch whose answer was removed by a regenerate keeps polling without «К ответу», and its answer returns once after the new reply or the card turns failed', async () => {
      // Arrange: two finished launches whose answers a regeneration removed (`answerPending`), after the regenerated reply
      const completedA = researchLaunchView({ launchKey: 'call-a', goal: GOAL_A, state: 'completed', answerPending: true });
      const completedB = researchLaunchView({ launchKey: 'call-b', goal: GOAL_B, state: 'completed', answerPending: true });
      const history = [
        launchMessage('u-a', 'Почему выросли расходы?'),
        cardMessage('r-a', researchLaunchView({ launchKey: 'call-a', goal: GOAL_A })),
        launchMessage('u-b', 'Как снизить задержки?'),
        cardMessage('r-b', researchLaunchView({ launchKey: 'call-b', goal: GOAL_B })),
        userMessage('u-3', 'Вопрос'),
        assistantMessage('r-3', 'Новый ответ'),
      ];
      const answer = answerMessage(ANSWER_A, { launchKey: 'call-a', goal: GOAL_A, launch: { messageId: 'u-a' } });
      const traffic = serveThread({
        messages: (read) => (read === 1 ? history : [...history, answer]),
        research: (read) => {
          if (read < 3) return [completedA, completedB];
          const answeredA = { ...completedA, answerPending: false, answerMessageId: ANSWER_A };
          return read === 3 ? [answeredA, completedB] : [answeredA, { ...completedB, state: 'failed', answerPending: false }];
        },
      });
      const view = renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await until(() => expect(within(card(GOAL_A)).getByText('Ресерч завершён')).toBeInTheDocument());
      await until(() => expect(traffic.researchReads).toBe(1));

      // Assert 1: «Завершён» without «К ответу» on both, and the poll goes on
      expect(within(card(GOAL_A)).queryByRole('link', { name: 'К ответу' })).toBeNull();
      expect(within(card(GOAL_B)).queryByRole('link', { name: 'К ответу' })).toBeNull();
      await nextPeriod();
      await until(() => expect(traffic.researchReads).toBe(2));
      expect(traffic.messageReads).toBe(1);

      // Act 2: the server reports A's answer stored again
      await nextPeriod();

      // Assert 2: it is fetched once and appended after the regenerated reply; MC-18 is announced again
      await until(() => expect(feedIds(view.container).at(-1)).toBe(ANSWER_A));
      expect(feedIds(view.container)).toEqual(['u-a', 'r-a', 'u-b', 'r-b', 'u-3', 'r-3', ANSWER_A]);
      expect(traffic.messageReads).toBe(2);
      expect(within(card(GOAL_A)).getByRole('link', { name: 'К ответу' })).toHaveAttribute('href', `#${ANSWER_A}`);
      expect(statusText()).toContain(MC_18);

      // Act 3: B's answer could not be written again
      await nextPeriod();

      // Assert 3: B is «Не удался» with MC-12, nothing is pending, and nothing more is read or appended
      await until(() => expect(within(card(GOAL_B)).getByText('Ресерч не удался')).toBeInTheDocument());
      expect(within(card(GOAL_B)).getByText(MC_12)).toBeInTheDocument();
      await nextPeriod();
      await quiet();
      expect(traffic.researchReads).toBe(4);
      expect(traffic.messageReads).toBe(2);
      expect(feedIds(view.container).filter((id) => id === ANSWER_A)).toHaveLength(1);
      expect(traffic.chatBodies).toHaveLength(0);
    });
    it('INT-5 P4: a decision message with no reply stays hidden, the answer is still appended, and the state is read once after each deepResearch turn and each failed decision turn', async () => {
      // Arrange: the stored tail is a «Остановить» decision whose turn failed before its reply (UC-E7)
      const runningA = researchLaunchView({ launchKey: 'call-a', goal: GOAL_A });
      const completedA = { ...runningA, state: 'completed' as const, answerMessageId: ANSWER_A };
      const proposalB = researchLaunchView({ launchKey: 'call-b', mode: 'proposal', state: 'proposed', goal: GOAL_B });
      const history: HistoryMessage[] = [
        launchMessage('u-a', 'Почему выросли расходы?'),
        cardMessage('r-a', runningA),
        {
          id: 'd-1',
          role: 'user',
          metadata: { [RESEARCH_METADATA_KEYS.researchDecision]: { action: 'stop', launchKey: 'call-a' } },
          parts: [{ type: 'text', text: 'Остановить' }],
        },
      ];
      const answer = answerMessage(ANSWER_A, { launchKey: 'call-a', goal: GOAL_A, launch: { messageId: 'u-a' } });
      const traffic = serveThread({
        messages: (read) => (read === 1 ? history : [...history, answer]),
        research: (read) => (read === 1 ? [runningA] : read === 2 ? [completedA] : [completedA, proposalB]),
        replies: [
          () =>
            sseFromChunks(
              toolReplyChunks({ messageId: 'r-b', toolCallId: 'call-b', goal: GOAL_B, result: { launch: proposalB } }),
            ),
          () => HttpResponse.json({ message: 'provider unavailable' }, { status: 500 }),
        ],
      });
      const view = renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await until(() => expect(within(card(GOAL_A)).getByText('Ресерч идёт')).toBeInTheDocument());
      await until(() => expect(traffic.researchReads).toBe(1));

      // Assert 1: the decision message is not drawn
      expect(feedIds(view.container)).toEqual(['u-a', 'r-a']);

      // Act 2: the research completes
      await nextPeriod();

      // Assert 2: its answer is the last message drawn, the decision stays hidden, and the poll ends
      await until(() => expect(feedIds(view.container)).toEqual(['u-a', 'r-a', ANSWER_A]));
      expect(within(card(GOAL_A)).getByRole('link', { name: 'К ответу' })).toBeInTheDocument();
      await nextPeriod();
      await quiet();
      expect(traffic.researchReads).toBe(2);

      // Act 3: a turn that ends in a `deepResearch` call (a proposal: nothing pending)
      sendMessage('Предложи ресерч про задержки');
      await until(() => expect(within(card(GOAL_B)).getByText('Ждёт подтверждения')).toBeInTheDocument());

      // Assert 3: exactly one read after the turn, no poll after it
      await until(() => expect(traffic.researchReads).toBe(3));
      await nextPeriod();
      await quiet();
      expect(traffic.researchReads).toBe(3);

      // Act 4: a decision turn that fails before streaming
      click(within(card(GOAL_B)).getByRole('button', { name: 'Запустить' }));

      // Assert 4: the card shows MC-15, and the state is read once after the failed turn, then no more
      await until(() => expect(within(card(GOAL_B)).getByText(MC_15)).toBeInTheDocument());
      await until(() => expect(traffic.researchReads).toBe(4));
      await nextPeriod();
      await quiet();
      expect(traffic.researchReads).toBe(4);
      expect(traffic.chatBodies).toHaveLength(2);
      expect(traffic.messageReads).toBe(2);
    });

    it('INT-5 P5: an answer without sources appended by the poll is drawn with the warning and the mark on every claim and no footnotes, the same after a reload and in the copy, and each card and answer follows its own launch\'s mode when modes are mixed', async () => {
      // Arrange: a running launch without sources and, after a restart with a source, a proposal with one (UC-13, DC-8)
      const CLAIM_1 = 'Рост связан с новыми кластерами.';
      const CLAIM_2 = 'Часть расходов — хранение логов.';
      const STORED_TEXT = [MC_32, '', 'Ответ ресерча · Вывода нет', '', `- ${CLAIM_1} (${MC_33})`, `- ${CLAIM_2} (${MC_33})`].join('\n');
      const runningA = researchLaunchView({ launchKey: 'call-a', goal: GOAL_A, sourceMode: 'model_knowledge' });
      const completedA = { ...runningA, state: 'completed' as const, answerMessageId: ANSWER_A };
      const proposalB = researchLaunchView({ launchKey: 'call-b', mode: 'proposal', state: 'proposed', goal: GOAL_B });
      const runningB = { ...proposalB, state: 'running' as const };
      const completedB = { ...runningB, state: 'completed' as const, answerMessageId: ANSWER_B };
      const answerA = answerMessage(
        ANSWER_A,
        {
          launchKey: 'call-a',
          goal: GOAL_A,
          launch: { messageId: 'u-a' },
          sourceMode: 'model_knowledge',
          assumed: [
            { text: CLAIM_1, footnotes: [], verified: false, confidence: null, causal: false },
            { text: CLAIM_2, footnotes: [], verified: false, confidence: null, causal: false },
          ],
        },
        STORED_TEXT,
      );
      const answerB = answerMessage(ANSWER_B, { launchKey: 'call-b', goal: GOAL_B, launch: { toolCallId: 'call-b' } });
      const history = [
        launchMessage('u-a', 'Почему выросли расходы?'),
        cardMessage('r-a', runningA),
        userMessage('u-b', 'Вопрос про задержки'),
        cardMessage('r-b', proposalB),
      ];
      let launches: ResearchLaunchView[] = [runningA, proposalB];
      let stored: HistoryMessage[] = history;
      const traffic = serveThread({
        messages: () => stored,
        research: () => launches,
        replies: [
          () =>
            sseFromChunks(
              toolReplyChunks({
                messageId: 'd-reply',
                toolCallId: 'd-call',
                goal: GOAL_B,
                result: { launch: runningB },
                decisionReplyOf: 'call-b',
              }),
            ),
        ],
      });
      const writeText = vi.fn((text: string) => Promise.resolve(void text));
      // The clipboard is a browser API boundary jsdom does not provide.
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      onTestFinished(() => {
        Reflect.deleteProperty(navigator, 'clipboard');
      });
      const view = renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await until(() => expect(within(card(GOAL_A)).getByText('Ресерч идёт')).toBeInTheDocument());
      await until(() => expect(traffic.researchReads).toBe(1));

      // Assert 1: each card follows its own launch's mode
      expect(within(card(GOAL_A)).getByText(MC_31)).toBeInTheDocument();
      expect(within(card(GOAL_B)).queryByText(MC_31)).toBeNull();

      // Act 2: A completes; its answer is stored
      launches = [completedA, proposalB];
      stored = [...history, answerA];
      await nextPeriod();

      // Assert 2: the answer is last, with MC-32, MC-33 after each claim, and no footnote, label or source list
      await until(() => expect(feedIds(view.container).at(-1)).toBe(ANSWER_A));
      const drawnA = messageRoot(view.container, ANSWER_A);
      expect(within(drawnA).getByText(MC_32)).toBeInTheDocument();
      expect(within(drawnA).getAllByText(MC_33)).toHaveLength(2);
      expect(within(drawnA).getByText(CLAIM_1)).toHaveTextContent(`${CLAIM_1} ${MC_33}`);
      expect(within(drawnA).getByText(CLAIM_2)).toHaveTextContent(`${CLAIM_2} ${MC_33}`);
      expect(within(drawnA).queryByRole('link', { name: /^Источник/ })).toBeNull();
      expect(within(drawnA).queryByText('не проверено')).toBeNull();
      expect(within(drawnA).queryByRole('button', { name: /^Источники/ })).toBeNull();
      expect(within(card(GOAL_A)).getByText('Ресерч завершён')).toBeInTheDocument();
      expect(within(card(GOAL_A)).getByText(MC_31)).toBeInTheDocument();
      expect(statusText()).toContain(MC_18_NO_SOURCES);

      // Act 3 / Assert 3: «Копировать» takes the stored text, caveats included (DC-9)
      click(within(drawnA).getByRole('button', { name: 'Копировать' }));
      expect(writeText).toHaveBeenCalledWith(STORED_TEXT);

      // Act 4: the proposal with a source is confirmed; it runs, then completes
      click(within(card(GOAL_B)).getByRole('button', { name: 'Запустить' }));
      launches = [completedA, runningB];
      await until(() => expect(within(card(GOAL_B)).getByText('Ресерч идёт')).toBeInTheDocument());
      await until(() => expect(traffic.researchReads).toBe(3));
      launches = [completedA, completedB];
      stored = [...stored, answerB];
      await nextPeriod();

      // Assert 4: B's answer has its footnote and none of the no-source warnings; A's keeps its own
      await until(() => expect(feedIds(view.container).at(-1)).toBe(ANSWER_B));
      const drawnB = messageRoot(view.container, ANSWER_B);
      expect(within(drawnB).getByRole('link', { name: 'Источник 1' })).toBeInTheDocument();
      for (const text of [MC_32, MC_33]) expect(drawnB).not.toHaveTextContent(text);
      expect(within(card(GOAL_B)).queryByText(MC_31)).toBeNull();
      expect(within(messageRoot(view.container, ANSWER_A)).getByText(MC_32)).toBeInTheDocument();

      // Act 5: reload
      view.unmount();
      const reloadHistory = [
        launchMessage('u-a', 'Почему выросли расходы?'),
        cardMessage('r-a', runningA),
        userMessage('u-b', 'Вопрос про задержки'),
        cardMessage('r-b', proposalB),
        ...researchDecisionPair({ idPrefix: 'd', decision: { action: 'confirm', launchKey: 'call-b' }, launch: runningB }),
        answerA,
        answerB,
      ];
      serveThread({
        messages: () => reloadHistory,
        research: () => [completedA, completedB],
      });
      const reloaded = renderWithRuntime({ pathname: `/chat/${THREAD}` });

      // Assert 5: the restored answer without sources is drawn the same (AC-27.3 after a reload)
      await until(() => expect(feedIds(reloaded.container)).toEqual(['u-a', 'r-a', 'u-b', 'r-b', ANSWER_A, ANSWER_B]));
      const restoredA = messageRoot(reloaded.container, ANSWER_A);
      expect(within(restoredA).getByText(MC_32)).toBeInTheDocument();
      expect(within(restoredA).getAllByText(MC_33)).toHaveLength(2);
      expect(within(restoredA).queryByRole('link', { name: /^Источник/ })).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven at unit level (named for the plan; generated as component specs next to the code, not here). One table-driven spec per rule, cases as rows.
// ---------------------------------------------------------------------------------------------------------------
// - ResearchAnswer (component, table over `researchAnswer` metadata): header with goal, outcome label (MC-24) and stop reason (MC-25), groups MC-26 with the unverified label MC-27, a footnote per source number with the accessible name «Источник {n}»,
//   the source list with truncation mark MC-28, no text part drawn from the message text. AC-20.7, AC-20.1 (draw).
//   Rows added for `sourceMode` (UC-12, UC-E8, UC-N3): `model_knowledge` with claims -> MC-32 first under the goal line, MC-33 as plain text right after each claim (not `aria-hidden`, not a tooltip, no footnote, no MC-27 label, no source list); `model_knowledge`
//   with no claim -> MC-32, MC-25 and no claim; `sources` -> none of MC-32, MC-33; MC-32 is ordinary text, not `role="alert"`. AC-27.3 (draw), AC-27.4, NFR-05 (reading order).
// - ResearchCard (component, table over state x action): every state of UXRD DR-03 draws its title, rows, buttons and message (MC-5..MC-16, MC-29), «Остановить» asks for confirmation (MC-9) and sends nothing on «Продолжить», buttons are `disabled`
//   with MC-30 when a reply streams, the accessible name MC-14. AC-19.2 (draw), AC-19.3, AC-19.4, AC-21.1 (draw).
//   Rows added for `sourceMode`: `model_knowledge` -> MC-31 under the budget in every state (`proposed`, launching, `running`, `completed`, `not_launched`, `failed`, `stopped`), as ordinary text and not `role="alert"`; `sources` -> never. The variants of the
//   announcements MC-17 and MC-18 by mode. AC-27.1 (draw), AC-27.2 (draw), AC-27.4 (draw), DC-8 (draw).
// - ResearchModeToggle (component): `aria-pressed` follows the state, placeholder MC-2 and send name MC-3 in the mode, Enter/Space toggles, focus stays on the toggle. NFR-05 (aria half), UXRD Accessibility.
// - ThreadMessage hiding rule (table): a user message with `researchDecision` and an assistant message with `researchDecisionReply` are not drawn, a message with `researchAnswer` is always drawn, the last visible message for TH-10 ignores hidden ones
//   while TH-08 stays with the runtime's last message. DC-7 (rule).
// - Block of the errored reply (extends message-error.test.tsx): MC-21 over «Перегенерировать» when the reply carries a `proposed` or `running` card. AC-22.2 (draw).
// - DeleteThreadDialog (extends delete-thread-dialog.test.tsx, MSW for GET /research): the dialog reads the launches of its thread on open and shows MC-22 in the singular or plural for one or several `running`, and nothing otherwise, also when the read
//   fails. DC-6, AC-22.1 (warning).
// - useThreadResearch (store, fake timers, no runtime): which launch states keep the poll alive (`running`, `completed` with `answerPending`), the 404 case, the unmount cleanup.
// - Message-metadata handling of ChatRuntimeProvider (`toCreateMessage`, `sendAutomaticallyWhen`): the mode passes from `runConfig` to the metadata of the message, a turn that ends in a `deepResearch` call is not re-sent while other tool turns still are.
