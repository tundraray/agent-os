# Чистая функция решения

## Problem

Правило по уже прочитанным данным решает, можно ли действие, какой у объекта статус или что делать дальше: разрешён ли запуск агента, доступен ли инструмент, какой статус показать, кончился ли ход. Признак: ветвление по полям данных, которое нужно проверить на многих сочетаниях, а его итог читают несколько мест.

## Shape

- **Функция решения** — одна экспортируемая функция в своём файле рядом с местом использования. Вход — один объект с уже прочитанными данными, выход — решение: значение из закрытого набора или объект с видом и причиной. Функция не читает базу, часы и окружение и ничего не пишет.
- **Вызывающий** — шаг, сервис или реализация порта — сам читает данные, зовёт функцию и исполняет решение: пишет строки, возвращает отказ, логирует причину. Если решение нужно нескольким местам, все зовут одну функцию, а не повторяют правило.
- **Проверка** — один табличный тест в файле `*.spec.ts` рядом: строка на сочетание входа с ожидаемым решением. Интеграционный тест проверяет только, что вызывающий подключил функцию, и не повторяет её случаи.

## Reference

- `packages/agents/src/tools/system/tool-gate.ts`

Тот же приём уже есть в `packages/agents/src/agent/turn-rules.ts`, `packages/agents/src/agent-view.ts` и `apps/api/src/chat/chat-status.ts`.

## Not For

| Looks like | Use instead |
|---|---|
| решение требует чтения из базы посреди правила | вызывающий читает всё до вызова функции; если данных слишком много, правило разделяется на шаги |
| изменение состояния с записью в транзакции | сервис над [repository-over-transaction.md](./repository-over-transaction.md) |
| правило одной строки, которое читает одно место | обычное условие в коде вызывающего |

## Used In

- [design-access.md](../../features/enterprise-access/design-access.md) — `effectiveAccess`: права, запреты и квоты сотрудника (KD-2)
- [design-library.md](../../features/custom-agents/design-library.md) — правила сохранения, аудитории и замены в копии
- [design-runtime.md](../../features/custom-agents/design-runtime.md) — `gateStart` и список чата `chatListing`
- [design-memory.md](../../features/self-learning/design-memory.md) — отказ `decideSave` флажку самообучения у агента по умолчанию (KD-4)
- [design-core.md](../../features/agent-harness/design-core.md) — обрезанный ответ в `endOfTurn` и правило повтора одинаковых вызовов (KD-3, KD-5)
- [design-agent-types.md](../../features/deep-agents/design-agent-types.md) — путь в отказе `decideSave`, запрет запуска глубокого агента в `gateStart` (KD-2, KD-4)
- [design-task.md](../../features/deep-agents/design-task.md) — проверка вызова `task` и таблица ответов; поля ответа и финальный сабагент из `task` в `endOfTurn`; ветки команды в `gateStart` нет (KD-5, KD-6, KD-7)
- [design-task-list.md](../../features/deep-agents/design-task-list.md) — правила списка задач сессии и открытые задачи в `endOfTurn` (KD-3, KD-4)
- [design-notepad.md](../../features/self-learning/design-notepad.md) — правило правки документа: дописать, заменить фрагмент, предел (`notepad-rules.ts`, KD-2, KD-5)
- [design-schedules.md](../../features/schedules-search-memory/design-schedules.md) — правило сроков (`schedule-rule.ts`), решение срока `decideRun` и статус запуска `runStatus` (KD-4, KD-7)
- [design-memory-hygiene.md](../../features/schedules-search-memory/design-memory-hygiene.md) — проверка записи памяти по шаблонам bb `memoryCheckReason` (KD-4)
