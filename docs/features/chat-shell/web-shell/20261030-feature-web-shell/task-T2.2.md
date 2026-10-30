# Task T2.2: Unit-тесты клиента API, адаптеров списка и истории, `RetryGate` (характеризация с мутациями)

Metadata:
- Task type: frontend (apps/web) — тесты
- Phase: 2
- Dependencies: task-T2.1 → Deliverable: `apps/web/src/test/{setup,msw-server,fixtures}.ts`; модули T1.1 (`apps/web/src/lib/threads/*`)
- Provides: характеризационные тесты модулей спайка; Notes «Мутационные проверки»
- Size: Medium (4 новых тестовых файла + возможные исправления модулей T1.1)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- Тесты идут без API; Postgres 5433 / API не нужны. `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000` (в тестах — `http://api.test` из `vitest.config.ts`).
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны (в том числе правило 7 — мутации).

## Implementation Content
Характеризационные unit-тесты (MSW) модулей Phase 1: клиент API, адаптеры списка и истории, `RetryGate`. Для каждого правила исполнитель один раз ломает код (мутация) и фиксирует, что тест краснеет. Покрывает AC-01.7, AC-02.5, AC-04.3, AC-05.4 (S-6), AC-16.3 (клиент); Cross-Layer Assumption 7.

## Target Files
- [x] `apps/web/src/lib/threads/threads-api-client.test.ts` (new)
- [x] `apps/web/src/lib/threads/thread-list-adapter.test.ts` (new)
- [x] `apps/web/src/lib/threads/thread-history-adapter.test.ts` (new)
- [x] `apps/web/src/lib/threads/retry-gate.test.ts` (new)
- [x] (не потребовалось — дефектов не вскрыто, модули не менялись) Исправления в модулях T1.1 (`apps/web/src/lib/threads/{threads-api-client,thread-list-adapter,thread-history-adapter,retry-gate,shell-status-store,threads-api-error}.ts`), **только** если тест вскрыл дефект

## Investigation Targets
- Модули T1.1 в `apps/web/src/lib/threads/*`
- `apps/web/src/test/fixtures.ts`, `msw-server.ts`
- `packages/contracts/src/threads.ts`
- Reference Contract Values плана по `toRemoteMetadata`, `list({after})`, `DELETE` 404

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Fact Disposition, `contract:RemoteThreadMetadata-vs-ThreadSummary`) | derived-display | «`toRemoteMetadata`: `{ status: 'regular', remoteId: id, title: title ?? undefined, lastMessageAt: new Date(updatedAt) }`; `list({after})` → `?cursor=after`, `nextCursor: null` → `undefined`; `archive` отклоняется (UI архивирования нет), `generateTitle` — опросчик FR-20; `DELETE` 404 = успех (AC-16.3)» | Y, если тесты утверждают литеральные значения метаданных, курсор, `undefined` для `nextCursor: null`, успех для `DELETE` 404 |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Тесты после кода | Характеризационные; мутация обязательна для каждого правила (правило 7) | План, правило выполнения 7 |
| Моки | Только сеть (MSW); `lib/threads/*` и `@assistant-ui/*` не мокаются | Правило 6 |

## Investigation Notes
(Таблица мутаций: правило → мутация → какой кейс покраснел.)

Дефектов в модулях T1.1 тесты не вскрыли; модули не изменялись (`git diff -- apps/web/src/lib/threads` пуст). Мутации вносились скриптом точной заменой строки и откатывались записью исходных байтов (проверка sha256 до/после), без `git checkout`.

| # | Правило | Мутация | Покрасневшие кейсы |
|---|---|---|---|
| M1 | 400 на `:threadId` = `not_found` | `threads-api-client.ts`: `response.status === 400` → `=== 499` | client: «getThread: 400 on :threadId → not_found», «getThreadMessages: 400 on :threadId → not_found» |
| M2 | `initialize` ставит `ready` до возврата `remoteId` | `thread-list-adapter.ts`: `setHistory(thread.id, "ready")` обёрнут в `setTimeout(…, 0)` | list: «initialize marks the new thread's history ready by the time remoteId is returned» |
| M3 | `forget` вызывает `drop` | `thread-history-adapter.ts`: удалена строка `gate.drop(remoteId);` | history: «500 then forget rejects with ThreadsApiError('not_found'), makes no second request, drops the statuses» (таймаут) |
| M4 | `withFormat` отклоняет чужой формат | `thread-history-adapter.ts`: удалён `assertAiSdkV6Format(formatAdapter)` в `withFormat` | history: «withFormat rejects any format other than ai-sdk/v6 as a configuration error» |
| M5 | `DELETE` 404 = успех | `thread-list-adapter.ts`: `error.kind === "not_found"` → `=== "http"` | list: «DELETE 404 counts as success…», «DELETE 500 notifies deleteFailed…» |
| M6 | `nextCursor: null` → `undefined` | `page.nextCursor ?? undefined` → `?? ""` | list: «maps ThreadSummary to remote metadata and nextCursor null to undefined» |
| M7 | `PATCH` 500 → `renameFailed` | удалён `notify.renameFailed();` | list: «PATCH 500 notifies renameFailed and rejects so the runtime rolls back» |
| M8 | `retry` → `ready` | `retry: (remoteId) => gate.release(remoteId)` → `void remoteId` | history: «500 sets load_failed; retry loads again, sets ready and resolves» (таймаут) |
| M9 | `drop` отклоняет `not_found` | `retry-gate.ts`: `ThreadsApiError("not_found")` → `("network")` | gate: «drop rejects the parked waiter…», «release of one thread leaves the waiter of another thread parked» |
| M10 | провал `safeValidateUIMessages` → `invalid_response` | `if (!deep.success) return messages;` | client: «getThreadMessages: a part failing safeValidateUIMessages → invalid_response» |

Решения по тестам:
- `thread-history-adapter.test.ts` получает настоящий `AssistantClient` элемента списка через минимальный рантайм (`useRemoteThreadListRuntime` + `useChatRuntime`, `ThreadListPrimitive.ItemByIndex`): так `aui` не подделывается и не требует `as`. Элементы списка не монтируют рантайм треда, поэтому `load()` вызывает только тест. Файл `.ts` (JSX через `createElement`) — имя из Target Files.
- `API = 'http://api.test'` повторяется в трёх тестах как простая константа; общий хелпер не вводился (файлы `src/test/*` вне Target Files).
- Reference Contract: Y — литералы метаданных (`status: 'regular'`, `title: undefined` для `null`, `lastMessageAt: new Date('2026-10-28T10:00:00.000Z')`), `?cursor=cursor-2`, `nextCursor: undefined` для `null`, `DELETE` 404 → resolve + `deleted`, `archive` отклоняется.

## Implementation Steps (TDD: Red-Green-Refactor, характеризация)
### 1. Red Phase
- [x] Прочитать Investigation Targets
- [x] `threads-api-client.test.ts` (табличный): 200/невалидно → `invalid_response`; 404 и 400 на `:threadId` → `not_found`; сеть → `network`; провал `safeValidateUIMessages` → `invalid_response`; пустой `messages` → `[]` без ошибки
- [x] `thread-list-adapter.test.ts`: маппинг `ThreadSummary` → метаданные (литералы); `initialize` → `history[id] === 'ready'` до возврата `remoteId`; `nextCursor: null` → `undefined`; `loadMoreFailed` ставится/снимается; `DELETE` 404 → успех + `deleted`; `PATCH` 500 → `renameFailed` + отказ
- [x] `thread-history-adapter.test.ts`: цепочка `parentId`/`headId`; 404 → `not_found` + отказ; 500 → `load_failed`, `retry` → `ready` и разрешение; 500 → `load_failed`, `forget` → отказ `ThreadsApiError('not_found')`, второго запроса `/messages` нет, статусы удалены; не-`ai-sdk/v6` → ошибка конфигурации
- [x] `retry-gate.test.ts`: `release` разрешает; `drop` отклоняет `kind: 'not_found'`; без ожидающего — без ошибок; повторный `drop` после `release` — ничего
- [x] Запустить: тесты проходят/падают; при падении по реальному дефекту — исправить модуль T1.1

### 2. Green Phase
- [x] Исправить найденные дефекты модулей (минимально), тесты зелёные

### 3. Мутационная проверка (обязательна)
- [x] 400 перестаёт трактоваться как 404 → краснеет хотя бы один кейс
- [x] `initialize` ставит `ready` после возврата → краснеет
- [x] `forget` не вызывает `drop` → краснеет
- [x] `withFormat` пропускает чужой формат → краснеет
- [x] Мутации откатить; результат записать в Notes

### 4. Refactor Phase
- [x] Свести дубли фикстур; тесты зелёные

## Quality Assurance Mechanisms
- Vitest + MSW (`onUnhandledRequest: 'error'`) — Type: `executable_check`
- ESLint, `tsc` — Type: `executable_check`
- Test Selection (testing-principles): уникальный дефект, нижний достаточный уровень, без тавтологий — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: `pnpm --filter web test` (4 файла), lint, tsc.
- **Success criteria**: 4 файла зелёные; мутации краснят кейсы.
- **Failure response**: дефект модуля — исправить в Target Files; невозможность воспроизвести без изменения вне Target Files — эскалация.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-01.7 / AC-02.5 / AC-04.3 — классификация ошибок и статусы
- **Claim**: невалидный ответ → `invalid_response`; 400/404 на `:threadId` → `not_found`; 5xx истории → `load_failed` с рабочим `retry`.
- **Primary failure mode**: 400 перестаёт трактоваться как 404; `retry` не переводит в `ready`.
- **Boundary to exercise**: in-process unit через MSW (HTTP-граница).
- **State assertion**: `history[id]`: `loading` → `load_failed` → (`retry`) `ready`.
- **Mock boundary rationale**: сеть — MSW; остальное реальное.
- **Proven by**: `new: threads-api-client.test.ts — таблица классификации`; `new: thread-history-adapter.test.ts — retry/forget`.
- **Residual**: UI-представление статусов — T3.4/T4.2.

### Obligation: AC-05.4 / S-6 — откат и уведомление при отказе `rename`/`delete`
- **Claim**: `PATCH` 500 → `renameFailed` + отказ; `DELETE` 404 → успех + `deleted` (AC-16.3).
- **Primary failure mode**: отказ не пробрасывается (библиотека не откатывает); 404 трактуется как ошибка.
- **Boundary to exercise**: in-process unit (MSW).
- **State assertion**: N/A.
- **Mock boundary rationale**: `notify` — шпион; сеть — MSW.
- **Proven by**: `new: thread-list-adapter.test.ts — PATCH 500 / DELETE 404`.
- **Residual**: видимый откат в UI — L1-2.

### Obligation: Failure Mode: shared-state dependency — `forget`/`RetryGate`
- **Claim**: `forget` отклоняет ожидающего `not_found`, не делает второго запроса и очищает статусы.
- **Primary failure mode**: `forget` не вызывает `drop`.
- **Boundary to exercise**: in-process unit.
- **State assertion**: статусы удалены после `forget`.
- **Mock boundary rationale**: сеть — MSW.
- **Proven by**: `new: thread-history-adapter.test.ts — forget`; `new: retry-gate.test.ts`.
- **Residual**: нет.

## Completion Criteria
- [x] 4 файла зелёные; прогон содержательный (не 0 тестов, без skip)
- [x] Мутационная проверка записана в Notes (все четыре мутации краснят кейс)
- [x] lint, tsc — 0 ошибок
- [x] Reference Contract — `Y`

## Notes
- Impact scope: правки модулей T1.1 только при вскрытом дефекте.
- Scope boundary: файлы вне Target Files не менять.
