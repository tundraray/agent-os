# Task T2.1: Vitest 4 + RTL + MSW 2 + jsdom 29, обвязка `src/test/`, перенос и слияние скелетов, `config.test.ts`

Metadata:
- Task type: frontend (apps/web) + перенос скелетов из `docs/`
- Phase: 2 — фундамент (шаг 2 DD)
- Dependencies: task-T1.4 (общие `package.json`, `pnpm-lock.yaml`; гейт G1 к этому моменту пройден; `ui/sonner.tsx` из T1.4)
- Provides: Vitest/RTL/MSW-обвязка (`src/test/*`), 7 перенесённых скелетов `*.int.test.tsx` (10 `it.todo`) для T3.4, T4.2, T4.3, T5.2, T5.3, T7.3; скрипты `test`, `test:watch`
- Size: Large по числу файлов (≈ 16: 2 манифеста, конфиг, 4 обвязки, 1 тест, 7 переносов + 7 удалений) — допустимо как единая единица «инфраструктура + перенос»; не разбивать (перенос и слияние скелетов неделимы с обвязкой)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- Postgres 5433 нужен только для L1; тесты T2.1 идут без API (AC-12.2). `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`. Перед прямым vitest — `pnpm --filter @agent-os/contracts build`, если `dist` старше `src`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Поднять тестовую инфраструктуру `apps/web` (FR-12, AC-12.2): Vitest 4 + RTL + MSW 2 + jsdom 29, полифилы jsdom, фикстуры, `renderWithRuntime`. Перенести 7 скелетов из `docs/features/chat-shell/web-shell/test-skeletons/` в `apps/web/src/components/shell/` с слиянием 14 → 10 `it.todo` (раздел плана «Решение по бюджету интеграционных тестов»); исходные файлы и каталог удалить. Добавить `config.test.ts`.

## Target Files
- [ ] `apps/web/package.json`
- [ ] `pnpm-lock.yaml`
- [ ] `apps/web/vitest.config.ts` (new)
- [ ] `apps/web/src/test/setup.ts` (new)
- [ ] `apps/web/src/test/msw-server.ts` (new)
- [ ] `apps/web/src/test/fixtures.ts` (new)
- [ ] `apps/web/src/test/render-with-runtime.tsx` (new)
- [ ] `apps/web/src/lib/config.test.ts` (new)
- [ ] `apps/web/src/components/shell/shell.list.int.test.tsx` (new — перенос)
- [ ] `apps/web/src/components/shell/shell.new-chat.int.test.tsx` (new — перенос)
- [ ] `apps/web/src/components/shell/shell.open-thread.int.test.tsx` (new — перенос)
- [ ] `apps/web/src/components/shell/shell.deleted-thread.int.test.tsx` (new — перенос)
- [ ] `apps/web/src/components/shell/shell.message-error.int.test.tsx` (new — перенос)
- [ ] `apps/web/src/components/shell/shell.delete-open-thread.int.test.tsx` (new — перенос)
- [ ] `apps/web/src/components/shell/shell.workspace.int.test.tsx` (new — перенос)
- [ ] `docs/features/chat-shell/web-shell/test-skeletons/*.int.test.tsx` (delete — 7 файлов, каталог удаляется)

## Investigation Targets
- DD «Инструменты и версии», абзац о `vitest.config.ts` и `setup.ts`
- `apps/api/vitest.config.ts` (та же линия Vitest 4 / Vite 8)
- Комментарии «Harness» в скелетах `docs/features/chat-shell/web-shell/test-skeletons/*.int.test.tsx` (текущее содержимое рабочего дерева, **включая неотслеживаемый** `shell.message-error.int.test.tsx` и изменённые файлы)
- `turbo.json`
- `apps/web/src/components/ui/sonner.tsx` (из T1.4)
- Раздел плана «Решение по бюджету интеграционных тестов»

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Test Strategy, `vitest.config.ts`) | state-lifecycle-negative | «в начале модуля `process.env.TZ = 'Europe/Berlin'`»; «`test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}'], env: { NEXT_PUBLIC_API_URL: 'http://api.test' } }`»; MSW «`onUnhandledRequest: 'error'`» | Y, если `vitest.config.ts` содержит перечисленное дословно, MSW-сервер создан с `onUnhandledRequest: 'error'` |
| design-web-shell.md (§ Contract Definitions, `lib/config.ts`) | state-lifecycle-negative | `z.url({ protocol: /^https?$/ }).safeParse(process.env.NEXT_PUBLIC_API_URL)`; при провале — `throw new Error('NEXT_PUBLIC_API_URL must be an absolute http(s) URL')`; `apiBaseUrl = parsed.data.replace(/\/+$/, '')` | Y, если `config.test.ts` покрывает: не задан, `'localhost:4000'`, `'ftp://x'` → исключение; `'http://api.test/'` → `apiBaseUrl === 'http://api.test'` |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Версии devDependencies | `vitest` `^4.1.12`, `vite` `^8.0.0`, `@vitejs/plugin-react` `^6.1.2`, `jsdom` `^29.1.1` (не 30.x: Node 24.11 < 24.15), `@testing-library/react` `^16.3.3`, `@testing-library/dom` `^10.4.2`, `@testing-library/jest-dom` `^7.0.1`, `@testing-library/user-event` `^14.6.8`, `msw` `^2.15.0` | План T2.1 |
| Скрипты | `"test": "vitest run"`, `"test:watch": "vitest"` | План T2.1 |
| Каталог интеграционных тестов | `apps/web/src/components/shell/` (правило «рядом с кодом»; `include` их подхватывает) | План, п. 3 закрытых вопросов |
| Слияния скелетов (14 → 10) | AC-11.1 → в тест AC-11.3 (`shell.workspace`); AC-03.3 → в тест AC-04.1 (`shell.new-chat`; фикстура: беседа с `updatedAt` сегодня 09:00); AC-01.5 «Повторить» → в тест AC-01.7 (`shell.list`); AC-04.3 → в первый тест AC-02.2 (`shell.open-thread`). Слитые `it.todo` удаляются, их Arrange/Act/Assert-комментарии переносятся в принимающий кейс | План, раздел бюджета |
| Лимит интеграционных тестов | 10 при расширенном лимите 5 — исключение, утверждено пользователем | План, п. 4 закрытых вопросов |
| `deferred()` | `deferred()` → `{ promise, resolve, reject }` — удержание ответа MSW; импортирует `shell.open-thread`, используют T3.4 и T4.2 | План T2.1 |
| `<Toaster />` | В `renderWithRuntime` рядом с `ChatShell` из `@/components/ui/sonner` — для тоста «Беседа удалена» в `shell.delete-open-thread` (T5.2) без правки `src/test/*` | План T2.1 |
| Наполнение `it.todo` | В T2.1 кейсы **не наполняются** (остаются `it.todo`); наполнение — в задачах-поставщиках (правило 10) | Правило выполнения 10 |

## Investigation Notes
(Таблица соответствия 14 → 10 `it.todo` с именами итоговых кейсов; результат `pnpm --filter web test`.)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets, зафиксировать содержимое 7 скелетов рабочего дерева
- [ ] Написать `config.test.ts` (`vi.stubEnv` + `vi.resetModules()`; одна табличная проверка по Reference Contracts) — падает до настройки Vitest/пока `config.ts` не соответствует
- [ ] Запустить и увидеть падение (нет конфигурации)

### 2. Green Phase
- [ ] devDependencies и скрипты; `pnpm install`
- [ ] `vitest.config.ts` — дословно по Reference Contracts (плагин React)
- [ ] `setup.ts` — `@testing-library/jest-dom/vitest`; полифилы `matchMedia` (управляемые `pointer`, `prefers-color-scheme`, ширина), `ResizeObserver`, `IntersectionObserver`, `PointerEvent`, `Element.prototype.scrollIntoView`; `resetHandlers` после каждого теста; MSW `setupServer` в `msw-server.ts` с `onUnhandledRequest: 'error'`
- [ ] `fixtures.ts` — `threadSummary(...)`, `threadList(...)`, `historyMessages(...)`, `sseFromChunks(...)` (SSE v7); фикстуры проходят схемы `@agent-os/contracts`; `deferred()`
- [ ] `render-with-runtime.tsx` — `renderWithRuntime({ pathname, pointer, ... })`: `vi.mock('next/navigation')` с управляемым `pathname` и шпионом `router` (`push`, `replace`), монтирует `ChatRuntimeProvider` + `ChatShell` и рядом `<Toaster />`
- [ ] Перенос 7 скелетов в `apps/web/src/components/shell/` со слияниями; удалить исходники и каталог `test-skeletons/`

### 3. Refactor Phase
- [ ] Упростить обвязку; убедиться, что 10 `it.todo` учтены как todo, ни одного пустого заглушенного кейса

## Quality Assurance Mechanisms
- Vitest 4 + RTL + MSW — Enforces: U/C/I без запущенного API (AC-12.2) — Config: `apps/web/vitest.config.ts`, `apps/web/src/test/setup.ts` — Type: `executable_check`
- turbo `test` → `^build` — Enforces: тесты web видят собранный `@agent-os/contracts` — Config: `turbo.json` — Type: `executable_check`
- ESLint, `tsc`, `next build` — Type: `executable_check`

## Operation Verification Methods
- **Verification method**: `pnpm --filter web test`; `pnpm test` из корня (turbo); `ls apps/web/src/components/shell`; проверка отсутствия каталога `test-skeletons`.
- **Success criteria**: `config.test.ts` зелёный; 10 `it.todo` учтены как todo; turbo `pnpm test` выполняет тесты `apps/web`; в `apps/web/src/components/shell/` 7 файлов `*.int.test.tsx`; в `docs/.../test-skeletons/` файлов нет.
- **Failure response**: полифилы jsdom/base-ui — расширить `setup.ts`; несовместимость версий — эскалация.
- **Verification level**: L2.

## Proof Obligations
### Obligation: Failure Mode: missing config (FR-12 / AC-12.2)
- **Claim**: `lib/config.ts` бросает исключение при отсутствующем/неабсолютном/не-http(s) `NEXT_PUBLIC_API_URL`; срезает хвостовые `/`.
- **Primary failure mode**: убран срез `/` в конце или проверка протокола.
- **Boundary to exercise**: in-process unit (динамический импорт модуля).
- **State assertion**: N/A.
- **Mock boundary rationale**: env через `vi.stubEnv`; ничего больше не мокается.
- **Proven by**: `new: apps/web/src/lib/config.test.ts — таблица значений env` (ловит дефект «срез / или протокол пропущен», который не видит другой тест).
- **Residual**: `next build` падает без переменной (проверяется гейтом build).

## Completion Criteria
- [ ] `pnpm --filter web test` — `config.test.ts` зелёный, 10 `it.todo` учтены как todo; прогон содержательный (не 0 тестов)
- [ ] `pnpm test` из корня (turbo) выполняет тесты `apps/web`
- [ ] В `apps/web/src/components/shell/` 7 файлов `*.int.test.tsx`, в `docs/.../test-skeletons/` файлов нет
- [ ] lint, tsc, build — 0 ошибок
- [ ] Proof obligation: `config.test.ts` краснеет при удалении среза `/` или проверки протокола (мутация записана в Notes)
- [ ] Reference Contracts — `Y`; Resolved decisions применены

## Notes
- Impact scope: `src/test/*` используют все тестовые задачи; правка `src/test/*` позже — только через эскалацию.
- Scope boundary: скелеты не наполнять; `apps/api` не менять.
