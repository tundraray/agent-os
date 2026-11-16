// enterprise-access / access (web) - integration skeleton
// Design Doc: docs/features/enterprise-access/design-access.md (v1.1), C3 · web, Test Strategy UC-11; UXRD: docs/features/enterprise-access/uxrd.md
//   Screen 3 (MA-02), Screen 4 (QP-01, QP-02, QP-03, RF-01, the pause states), MC-9, MC-10, MC-11, MC-12, MC-13, MC-14, MC-15, MC-16.
// Generated: 2026-11-15 | Budget Used: 1 web integration skeleton (the part's 5th and last: INT-1, INT-2, INT-3 in
//   apps/api/test/enterprise-access-access.int.e2e-spec.ts, INT-4 in packages/agents/test/enterprise-access-access.int.e2e-spec.ts),
//   0 web E2E (no browser tool in the repo; the part's L1 browser checklist covers the layout, focus and contrast, as in the earlier parts).
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom). Case is `it.todo` - skeleton only.
//
// Harness (src/test/): `renderWithRuntime` mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy) -
//   as in enterprise-access-mcp-connect.int.test.tsx; MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); the event source is
//   injected as in agent-platform-web.int.test.tsx (`createTestLiveSource`), so a `quota_pause_ended` event is pushed by the test. Fixtures in
//   src/test/fixtures.ts: a conversation view whose root has status `awaiting_quota` with `quotaPause`, a background agent on a pause, a history
//   entry of a refused `start_agent` with reason `model_not_allowed`, a failed root with each of the three failure reasons, and a `MyModels` body.
// Mock boundary: network (MSW: `GET /api/access/models`, the thread and agent routes, `GET /api/auth/me`) and next/navigation. The `/account` page
//   section, `lib/access`, the quota-pause component, the feed, the agent card, the agents strip, the composer and the tool-call block - real. Do NOT
//   mock any of them.
//
// Adapted, not duplicated: the status tables of agent-platform-web.int.test.tsx (labels, the control by status) gain the row `awaiting_quota`
//   in their own table tests; the connections section of the `/account` page is proven by
//   components/account/connections-section.test.tsx (the models section is proven here).
// `provenAt: unit` (small tables next to the code): status -> label and control (`format.ts`, `agent-status.tsx`, `agent-header.tsx`) for
//   `awaiting_quota`; the reason -> text maps of MC-10 / MC-11 / MC-14; money and month formatting («100,40 $», «1 декабря»); `MyModels` row ->
//   cell texts. The component's states are checked against the design system by the L1 checklist.
// NOT here: the admin screens (part `admin`), the models and quota verdicts (API INT-2, INT-3), the connections section (mcp-connect UC-6).

import { describe, it } from 'vitest';

describe('enterprise-access / access - web integration (jsdom + MSW)', () => {
  // AC: AC-22.1 "агент получает статус «ждёт решения по квоте», а Аня в беседе и в списке агентов видит модель, свой расход и квоту за месяц";
  //   AC-22.3 "агент продолжает работу, и Ане не нужно ничего писать"; AC-22.4 "агент получает статус «сбой» с причиной «квота исчерпана»,
  //   а Аня видит причину в беседе"; AC-22.5 "Аня останавливает агента: «остановлен»"; AC-20.1 / AC-20.2 / AC-16.3 / AC-19.3 (the texts of the
  //   refusal and of the failure); AC-23.1 "видит обе модели и расход за месяц на каждую, у Sonnet - квоту и остаток, а у Haiku - «без предела»".
  //   Design: C3 · web; UC-11; UXRD QP-01..QP-03, RF-01, MA-02.
  // Behavior: the user passes one story in one mounted shell -> each step is what the screen shows, which controls it offers and which request it sent.
  // Steps (literal texts from uxrd.md MC-9..MC-16; the live source is driven by the test):
  //   1. the conversation's root is `awaiting_quota` with `quotaPause` (model «Sonnet», month ноябрь, spend 100,40 $ of 100 $, since 14:20,
  //      waitUntil 15 нояб. 14:20): the feed ends with the pause block - «Квота Sonnet на ноябрь исчерпана», «Ждёт с 14:20», «Расход 100,40 $ из
  //      100 $», the line that the decision is the administrator's and work resumes by itself «или 1 декабря», and «Если решения не будет до 15
  //      нояб., 14:20, работа завершится сбоем.»; the header status reads «Ждёт решения по квоте»; the composer placeholder is «Сообщение
  //      подождёт: работа продолжится после решения по квоте», «Отправить» sends to the existing message route (the text lands in the tray),
  //      there is no «Прервать» and no «Остановить» for the chat (QP-03); no request to a decision route is ever sent for the pause.
  //   2. a background agent on a pause: its card in the conversation shows the status «Ждёт решения по квоте» and under the title «Квота Sonnet
  //      исчерпана: 100,40 $ из 100 $ · решение за администратором»; on «Агенты» one strip «Квота Sonnet исчерпана: 100,40 $ из 100 $ за ноябрь.
  //      Ждут решения администратора: 2.» above the tree; the agent's header offers «Остановить» (and not «Прервать»); pressing it sends exactly one
  //      stop request.
  //   3. the live events: `quota_pause_ended` with `quota_raised` for the chat -> the block is replaced by «Квота поднята — работа продолжена · {время}»,
  //      the status returns to «Работает», the strip count drops to 1; `refused` for the agent -> «Администратор отказал — работа завершена · {время}»,
  //      status «Сбой», an event line «Сбой: квота исчерпана · {время}» and, in the parent's report, «Причина: квота исчерпана»; `expired` ->
  //      «Решения не было — работа завершена · {время}»; the existing `stopped` event -> «Остановлен вами · {время}»; with the last pause gone the
  //      strip is gone.
  //   4. DC-10 shape: a pause ending with `model_not_allowed` gets no MC-13 line; the block is replaced by the event line «Сбой: модель не
  //      разрешена · {время}» (and the same with `model_not_connected` -> «Сбой: модель не подключена · {время}»).
  //   5. RF-01: a history entry of `start_agent` refused with `model_not_allowed` on Sonnet shows the block with the outcome «отказано» and the
  //      line «Модель не разрешена: Sonnet»; one with `no_access` shows «Нет доступа к инструменту»; a failed root with each reason shows its
  //      MC-11 text - «Модель Sonnet вам не разрешена. Обратитесь к администратору Agent OS.», «Модель Sonnet не подключена. Обратитесь к
  //      администратору Agent OS.», «Вам не разрешена ни одна модель. Обратитесь к администратору Agent OS.» - with the button «Перегенерировать».
  //   6. MA-02 on `/account`: `GET /api/access/models` answers Haiku (no quota) and Sonnet (spend 64,20 $, quota 100 $, remaining 35,80 $) -> the
  //      section «Модели и расход за ноябрь» shows the columns «Модель», «Расход», «Квота», «Остаток»; Haiku has «без предела» and «—»; Sonnet
  //      «100 $» and «35,80 $»; with Sonnet `exhausted` the remaining is «0,00 $» with the label «Квота исчерпана»; an empty list shows «Вам не
  //      разрешена ни одна модель. Обратитесь к администратору Agent OS.»; a failing `GET` shows the load error with «Повторить», which loads again.
  // Catches: a pause that the employee can see only as a stuck «Работает» (the status map without the new value falls back to a default), or one
  //   that offers «Прервать» / a decision button the server answers 404 to; the block left on screen after the pause ended, or replaced by a
  //   raised-quota line when the real reason was a withdrawn model; a refusal or failure shown as a blank block or a raw reason code, so the
  //   employee cannot tell they must write to the administrator; a models table that disagrees with the API's remaining amount or hides «Квота
  //   исчерпана», so the employee is surprised by a pause the page did not announce.
  // @category: integration
  // @dependency: /account page (models section), lib/access client, quota-pause block and strip, feed (to-feed), agent card and header, composer, tool-call block, event stream reducer, MSW, next/navigation mock
  // @complexity: medium
  it.todo('UC-11: the employee sees the quota pause in the conversation and on «Агенты» with the right controls, its end by the right line, the refusal and failure texts, and the models with spend and quota on «Мой доступ»');
});
