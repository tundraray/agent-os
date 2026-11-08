// agent-quality / web Integration Test Skeletons - Design Doc: docs/features/agent-quality/design-web.md v1.2 (Test Strategy; KD-1..KD-8; DC-1..DC-13)
// PRD: docs/features/agent-quality/prd.md (FR-14, FR-15, FR-16, FR-21: AC-15.1, AC-15.3, AC-21.1 card side, AC-21.2 card side). UXRD: docs/features/agent-quality/uxrd.md v1.3 (KD-1..KD-7, MC-1..MC-4, «Остановка» steps 1-3, Error Flows),
//   docs/features/deep-research/uxrd.md (MC-16, MC-19, MC-21, MC-30), chat-shell UXRD (TH-08).
// Generated: 2026-11-07 | Part: web | Test type: Integration (Vitest + RTL + MSW 2, jsdom, REAL useChatRuntime / AI SDK Chat, real ThreadResearchProvider / ThreadResearch store / threadsApiClient / @agent-os/contracts schemas)
// Implementation timing: created alongside the web slice each INT names (INT-1 answer rendering through the schema; INT-2/INT-3 `stopResearch` + provider + store; INT-4 TH-08 after a button stop).
//
// File name and placement. Same as the sibling files `shell.<topic>.int.test.tsx` of this folder (vitest.config.ts include `src/**/*.test.{ts,tsx}`, environment jsdom). The part has NO browser runner and
// no E2E file: a `*.e2e.test.tsx` would be picked up by the same include and run in the default suite, and the repo has no Playwright. The real-browser journeys are the L1 scenarios L1-1..L1-4 of the
// Design Doc ("Проверка в настоящем браузере"), executed by an agent through Claude-in-Chrome as chat-entry did (docs/features/deep-research/chat-entry/l1-browser-scenarios.md); the plan writes the
// l1-browser-scenarios.md of this part from that table. Each case was written as a pending skeleton first and filled with its slice.
//
// Harness (src/test/): renderWithRuntime({ pathname }) from '@/test/render-with-runtime' mounts ChatRuntimeProvider + ChatShell with mocked next/navigation. MSW server from '@/test/msw-server' (onUnhandledRequest: 'error');
//   fixtures from '@/test/fixtures' (`researchLaunchView`, `threadResearch`, `deepResearchToolPart`, `historyMessages`, `sseFromChunks`, `assistantTextChunks`, `deferred`). API base URL: NEXT_PUBLIC_API_URL = 'http://api.test'. TZ = 'Europe/Berlin'.
//   New in the harness (add with the slices, not created here): an MSW handler for `POST /api/threads/:threadId/research/:launchKey/stop` that records its calls (count, URL) and answers per test.
//   WARNING for INT-1: `researchAnswerMessage` in fixtures.ts runs `ResearchAnswerMetadataSchema.parse`, which fills the new fields with their defaults. An "old" message built with it is not old. The old row serves the RAW JSON
//   of a pre-update message (no `summaryItems`, no `confidence`, no `causal`) straight from the MSW history handler, so the schema in @agent-os/contracts, not the fixture, is what meets it.
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters, ResearchCard, ResearchAnswer, ThreadResearchProvider, ThreadResearch, threadsApiClient, MessageError - real.
//   Do NOT mock lib/threads/*, lib/config.ts or @assistant-ui/*. Time: a held response is a `deferred`, never a sleep; INT-3 R1/R2 poll reads are ordered by deferreds on the GET /research handler.
//
// Budget (part): Integration 4 (limit 3; up to 5 only when each extra names the defect no other test catches), E2E 0 (limit 1-2: no runner, see above; the four L1 scenarios are manual).
//   Core: INT-1 (answer through the real schema), INT-2 (stop while the agent writes, the whole wiring), INT-3 (the stop outcomes the provider turns into a line or a state).
//   Extra: INT-4 (TH-08 block after a button stop) - unique defect: only the real runtime owns the chat error that a hidden decision turn used to reset, and only the real store feeds `useReplyCarriesActiveResearch`; no unit
//   level and none of INT-1..INT-3 sees a stop that wrongly removes the error block or leaves MC-21 behind. Rows of one rule or one flow are table rows of one INT, not tests.
//
// Proven elsewhere (not in this file) - unit tests named for the plan, each one table-driven, no skeleton here:
// - U-1 `research-answer.test.tsx` (extend; replaces the cases that pin `summary` and MC-34): the summary is drawn iff `summaryItems` is non-empty. Rows: UC-1 two items (caption MC-2 under the goal, bulleted list, item text + group words, no footnotes,
//   no other labels) / UC-E1 empty items and only «Предположения»+«Не выяснено» (no caption, no list, no gap, the first heading follows the goal line) / UC-E2 `model_knowledge` (MC-32 then groups, MC-33 on claims, no summary, no labels) /
//   UC-E3 forced stop (stop reason under the goal, no summary, `medium` words on the established claim) / old shape: empty items AND a non-empty `summary` string -> no paragraph, no MC-34, no MC-2 (DC-5 render half). Covers DC-3, DC-4, DC-5, AC-15.3.
// - U-2 `research-answer.test.tsx` (same file): the label after a claim's footnotes. Rows: UC-2 `very_high|high|medium|low` -> «уверенность очень высокая|высокая|средняя|низкая», in this order, after "Источник 1, Источник 2" in reading order,
//   no digits or % next to them / `confidence` null (old message) -> no word (DC-2) / `causal` true -> «причинная связь не доказана» in a frame and NO «не проверено» (DC-1) / `verified` false and `causal` false -> «не проверено»,
//   no MC-3 / both sourceless modes -> no labels. Covers AC-15.1, DC-1, DC-2, KD-6.
// - U-3 `research-card.test.tsx` (extend; the case "the confirmed «Остановить» is unavailable while «Продолжить» still works" must be inverted): with `replyStreaming` the row «Остановить» and the confirmation «Остановить» and «Продолжить» work
//   and have no `aria-disabled` and no MC-30; «Запустить» and «Не нужно» stay disabled, keep Tab order, and describe themselves with MC-30 (DC-7); Esc and «Продолжить» return the action row and focus to «Остановить» (UC-E10);
//   `decisionError` `still_launching` draws MC-4 in the «Ещё запускается» form without `role="alert"`, hides it when «Остановить» of the row is pressed and shows it again only on a new prop value; `stop_failed` draws MC-16 with `role="alert"`;
//   both lines only while `running` (invariant 2). Covers DC-7, DC-9, DC-10 (card half).
// - U-4 `thread-research-store.test.ts` (extend): `stop(launchKey)` outcomes with the client faked at its boundary (MSW). Rows: 200 `stopped` -> «применено», view replaces the launch, one `stopped` event in `announcements`, the next read with the same
//   `stopped` adds no event (invariant 5, UC-3 tail) / the 200 view per state table (UC-E6): `completed` with answer, `completed` + `answerPending`, `failed`, `proposed`, `not_launched` (`declined`), `running` -> the view stands, events only for
//   completed|failed|stopped, none for the rest, `running` is «применено» too (MC-4 is the provider's) / network error, 404, 400, 500, body outside `ResearchStopResponseSchema` -> «отказ» and EXACTLY ONE state read afterwards (DC-10) /
//   no open thread -> «устарело» at once, no request / thread switched or store closed before the answer -> «устарело», nothing applied, no event (UC-E9, store half) / a read started before the answer and returned after it is discarded and the store
//   reads again, the card stays `stopped` and «Ресерч запущен» is never announced (UC-E8, invariant 4) / UC-E11: the state changed by a read alone (`stopped`, or `running`) - event once, no `decisionError` concept involved (DC-11).
//   Covers DC-8, DC-10, DC-11, KD-3, KD-4, invariants 4, 5.
// - U-5 `threads-api-client.test.ts` (extend): `stopResearch` sends `POST` without a body, with the session cookie, both ids URL-encoded in `/api/threads/:threadId/research/:launchKey/stop`, and returns `launch` parsed by
//   `ResearchStopResponseSchema`. Rows (error classification, one rule): no connection -> `network`; no answer within the default 20 s (fake timers, request aborted) -> `network`; an explicit shorter limit is honoured; 404 with either code
//   and 400 -> `not_found`; 500 and other statuses -> `http`; non-JSON body or body outside the schema -> `invalid_response`; the error body's `code` is not read. Covers DC-10, KD-4 (the 20 s limit lives only here).
// - Existing tests the plan keeps green or changes: `shell.research-decisions.int.test.tsx` INT-4 R3 loses its `stop` row (stop no longer goes through a decision turn; the same defect class is INT-3 R1 here); `research-answer.test.tsx` cases
//   that pin `summary`/MC-34 are replaced by U-1; `shell.research-delivery.int.test.tsx` INT-5 P1 keeps the stopped/failed-adds-no-answer rows and INT-5 P4 / INT-4 R2 keep proving DC-12 (a stored `researchDecision` `stop` message and its reply stay hidden, the
//   hiding rule reads the metadata mark, not the action) - NO new skeleton for DC-12 (UC-E12); `ResearchLaunchView`-to-card-state rules stay in `research-card.test.tsx` (STATES table).
// - Not automated: UC-6 / KD-6 "a long label moves whole to the next line, muted text colour in light and dark" is layout and colour, which jsdom does not compute -> L1-1. L1-2 (stop while streaming in a real browser), L1-3 (blocked stop address, retry works),
//   L1-4 (pre-update answer in a real browser with a clean console) are the manual journeys over INT-2, INT-3 R1, INT-1.

import type { HistoryMessage, ResearchLaunchView } from '@agent-os/contracts';
import { act, fireEvent, screen, within } from '@testing-library/react';
import type { UIMessageChunk } from 'ai';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RESEARCH_POLL_INTERVAL_MS } from '@/lib/threads/research-poll';
import {
  deepResearchToolPart,
  deferred,
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
const GOAL = 'Почему выросли ошибки платежей';
const TEXT_VERSION = 'Текстовая версия ответа для модели';
const MC_2 = 'Главное из установленного';
const MC_3 = 'причинная связь не доказана';
const MC_34 = 'Краткий пересказ — основания в утверждениях ниже';
const OLD_SUMMARY = 'Ошибки выросли из-за таймаутов.';
const METADATA_WARNING = '[deep-research] research answer metadata outside the contract; drawn as text';

const SOURCES = [
  { number: 1, sourceId: 'logs', toolName: 'search_logs', snapshot: '30.10 14:00–15:00', truncated: false },
  { number: 2, sourceId: 'deploys', toolName: 'list_deploys', snapshot: '30.10', truncated: false },
];

/**
 * A stored research answer message as raw JSON - the server's bytes, not a fixture: `researchAnswerMessage` parses with the
 * schema and would fill the new fields, so only raw JSON lets the schema in @agent-os/contracts meet a pre-update message.
 */
function rawAnswerMessage(researchAnswer: Record<string, unknown>): unknown {
  return {
    id: 'answer-a',
    role: 'assistant',
    metadata: {
      researchAnswer: {
        launchKey: 'call-a',
        goal: GOAL,
        outcome: 'answered',
        stopReason: null,
        unknown: [],
        sources: SOURCES,
        sourceMode: 'sources',
        launch: { messageId: 'u-1' },
        ...researchAnswer,
      },
    },
    parts: [{ type: 'text', text: TEXT_VERSION }],
  };
}

/** Thread `a` whose history is a question and the given answer message; no research launch is listed. */
function serveThread(answer: unknown): void {
  server.use(
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([threadSummary({ id: THREAD, title: 'Беседа A' })]))),
    http.get(`${API}/api/threads/${THREAD}`, () => HttpResponse.json(threadSummary({ id: THREAD, title: 'Беседа A' }))),
    http.get(`${API}/api/threads/${THREAD}/messages`, () =>
      HttpResponse.json({ messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Почему растут ошибки?' }] }, answer] }),
    ),
    http.get(`${API}/api/threads/${THREAD}/research`, () => HttpResponse.json(threadResearch([]))),
  );
}

/** The claim item of the answer whose text starts with `text` (the last one: a summary item with the same text comes first). */
function claimItem(answer: HTMLElement, text: string): HTMLElement {
  const item = within(answer)
    .getAllByText((_, element) => element?.tagName === 'LI' && (element.textContent ?? '').startsWith(text))
    .at(-1);
  if (item === undefined) throw new Error(`no claim «${text}»`);
  return item;
}

function follows(earlier: HTMLElement, later: HTMLElement): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

// ----- The direct stop (INT-2, INT-3) -----

const OTHER_THREAD = 'b';
const GOAL_A = 'Почему выросли расходы на облако';
const GOAL_B = 'Как снизить задержки API';
const MC_4 = 'Ресерч ещё запускается. Остановите его через несколько секунд.';
const MC_16 = 'Не удалось остановить ресерч. Попробуйте ещё раз.';
const MC_19 = 'Ресерч остановлен';
const MC_30 = 'Доступно, когда агент закончит ответ.';
const MC_21 = 'Перегенерация остановит ресерч из этого ответа.';
const TH_08 = 'Не удалось получить ответ. Попробуйте перегенерировать.';

type Answer = () => Response | Promise<Response>;

/** What MSW received; every counter belongs to one test. */
type StopTraffic = { stopUrls: string[]; chatRequests: number; researchReads: number };

/**
 * Serves thread `a` (history, research list as a function of the read number), thread `b` (one plain exchange, no
 * research), the chat turns answered in order by `replies`, and the stop route answered in order by `stops`.
 */
function serveStopThreads({
  history,
  research,
  replies = [],
  stops,
}: {
  history: HistoryMessage[];
  research: (read: number) => ResearchLaunchView[];
  replies?: Answer[];
  stops: Answer[];
}): StopTraffic {
  const traffic: StopTraffic = { stopUrls: [], chatRequests: 0, researchReads: 0 };
  const threadA = threadSummary({ id: THREAD, title: 'Беседа A' });
  const threadB = threadSummary({ id: OTHER_THREAD, title: 'Беседа B' });
  server.use(
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([threadA, threadB]))),
    http.get(`${API}/api/threads/${THREAD}`, () => HttpResponse.json(threadA)),
    http.get(`${API}/api/threads/${OTHER_THREAD}`, () => HttpResponse.json(threadB)),
    http.get(`${API}/api/threads/${THREAD}/messages`, () => HttpResponse.json({ messages: history })),
    http.get(`${API}/api/threads/${OTHER_THREAD}/messages`, () =>
      HttpResponse.json({ messages: [userMessage('b-1', 'Другой вопрос'), assistantMessage('b-2', 'Другой ответ')] }),
    ),
    http.get(`${API}/api/threads/${THREAD}/research`, () => {
      traffic.researchReads += 1;
      return HttpResponse.json(threadResearch(research(traffic.researchReads)));
    }),
    http.get(`${API}/api/threads/${OTHER_THREAD}/research`, () => HttpResponse.json(threadResearch([]))),
    http.post(`${API}/api/chat/assistant`, () => {
      traffic.chatRequests += 1;
      const reply = replies[traffic.chatRequests - 1];
      if (reply === undefined) throw new Error(`no reply queued for chat request ${traffic.chatRequests}`);
      return reply();
    }),
    http.post(`${API}/api/threads/:threadId/research/:launchKey/stop`, ({ request }) => {
      traffic.stopUrls.push(request.url);
      const answer = stops[traffic.stopUrls.length - 1];
      if (answer === undefined) throw new Error(`no answer queued for stop request ${traffic.stopUrls.length}`);
      return answer();
    }),
  );
  return traffic;
}

/** A stop answer held until `gate` is released. */
const heldStop =
  (gate: Deferred<void>, launch: ResearchLaunchView): Answer =>
  async () => {
    await gate.promise;
    return HttpResponse.json({ launch });
  };

const stopNow =
  (launch: ResearchLaunchView): Answer =>
  () =>
    HttpResponse.json({ launch });

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

/** A restored assistant message holding the card of one launch: its `deepResearch` call and result. */
function cardMessage(id: string, launch: ResearchLaunchView): HistoryMessage {
  return {
    id,
    role: 'assistant',
    parts: [deepResearchToolPart({ toolCallId: launch.launchKey, goal: launch.goal, result: { launch } })],
  };
}

const userMessage = (id: string, text: string): HistoryMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const assistantMessage = (id: string, text: string): HistoryMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] });

const card = (goal: string) => screen.getByRole('group', { name: `Ресерч: ${goal}` });
const composer = () => screen.getByRole('textbox', { name: 'Сообщение' });

/** The one TH-08 block of the feed (chat-shell UXRD); fails when there is none or more than one. */
function errorBlock(container: HTMLElement): HTMLElement {
  const blocks = container.querySelectorAll<HTMLElement>('[data-slot="message-error"]');
  if (blocks.length !== 1) throw new Error(`expected one error block, found ${blocks.length}`);
  return blocks[0];
}

function feedIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-role="user"], [data-role="assistant"]')).map(
    (root) => root.id,
  );
}

/**
 * Every announcement the polite regions make from now on, in order: a new announcement mounts new children in its
 * region, so a repeated text is heard twice even when the region's text does not change.
 */
function recordAnnouncements(): string[] {
  const heard: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement && node.parentElement?.getAttribute('role') === 'status') heard.push(node.textContent ?? '');
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  onTestFinished(() => observer.disconnect());
  return heard;
}

// The clock moves only when a test says so: the poll would otherwise read at its own pace and the read counts would
// depend on the machine. RTL's `waitFor` / `findBy*` and user-event wait on the faked `setTimeout`; `until` replaces them.

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

function click(element: HTMLElement): void {
  act(() => {
    fireEvent.click(element);
  });
}

/** «Остановить» in the card's row, then «Остановить» in its confirmation (MC-9). */
function confirmStop(goal: string): void {
  click(within(card(goal)).getByRole('button', { name: 'Остановить' }));
  within(card(goal)).getByRole('button', { name: 'Продолжить' });
  click(within(card(goal)).getByRole('button', { name: 'Остановить' }));
}

describe('Shell: agent-quality web part (answer labels and the direct stop)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  Restored history reaches the screen through the real schema: new fields arrive, old messages still parse
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-15.1: "Given ответ выдан, Then у каждого вывода в «Установлено» указана группа уверенности её постоянными словами и без процента."
  // AC: AC-15.3: "Given в сводке стоят выводы из разных групп, Then каждый вывод сводки стоит со словами своей группы."
  // DC-1: "Когда у вывода в «Предположениях» `causal` равен true, после его сносок стоит метка «причинная связь не доказана» (MC-3) в рамке, а метки «не проверено» у него нет."
  // DC-3: "Когда в `summaryItems` есть пункты, под строкой цели стоит подпись MC-2 и под ней маркированный список: текст пункта и слова его группы, без сносок и без других меток."
  // DC-5: "Ответ, записанный до этой части, показывается без сводки - ни прежнего абзаца с подписью MC-34, ни подписи MC-2 - и без меток уверенности и причинной связи; группы, сноски, «не проверено» и источники - как раньше."
  // Use cases: UC-1, UC-5. Risk: design-web.md "Risks and Mitigation", first item (high impact). Real browser: L1-1, L1-4.
  //
  // Behavior: a thread is opened -> GET /messages returns a research answer message -> AssistantMessage parses `researchAnswer` with the contracts schema -> ResearchAnswer / Claim draw it
  //   rows (one open of the thread each, one table):
  //   N  new message (raw JSON with `summaryItems` [high, medium], established claims with `confidence` high / medium and footnotes, an assumed causal claim `causal` true + `verified` true, an assumed claim `verified` false):
  //      caption «Главное из установленного» under the goal line and a list of two items with «уверенность высокая» / «уверенность средняя» and no footnote; the same words after the footnotes of the established claims;
  //      «причинная связь не доказана» after the causal claim's footnotes and no «не проверено» on it; «не проверено» and no MC-3 on the other; the MC-34 caption nowhere; the answer is drawn from metadata (the text version is not on screen)
  //   O  OLD message (raw JSON as stored before the update: no `summaryItems`, `confidence`, `causal`; a `summary` paragraph; one unverified claim): drawn from metadata, NOT as the text version; no summary paragraph, no MC-34, no MC-2; the first group
  //      heading follows the goal line; no confidence word and no MC-3; groups, footnotes, «не проверено» and the source list as before; `console.warn` is not called with a metadata warning (L1-4)
  // Catches: (N) the contracts schema strips or mistypes `summaryItems`, `confidence` or `causal`, so ResearchAnswer receives nothing and the screen shows no summary or labels although every direct-props test is green; (O) the extended schema rejects
  //   messages stored before the update, so every earlier answer falls back to plain text - high impact, the highest-ranked risk of the design. No other test parses a pre-update message with the real schema.
  // @category: core-functionality
  // @dependency: @agent-os/contracts (ResearchAnswerMetadataSchema), AssistantMessage (metadata parse + fallback), ResearchAnswer, Claim, MSW (history)
  // @complexity: medium
  it.each<{
    row: string;
    answer: Record<string, unknown>;
    summaryItems: string[] | null;
    firstAfterGoal: string;
    claims: Record<string, string>;
  }>([
    {
      row: 'N (new fields)',
      answer: {
        summary: null,
        summaryItems: [
          { claimId: 'c1', text: 'С 19:40 до 20:15 payment-api записал 412 ошибок timeout.', confidence: 'high' },
          { claimId: 'c2', text: 'Ошибки шли от одного узла gateway.', confidence: 'medium' },
        ],
        established: [
          { text: 'С 19:40 до 20:15 payment-api записал 412 ошибок timeout.', footnotes: [1], verified: true, confidence: 'high', causal: false },
          { text: 'Ошибки шли от одного узла gateway.', footnotes: [1], verified: true, confidence: 'medium', causal: false },
        ],
        assumed: [
          { text: 'Ошибки оплаты вызвал релиз в 19:30.', footnotes: [1, 2], verified: true, confidence: null, causal: true },
          { text: 'Узел перегружен ретраями.', footnotes: [1], verified: false, confidence: null, causal: false },
        ],
      },
      summaryItems: [
        'С 19:40 до 20:15 payment-api записал 412 ошибок timeout. уверенность высокая',
        'Ошибки шли от одного узла gateway. уверенность средняя',
      ],
      firstAfterGoal: MC_2,
      claims: {
        'С 19:40 до 20:15': 'С 19:40 до 20:15 payment-api записал 412 ошибок timeout. [1] уверенность высокая',
        'Ошибки шли от': 'Ошибки шли от одного узла gateway. [1] уверенность средняя',
        'Ошибки оплаты': `Ошибки оплаты вызвал релиз в 19:30. [1] [2] ${MC_3}`,
        'Узел перегружен': 'Узел перегружен ретраями. [1] не проверено',
      },
    },
    {
      // Stored before agent-quality: no `summaryItems`, no `confidence`, no `causal`, a model-written `summary` string.
      row: 'O (pre-update message)',
      answer: {
        summary: OLD_SUMMARY,
        established: [{ text: 'С 19:40 до 20:15 payment-api записал 412 ошибок timeout.', footnotes: [1], verified: true }],
        assumed: [{ text: 'Узел перегружен ретраями.', footnotes: [2], verified: false }],
      },
      summaryItems: null,
      firstAfterGoal: 'Установлено',
      claims: {
        'С 19:40 до 20:15': 'С 19:40 до 20:15 payment-api записал 412 ошибок timeout. [1]',
        'Узел перегружен': 'Узел перегружен ретраями. [2] не проверено',
      },
    },
  ])(
    'INT-1 $row: a restored research answer draws its summary and labels from the new fields, and a pre-update answer still parses and draws without summary or labels',
    async ({ answer, summaryItems, firstAfterGoal, claims }) => {
      // Arrange
      const warn = vi.spyOn(console, 'warn');
      onTestFinished(() => warn.mockRestore());
      serveThread(rawAnswerMessage(answer));

      // Act: open the thread; the history goes through the real runtime, `useResearchAnswerOf` and the contracts schema
      renderWithRuntime({ pathname: `/chat/${THREAD}` });
      const heading = await screen.findByRole('heading', { level: 2, name: 'Ответ ресерча' });
      const drawn = heading.closest<HTMLElement>('article');
      if (drawn === null) throw new Error('the answer is not drawn as ResearchAnswer');

      // Assert: drawn from metadata, not as the text version, and the metadata passed the schema
      expect(screen.queryByText(TEXT_VERSION)).toBeNull();
      expect(warn).not.toHaveBeenCalledWith(METADATA_WARNING);
      const goal = within(drawn).getByText(GOAL);
      expect(goal.nextElementSibling?.textContent?.startsWith(firstAfterGoal)).toBe(true);
      expect(within(drawn).queryByText(MC_34)).toBeNull();
      expect(within(drawn).queryByText(OLD_SUMMARY)).toBeNull();
      if (summaryItems === null) {
        expect(within(drawn).queryByText(MC_2)).toBeNull();
        expect(within(drawn).queryByText(/^уверенность /)).toBeNull();
        expect(within(drawn).queryByText(MC_3)).toBeNull();
      } else {
        const list = within(drawn).getAllByRole('list')[0];
        expect(follows(within(drawn).getByText(MC_2), list)).toBe(true);
        expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(summaryItems);
        expect(within(list).queryAllByRole('link')).toHaveLength(0);
      }
      expect(Object.keys(claims).map((text) => claimItem(drawn, text).textContent)).toEqual(Object.values(claims));
      expect(within(drawn).getByRole('button', { name: 'Источники (2)' })).toBeInTheDocument();
    },
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Stop while the agent writes: one stop request, no chat turn, composer untouched, card «Остановлен» announced once
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-21.1 (card side): "Given провайдер модели недоступен, When сотрудник подтверждает остановку на карточке, Then сотрудник видит расследование остановленным, и новые вызовы модели не начинаются."
  // DC-6: "Когда сотрудник подтверждает остановку, карточка сразу переходит в «Остановку», и вкладка отправляет один запрос к операции остановки и ни одного хода беседы; композер и другие карточки не меняются."
  // DC-7: "Пока агент пишет ответ, «Остановить» в ряду действий, «Остановить» и «Продолжить» в подтверждении и Esc работают, а «Запустить» и «Не нужно» неактивны с описанием MC-30."
  // DC-8 (stopped): "...карточка показывает состояние из `launch` ... Перемену состояния экран объявляет один раз, как после чтения: для `stopped` - MC-19."
  // Use case: UC-3 (UC-E10 is U-3). Flow 1. KD-1, KD-2, KD-3. Real browser: L1-2.
  //
  // Behavior: thread with a «Идёт» card (call-a) and a proposal card (call-b); the user sends a new message -> the chat reply is held open (SSE not finished) -> «Остановить» -> confirmation -> «Остановить» ->
  //   POST /api/threads/a/research/call-a/stop (held, then 200 `launch` `stopped`) -> card «Останавливаем…» and focus on the card -> «Ресерч остановлен» with «Ответа не будет.» -> the reply finishes
  // Verification items:
  // - while the stop request is held: status «Останавливаем…» on the card, focus stays on it; the composer is in the streaming state; «Запустить» of call-b is disabled and described by MC-30; the stop route was called exactly once
  // - the number of POST /api/chat/assistant equals the number before the press plus none (only the user's own new message): no `researchDecision` body, no new message in the feed
  // - after the 200: «Ресерч остановлен» and «Ответа не будет.», no MC-16 and no MC-4; the live region holds «Ресерч остановлен» once; the next GET /research that returns `stopped` adds no second announcement (KD-3)
  // - the held chat reply finishes afterwards and is drawn to the end (the stop did not abort it)
  // Catches: the button still goes through a hidden decision turn (a chat request appears, the composer changes, the button waits for the stream and is dead exactly when the model is unavailable); the stop request is sent twice; the same
  //   `stopped` is announced twice (once from the answer, once from the next read). The unit rows U-3/U-4/U-5 each prove one link; only this test proves the links are connected to one button in a streaming tab.
  // @category: core-functionality
  // @dependency: ResearchCard, ThreadResearchProvider, ThreadResearch, threadsApiClient.stopResearch, ChatRuntimeProvider (real useChatRuntime), MSW (SSE v7 held by a deferred, stop route)
  // @complexity: high
  describe('the direct stop', () => {
    beforeEach(() => {
      // Only the timers the poll runs on; the network, React's scheduler and `Date` stay real.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      // The research store logs a refused stop; the tests assert what the user sees instead.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('INT-2: confirming «Остановить» while the agent writes sends one stop request and no chat turn, leaves the composer streaming, and announces «Ресерч остановлен» once', async () => {
      // Arrange: a running card A and a proposal card B; the next chat reply is held mid-stream, the stop answer too
      const runningA = researchLaunchView({ launchKey: 'call-a', goal: GOAL_A });
      const stoppedA: ResearchLaunchView = { ...runningA, state: 'stopped' };
      const proposalB = researchLaunchView({ launchKey: 'call-b', mode: 'proposal', state: 'proposed', goal: GOAL_B });
      const streamGate = deferred();
      const stopGate = deferred();
      const traffic = serveStopThreads({
        history: [userMessage('u-1', 'Вопрос'), cardMessage('a-1', runningA), userMessage('u-2', 'Ещё'), cardMessage('a-2', proposalB)],
        research: (read) => (read === 1 ? [runningA, proposalB] : [stoppedA, proposalB]),
        replies: [
          () =>
            heldStream(
              [{ type: 'start', messageId: 'r-held' }, { type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: 'Пишу' }],
              streamGate,
              [{ type: 'text-delta', id: 't1', delta: ' дальше' }, { type: 'text-end', id: 't1' }, { type: 'finish' }],
            ),
        ],
        stops: [heldStop(stopGate, stoppedA)],
      });
      const heard = recordAnnouncements();
      const view = renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await until(() => expect(traffic.researchReads).toBe(1));
      await until(() => card(GOAL_A));

      // The agent writes a reply
      act(() => {
        fireEvent.change(composer(), { target: { value: 'Новый вопрос' } });
      });
      click(screen.getByRole('button', { name: 'Отправить' }));
      await until(() => expect(screen.getByText('Пишу')).toBeInTheDocument());
      const feedBefore = feedIds(view.container);
      const composerForm = composer().closest('form');
      if (composerForm === null) throw new Error('the composer is not a form');

      // Act 1: the stop is confirmed while the reply streams
      confirmStop(GOAL_A);
      await until(() => expect(traffic.stopUrls).toHaveLength(1));

      // Assert 1: «Остановка» on the card with the focus on it; the reply still streams; card B's buttons wait for it
      expect(within(card(GOAL_A)).getByText('Останавливаем…')).toBeInTheDocument();
      expect(card(GOAL_A)).toHaveFocus();
      expect(within(composerForm).getByRole('button', { name: 'Остановить' })).toBeInTheDocument();
      const launchB = within(card(GOAL_B)).getByRole('button', { name: 'Запустить' });
      expect(launchB).toHaveAttribute('aria-disabled', 'true');
      expect(launchB).toHaveAccessibleDescription(MC_30);
      expect(traffic.stopUrls).toEqual([`${API}/api/threads/${THREAD}/research/call-a/stop`]);
      expect(traffic.chatRequests).toBe(1);

      // Act 2: the stop is applied
      stopGate.resolve();

      // Assert 2: «Ресерч остановлен» and «Ответа не будет.», no line; announced once; no chat turn, the feed unchanged
      await until(() => expect(within(card(GOAL_A)).getByText(MC_19)).toBeInTheDocument());
      expect(within(card(GOAL_A)).getByText('Ответа не будет.')).toBeInTheDocument();
      for (const line of [MC_4, MC_16]) expect(screen.queryByText(line)).toBeNull();
      await quiet();
      expect(heard.filter((text) => text === MC_19)).toHaveLength(1);
      expect(traffic.chatRequests).toBe(1);
      expect(feedIds(view.container)).toEqual(feedBefore);

      // Act 3: the next poll reads the same `stopped`
      await nextPeriod();
      await until(() => expect(traffic.researchReads).toBe(2));
      await quiet();

      // Assert 3: no second announcement and no second stop request
      expect(heard.filter((text) => text === MC_19)).toHaveLength(1);
      expect(traffic.stopUrls).toHaveLength(1);

      // Act 4: the held reply finishes
      streamGate.resolve();

      // Assert 4: it is drawn to the end - the stop did not abort it; still one chat request
      await until(() => expect(screen.getByText('Пишу дальше')).toBeInTheDocument());
      expect(traffic.chatRequests).toBe(1);
      expect(within(card(GOAL_A)).getByText(MC_19)).toBeInTheDocument();
    });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Outcomes of the stop request that the provider turns into a card line or a state: refusal, still starting, tab moved away
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-21.1 (card side), see INT-2.
  // DC-9: "Когда операция отвечает 200, а запуск всё ещё `running`, карточка возвращается в «Идёт» со строкой пояснения MC-4, «Остановить» доступна, и экран вежливо объявляет MC-4; строка уходит при следующей смене состояния карточки или при следующем нажатии «Остановить»."
  // DC-10: "Когда операция отказывает или не отвечает за 20 секунд, карточка возвращается в «Идёт» со строкой MC-16, которую программа чтения экрана слышит как `alert`, и «Остановить» снова доступна; затем вкладка один раз читает состояние."
  // DC-6 (tab moved): UC-E9 - "в другой беседе ничего не объявлено; в прежней карточка показывает состояние из чтения, а не «Остановку»."
  // Use cases: UC-E4, UC-E7, UC-E9 (UC-E5 and the 20 s limit: U-5; the per-state 200 table UC-E6: U-4 + `research-card.test.tsx`). Invariants 1, 2. UXRD KD-6, Error Flows. Real browser: L1-3.
  //
  // Behavior: card «Идёт» -> «Остановить» -> confirm -> the stop route answers per row -> provider ends «Остановку» and sets the line -> card / live region
  //   rows (table: the stop route's answer and what follows):
  //   R1 refusal: the stop route answers 500 -> «Ресерч идёт», MC-16 «Не удалось остановить ресерч. Попробуйте ещё раз.» with `role="alert"`, «Остановить» enabled, exactly one GET /research after the failure (it still reports `running`, so the line stays);
  //      pressing «Остановить» again, confirming, with the route now 200 `stopped` -> «Ресерч остановлен», MC-16 gone, one announcement
  //   R2 still starting: 200 with `launch` `running` -> «Ресерч идёт» and MC-4 «Ресерч ещё запускается. Остановите его через несколько секунд.» without `role="alert"`, «Остановить» enabled, MC-4 is in the polite live region once, MC-16 absent;
  //      «Остановить» pressed in the row -> the line is hidden; the next read returns `stopped` -> «Ресерч остановлен» with no line and «Ресерч остановлен» announced once
  //   R3 tab moved away: the stop request is held; the user opens another thread (the other thread's research list has nothing) -> no «Остановка» there;
  //      returning to the first thread before the answer shows the state its own read reports (`running`, «Остановить» enabled), not «Останавливаем…»;
  //      a new stop is pressed and held, the first answer arrives -> not applied, not announced, the new «Остановка» stays; the new stop answers -> «Ресерч остановлен», announced once
  // Catches: (R1) a refusal leaves the card stuck in «Останавливаем…» or without «Остановить», or drops the error to the console only; the retry is blocked by a stale pending state. (R2) a still-starting launch is shown as «Остановлен» or as a failure
  //   (the operation did not touch it), MC-4 is announced as an alert, or the line survives the next press or a state change. (R3) the late answer of a closed thread is applied to the thread now on screen, announces its stop there, leaves
  //   the old card in «Остановке» after the return, or ends the «Остановка» of a newer stop. Provider-level wiring across store, client and card that no unit row sees.
  // @category: core-functionality
  // @dependency: ThreadResearchProvider (live region, decide('stop')), ThreadResearch, ResearchCard, threadsApiClient, MSW (stop route per row, GET /research per read), next/navigation mock (thread switch)
  // @complexity: high
    it('INT-3 R1 (refusal): a refused stop shows MC-16 as an alert, reads the state once, and a retry stops the research', async () => {
      // Arrange: a running card; the first stop answers 500, the retry 200 `stopped`
      const runningA = researchLaunchView({ launchKey: 'call-a', goal: GOAL_A });
      const stoppedA: ResearchLaunchView = { ...runningA, state: 'stopped' };
      let serverState = [runningA];
      const traffic = serveStopThreads({
        history: [userMessage('u-1', 'Вопрос'), cardMessage('a-1', runningA)],
        research: () => serverState,
        stops: [() => HttpResponse.json({ message: 'internal' }, { status: 500 }), stopNow(stoppedA)],
      });
      const heard = recordAnnouncements();
      renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await until(() => expect(traffic.researchReads).toBe(1));
      await until(() => card(GOAL_A));

      // Act 1: the stop is refused
      confirmStop(GOAL_A);

      // Assert 1: «Ресерч идёт» with MC-16 as an alert, «Остановить» available, exactly one read after the refusal
      await until(() => expect(within(card(GOAL_A)).getByRole('alert')).toHaveTextContent(MC_16));
      expect(within(card(GOAL_A)).getByText('Ресерч идёт')).toBeInTheDocument();
      expect(within(card(GOAL_A)).queryByText('Останавливаем…')).toBeNull();
      await until(() => expect(traffic.researchReads).toBe(2));
      await quiet();
      expect(traffic.researchReads).toBe(2);
      expect(within(card(GOAL_A)).getByRole('alert')).toHaveTextContent(MC_16);
      expect(screen.queryByText(MC_4)).toBeNull();

      // Act 2: the retry; the server stops it now
      serverState = [stoppedA];
      confirmStop(GOAL_A);

      // Assert 2: «Ресерч остановлен», MC-16 gone, announced once, two stop requests in all, no chat turn
      await until(() => expect(within(card(GOAL_A)).getByText(MC_19)).toBeInTheDocument());
      expect(within(card(GOAL_A)).queryByRole('alert')).toBeNull();
      await quiet();
      expect(heard.filter((text) => text === MC_19)).toHaveLength(1);
      expect(traffic.stopUrls).toHaveLength(2);
      expect(traffic.chatRequests).toBe(0);
    });

    it('INT-3 R2 (still starting): a stop answered with a running launch shows MC-4 politely without an error, the next press hides it, and a later read shows the stop', async () => {
      // Arrange: a running card; the stop answers 200 with the launch still `running`
      const runningA = researchLaunchView({ launchKey: 'call-a', goal: GOAL_A });
      const stoppedA: ResearchLaunchView = { ...runningA, state: 'stopped' };
      const traffic = serveStopThreads({
        history: [userMessage('u-1', 'Вопрос'), cardMessage('a-1', runningA)],
        research: (read) => (read === 1 ? [runningA] : [stoppedA]),
        stops: [stopNow(runningA)],
      });
      const heard = recordAnnouncements();
      renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await until(() => expect(traffic.researchReads).toBe(1));
      await until(() => card(GOAL_A));

      // Act 1: the stop finds the research still starting
      confirmStop(GOAL_A);

      // Assert 1: «Ресерч идёт» with MC-4, not an alert, «Остановить» available; MC-4 announced once; no MC-16
      await until(() => expect(within(card(GOAL_A)).getByText(MC_4)).toBeInTheDocument());
      expect(within(card(GOAL_A)).getByText('Ресерч идёт')).toBeInTheDocument();
      expect(within(card(GOAL_A)).queryByRole('alert')).toBeNull();
      expect(screen.queryByText(MC_16)).toBeNull();
      await quiet();
      expect(heard.filter((text) => text === MC_4)).toHaveLength(1);

      // Act 2: «Остановить» in the row again
      click(within(card(GOAL_A)).getByRole('button', { name: 'Остановить' }));

      // Assert 2: the line is hidden
      expect(within(card(GOAL_A)).queryByText(MC_4)).toBeNull();

      // Act 3: the next poll reads `stopped`
      await nextPeriod();

      // Assert 3: «Ресерч остановлен» without a line, announced once; one stop request in all
      await until(() => expect(within(card(GOAL_A)).getByText(MC_19)).toBeInTheDocument());
      expect(within(card(GOAL_A)).queryByText(MC_4)).toBeNull();
      await quiet();
      expect(heard.filter((text) => text === MC_19)).toHaveLength(1);
      expect(heard.filter((text) => text === MC_4)).toHaveLength(1);
      expect(traffic.stopUrls).toHaveLength(1);
    });

    it('INT-3 R3 (tab moved away): a stop still in flight when the tab leaves the thread leaves no «Остановка» in either thread, and its late answer does not undo a new stop', async () => {
      // Arrange: a running card; the first stop answer is held; the reads keep reporting `running` until the second stop
      const runningA = researchLaunchView({ launchKey: 'call-a', goal: GOAL_A });
      const stoppedA: ResearchLaunchView = { ...runningA, state: 'stopped' };
      const firstStop = deferred();
      const secondStop = deferred();
      const traffic = serveStopThreads({
        history: [userMessage('u-1', 'Вопрос'), cardMessage('a-1', runningA)],
        research: (read) => (read <= 2 ? [runningA] : [stoppedA]),
        stops: [heldStop(firstStop, stoppedA), heldStop(secondStop, stoppedA)],
      });
      const heard = recordAnnouncements();
      const view = renderWithRuntime({ pathname: `/chat/${THREAD}` });
      await until(() => expect(traffic.researchReads).toBe(1));
      await until(() => card(GOAL_A));
      confirmStop(GOAL_A);
      await until(() => expect(traffic.stopUrls).toHaveLength(1));
      expect(within(card(GOAL_A)).getByText('Останавливаем…')).toBeInTheDocument();

      // Act 1: the tab opens thread B while the stop is still in flight
      act(() => {
        view.setPathname(`/chat/${OTHER_THREAD}`);
      });
      await until(() => expect(screen.getByText('Другой ответ')).toBeInTheDocument());

      // Assert 1: no card and no «Остановка» in thread B, nothing announced
      expect(screen.queryByRole('group', { name: `Ресерч: ${GOAL_A}` })).toBeNull();
      expect(screen.queryByText('Останавливаем…')).toBeNull();

      // Act 2: back to thread A before the first stop answers; its read still reports `running`
      act(() => {
        view.setPathname(`/chat/${THREAD}`);
      });
      await until(() => expect(traffic.researchReads).toBe(2));
      await until(() => card(GOAL_A));

      // Assert 2: the card shows its read - «Ресерч идёт» with «Остановить», not the «Остановка» of the closed visit
      await until(() => expect(within(card(GOAL_A)).getByText('Ресерч идёт')).toBeInTheDocument());
      expect(within(card(GOAL_A)).queryByText('Останавливаем…')).toBeNull();
      expect(within(card(GOAL_A)).getByRole('button', { name: 'Остановить' })).toBeEnabled();

      // Act 3: a new stop, held; then the first stop's late answer arrives
      confirmStop(GOAL_A);
      await until(() => expect(traffic.stopUrls).toHaveLength(2));
      firstStop.resolve();
      await quiet();

      // Assert 3: the late answer is not applied and does not end the new stop's «Остановка»
      expect(within(card(GOAL_A)).getByText('Останавливаем…')).toBeInTheDocument();
      expect(heard.filter((text) => text === MC_19)).toHaveLength(0);

      // Act 4: the new stop answers
      secondStop.resolve();

      // Assert 4: «Ресерч остановлен», announced once; two stop requests in all
      await until(() => expect(within(card(GOAL_A)).getByText(MC_19)).toBeInTheDocument());
      expect(within(card(GOAL_A)).queryByText('Останавливаем…')).toBeNull();
      await quiet();
      expect(heard.filter((text) => text === MC_19)).toHaveLength(1);
      expect(traffic.stopUrls).toHaveLength(2);
    });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  Button stop leaves the error block of the reply in place and takes MC-21 away only from the stopped reply's own card
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-21.1 (card side): the model is unavailable.
  // DC-13: "Когда сотрудник останавливает ресерч кнопкой, а в ленте стоит блок ошибки ответа (chat-shell UXRD, TH-08), блок остаётся на месте с «Перегенерировать»: остановка не начинает хода беседы. Строка MC-21 над «Перегенерировать» уходит, только если остановлена карточка из самой упавшей реплики."
  // DC-6 (no chat turn). Use case: UC-4. UXRD «Остановка», step 3. Flow 1, failure handling "Модель недоступна". Invariant 3.
  //
  // Behavior: the last chat turn failed (500 before streaming) and the errored reply shows the TH-08 block; the user stops a «Идёт» card -> POST stop (200 `stopped`) -> card «Ресерч остановлен»; no chat request
  //   rows (two runs of one scenario, the card's reply differs):
  //   E  the stopped card sits in an EARLIER reply: the TH-08 block and «Перегенерировать» stay; the MC-21 line over «Перегенерировать» was not there before and is not there after
  //   S  the stopped card sits in the ERRORED reply itself: the TH-08 block and «Перегенерировать» stay; MC-21 «Перегенерация остановит ресерч из этого ответа.» is visible before the press and gone after the 200
  // Verification items (both rows): the feed has the same number of messages before and after; the number of POST /api/chat/assistant is unchanged by the press; «Перегенерировать» is still enabled.
  // Catches: the stop still travels as a chat turn, so the AI SDK resets the chat error and the TH-08 block vanishes (the old hidden-turn behaviour, the stale-error removal of the decision turn); or MC-21 stays above «Перегенерировать» after the research
  //   it warned about is already stopped, or disappears when the stopped card belongs to another reply. Only the real runtime owns the chat error, and only the real store feeds `useReplyCarriesActiveResearch`.
  // @category: integration
  // @dependency: ChatRuntimeProvider (real chat error state), MessageError (TH-08, MC-21), useReplyCarriesActiveResearch, ThreadResearch, ResearchCard, MSW (failed chat turn, stop route)
  // @complexity: medium
    it.each<{ row: string; cardInErroredReply: boolean }>([
      { row: 'E (card in an earlier reply)', cardInErroredReply: false },
      { row: 'S (card in the errored reply)', cardInErroredReply: true },
    ])(
      'INT-4 $row: stopping a research by the button keeps the error block of a failed reply with «Перегенерировать», and MC-21 leaves only when the stopped card is in that reply',
      async ({ cardInErroredReply }) => {
        // Arrange: a running card A, either in an earlier reply (E) or in the reply that errors (S); the stop answers 200 `stopped`
        const runningA = researchLaunchView({ launchKey: 'call-a', goal: GOAL_A });
        const stoppedA: ResearchLaunchView = { ...runningA, state: 'stopped' };
        let serverState = [runningA];
        const erroredReply: UIMessageChunk[] = cardInErroredReply
          ? [
              { type: 'start', messageId: 'r-err' },
              { type: 'tool-input-available', toolCallId: 'call-a', toolName: 'deepResearch', input: { goal: GOAL_A } },
              { type: 'tool-output-available', toolCallId: 'call-a', output: { launch: runningA } },
              { type: 'error', errorText: 'Agent error' },
            ]
          : [
              { type: 'start', messageId: 'r-err' },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'Частичный' },
              { type: 'error', errorText: 'Agent error' },
            ];
        const traffic = serveStopThreads({
          history: cardInErroredReply
            ? [userMessage('u-1', 'Вопрос'), assistantMessage('a-1', 'Первый ответ')]
            : [userMessage('u-1', 'Вопрос'), cardMessage('a-1', runningA)],
          research: () => serverState,
          replies: [() => sseFromChunks(erroredReply)],
          stops: [
            () => {
              serverState = [stoppedA];
              return HttpResponse.json({ launch: stoppedA });
            },
          ],
        });
        // handleChatError logs the failed turn; the test asserts the block the user sees instead.
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const view = renderWithRuntime({ pathname: `/chat/${THREAD}` });
        await until(() => expect(traffic.researchReads).toBe(1));

        // The last turn fails: TH-08 under the errored reply, which is the last one
        act(() => {
          fireEvent.change(composer(), { target: { value: 'Новый вопрос' } });
        });
        click(screen.getByRole('button', { name: 'Отправить' }));
        await until(() => expect(errorBlock(view.container)).toHaveTextContent(TH_08));
        await until(() => card(GOAL_A));
        await quiet();
        const feedBefore = feedIds(view.container);
        const chatRequestsBefore = traffic.chatRequests;
        expect(chatRequestsBefore).toBe(1);
        expect(within(errorBlock(view.container)).queryByText(MC_21) !== null).toBe(cardInErroredReply);

        // Act: the stop is confirmed on card A and applied
        confirmStop(GOAL_A);
        await until(() => expect(within(card(GOAL_A)).getByText(MC_19)).toBeInTheDocument());
        await quiet();

        // Assert: the block and an enabled «Перегенерировать» stay; MC-21 is gone in S and did not appear in E; no chat turn
        const block = errorBlock(view.container);
        expect(within(block).getByRole('alert')).toHaveTextContent(TH_08);
        const regenerate = within(block).getByRole('button', { name: 'Перегенерировать' });
        expect(regenerate).toBeEnabled();
        expect(regenerate).not.toHaveAttribute('aria-disabled', 'true');
        expect(screen.queryByText(MC_21)).toBeNull();
        expect(traffic.stopUrls).toEqual([`${API}/api/threads/${THREAD}/research/call-a/stop`]);
        expect(traffic.chatRequests).toBe(chatRequestsBefore);
        expect(feedIds(view.container)).toEqual(feedBefore);
      },
    );
  });
});
