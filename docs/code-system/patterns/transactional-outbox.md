# Журнал событий с доставкой (transactional outbox)

## Problem

Изменение состояния должно стать видно наблюдателям и потребителям, и событие не может потеряться, если процесс умер сразу после изменения. Признак: код хочет, чтобы кто-то узнал о переходе задачи, решении или записи верхнего слоя.

## Shape

- **Событие** пишется в журнал событий runtime в той же транзакции, что и изменение: вместе с ним — строка доставки на каждого потребителя, зарегистрированного на этот тип, и NOTIFY. Runtime пишет свои события сам; верхний слой пишет своё событие в итоге шага (`effects.emit`), тип с префиксом своего пакета.
- **Потребитель** регистрируется в `EventConsumerRegistry` в `onModuleInit` своего модуля, до старта воркеров: имя, типы, обработка. Обработка работает только с базой в данной ей транзакции, без внешних вызовов; отметка «доставлено» фиксируется вместе с её записями.
- **Работа по событию** — потребитель создаёт задачу runtime в той же транзакции доставки (`TaskControl.create` с транзакцией), а внешнюю работу делает шаг этой задачи. Так на одно событие задача появляется ровно одна.
- **Доставка** (`OutboxRelay`) повторяет неудачную обработку с растущей паузой и после предела попыток ставит доставке статус `needs_attention`.
- **Наблюдатель**, которому не нужна гарантированная обработка, читает события дерева по номеру и просыпается от NOTIFY.

## Reference

- `packages/runtime/src/events/outbox.relay.ts` — доставка; `packages/runtime/src/events/event-log.ts` — запись события со строками доставок над `packages/db/src/repositories/runtime-events.repository.ts` и `runtime-event-deliveries.repository.ts`

## Not For

| Looks like | Use instead |
|---|---|
| сообщение задаче, отчёт или уведомление родителю | очередь сообщений задачи, где порядок — FIFO по получателю ([design-runtime.md](../../features/agent-platform/design-runtime.md), KD-3) |
| внешний вызов по событию | шаг задачи ([step-handler.md](./step-handler.md)) |

## Used In

- [design-runtime.md](../../features/agent-platform/design-runtime.md) — `EventLog`, `OutboxRelay`, `EventConsumerRegistry`
- [design-agents.md](../../features/agent-platform/design-agents.md) — событие `agents.history_appended`
- [design-core.md](../../features/self-learning/design-core.md) — `agents.knowledge-trigger` создаёт задачу `knowledge.extract` в транзакции доставки (KD-3)