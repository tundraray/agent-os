# ADR-0004 Агентский фреймворк — пакеты монорепозитория, `apps/api` — точка сборки

## Status

Accepted

## Decision

Runtime исследований связан с NestJS и чатом внутри `apps/api`, а оценке нужен движок, который собирается без сервера. Агентская система делится на приватные пакеты pnpm workspace в `packages/`, по одному на каждую границу владения, а `apps/api` (NestJS) остаётся только точкой сборки. Пакеты не зависят от NestJS: каждый отдаёт функцию сборки, а `apps/api` оборачивает её в модуль Nest. Модель схемы `app` и история миграций переезжают в `@agent-os/db`. Решения ADR-0001 и ADR-0003 не меняются; меняется место их исполнения и место контракта обработчика.

### Decision Details

| Item | Content |
|------|---------|
| **Why now** | Runtime уже связан с Nest, а `mcp-source` и движок ещё не собраны: позже переносить пришлось бы и их |
| **Known unknowns** | Нужен ли агентам движка экземпляр `Mastra` из `apps/api` — решает Design Doc `engine`; как матрица убийств запускает runtime без `nest build` — решает обновление `design-runtime.md` |
| **Kill criteria** | Два пакета меняются вместе в большинстве изменений — граница ложная, пакеты сливаются |

### Раскладка пакетов

Таблица перечисляет пакеты снизу вверх: чем каждый владеет и от чего зависит.

| Пакет | Чем владеет | Зависит от |
|---|---|---|
| `@agent-os/contracts` (есть) | zod-контракты API и данных runtime | — |
| `@agent-os/db` | пул `pg`, клиент Drizzle, модель схемы `app` всех фич, миграции и их проверка | contracts |
| `@agent-os/runtime` | задачи, события, outbox, восстановление, evidence; порт обработчика (`TaskHandler`, `TaskContext`, `HandlerResult`) | contracts, db |
| `@agent-os/sources` | `ToolExecutor`, `SourceAdapter`, клиент MCP, обработчик `source.fetch` | contracts, runtime |
| `@agent-os/engine` | реестр возможностей, контроллер, `ContextBuilder`, конфигурация процесса; агенты ролей на Mastra | всё выше, `@mastra/core` |
| `@agent-os/eval` | эталонный набор, прогоны H, B1, B2 и отчёты; вторая точка сборки — CLI, который читает окружение | engine и всё выше |
| `@agent-os/mcp-fixture` | тестовый MCP-сервер ([design-mcp-source.md](../features/research-runtime/design-mcp-source.md), KD-6) | — (только в devDependencies) |
| `apps/api` | HTTP, аутентификация, чат и беседы, модули Nest над пакетами, чтение окружения | рабочие пакеты |

Слои снизу вверх: contracts, db, runtime, sources, engine, eval. Пакет зависит только от слоёв ниже себя, `apps/api` стоит над всеми, а `apps/web` зависит только от contracts.

## Context

Runtime исследований живёт в `apps/api/src/research`, слой данных схемы `app` — в `src/database`, миграции — в `apps/api/migrations` ([ADR-0003](ADR-0003-drizzle-data-layer.md)). Runtime связан с Nest декораторами DI, `Logger` и `ConfigService`, а владельца беседы проверяет прямо через `ThreadsService`. Поэтому его тесты с Postgres поднимают весь `AppModule` с Mastra и чатом.

Дальше на runtime строятся `mcp-source` (спроектирован, не собран), движок глубокого исследования и оценка ([deep-research/prd.md](../features/deep-research/prd.md), Delivery Parts); оценка запускает движок без сервера. Ограничения того же PRD (Constraints) требуют фреймворка из приватных пакетов, где `apps/api` — только точка входа, а граница [ADR-0001](ADR-0001-durable-runtime-owner.md) сохраняется.

## Rationale

Каждая граница пакета совпадает со своим владельцем данных или своей внешней зависимостью. Таблицы `app` и единая история миграций нужны runtime, движку и `apps/api` (`chat-storage`), поэтому миграции не могут жить ни в одном из потребителей. Runtime без `@mastra/*` в зависимостях делает запрет ADR-0001 свойством сборки, а MCP SDK уходит в sources, и runtime о MCP не знает. Дальнейшее дробление ничем не оправдано: у контроллера, контекста или моделей по одному потребителю.

Без NestJS пакеты собирает и оценка, и тест runtime без `AppModule`. Это самая дорогая часть решения: DI runtime переписывается, а старт и остановка по хукам Nest (`design-runtime.md`, KD-7) переходят в связывание `apps/api`. Эта цена принята против варианта 3 ниже, который переносит Nest в каждый пакет и в CLI оценки.

### Options Considered

1. **Мелкие пакеты по компонентам** — отдельно клиент MCP, контроллер, `ContextBuilder`, модели, тестовые двойники
   - Pros: У каждого пакета самый узкий вход.
   - Cons: У большинства пакетов один потребитель, и граница ничего не защищает. Правка контракта идёт через несколько сборок.

2. **Крупный пакет `@agent-os/framework`** — данные, runtime и источники в папках за одним входом, engine и eval отдельно
   - Pros: Пакетов и сборок меньше.
   - Cons: Границы внутри пакета держит только lint. MCP SDK становится зависимостью runtime, а таблицы чата живут в пакете runtime.

3. **Пакеты — динамические модули Nest** — те же границы, но каждый пакет отдаёт модуль Nest с провайдерами, а `apps/api` импортирует эти модули
   - Pros:
     - DI не переписывается: классы `@Injectable` модуля `research` переезжают как есть.
     - Старт и остановка по хукам Nest (`design-runtime.md`, KD-7) сохраняются.
     - Тест с Postgres собирает только модули runtime и db, без `AppModule`.
   - Cons:
     - Каждый пакет и оценка несут `@nestjs/*` и метаданные декораторов.
     - CLI оценки поднимает контейнер Nest ради запуска движка.
     - Порт вместо `ThreadsService` нужен и здесь, так что связь runtime с чатом этот вариант не снимает.

4. **Пакеты по границам владения (выбран)**
   - Pros: Запрет Mastra и порядок слоёв держатся объявленными зависимостями, а не только lint. Оценка и тесты собирают пакеты без Nest.
   - Cons: Появляется несколько новых сборок, и правку пакета потребители видят только после его сборки.

Место модели и миграций сравнивалось отдельно. Таблицы в пакетах-владельцах меняют правило ADR-0003 «модель — один модуль» и разносят таблицу и её миграцию по разным пакетам. Миграции в `apps/api` заставили бы тесты пакетов зависеть от приложения, то есть вверх.

## Consequences

### Positive Consequences

- Запрет Mastra в db, runtime и sources проверяют и объявленные зависимости (knip в CI), и lint
- Тесты runtime с Postgres и матрица убийств поднимают только runtime и db
- Оценка собирает движок теми же функциями сборки, что `apps/api`

### Negative Consequences

- Перенос runtime переписывает DI: декораторы уходят, `ThreadsService` становится портом, логгер и настройки приходят из точки сборки
- Обвязка тестов с Postgres нужна каждому пакету с интеграционными тестами

### Neutral Consequences

- Схема `app`, префиксы таблиц и история миграций не меняются; меняется каталог
- Модуль `research` из ADR-0001 теперь пакет `@agent-os/runtime`
- Порт обработчика (`TaskHandler`, `TaskContext`, `HandlerResult`), который ADR-0001 относит к `packages/contracts`, живёт в `@agent-os/runtime`. Zod-схемы данных, включая `HandlerResultSchema`, исходы и покрытие, остаются в contracts

## Implementation Guidance

- Пакет приватный и открывает в `exports` один вход `.`; вход `./testing` допустим только для тестовых двойников контракта пакета
- Подпути пакета закрыты дважды: `exports` их не открывает, а `no-restricted-imports` запрещает любой подпуть `@agent-os/*`, кроме `testing`. В oxlint 1.90.0 это шаблоны `@agent-os/*/**` и `!@agent-os/*/testing`
- Относительный путь в чужой пакет ломает сборку: `tsc` собирает пакет с `rootDir: src` и отвергает файл вне этого каталога
- Пакеты потребляются как собранный `dist` через `exports`, как `@agent-os/contracts`. Собирает их `tsc` в порядке графа Turborepo, а при локальной разработке пакеты собираются в режиме watch
- Зависимость идёт только вниз по слоям и объявлена в `package.json`; цикл отвергает turbo, необъявленный импорт отмечает knip
- Пакеты не импортируют `@nestjs/*`: функция сборки принимает настройки и порты (логгер, часы, владелец беседы) и отдаёт сервисы со стартом и остановкой; `apps/api` привязывает их к хукам Nest
- Окружение читают только точки сборки: `apps/api` и вход CLI пакета eval. Остальной код в `packages/`, включая функции сборки eval, получает настройки параметрами
- Чужой домен приходит в пакет портом: runtime не знает о беседах, проверку владельца и хук удаления беседы связывает `apps/api`
- `@mastra/*` объявляют только engine, eval и `apps/api`; правила ADR-0001 действуют в пакетах так же, как в приложении
- Запрет импорта `@mastra/*` остаётся в lint пакетов db, runtime и sources: проверку одних зависимостей обходит добавление зависимости
- Таблицы фичи объявляются в модели схемы `app` в `@agent-os/db`, миграции генерируются там же
- Тест живёт в пакете, чьё поведение доказывает; в `apps/api` остаются HTTP-тесты чата и бесед и тест связывания пакетов

## Related Information

- [ADR-0001](ADR-0001-durable-runtime-owner.md) — runtime как durable-владелец, граница с Mastra; этим ADR не правится
- [ADR-0003](ADR-0003-drizzle-data-layer.md) — Drizzle, схема `app`, миграции; этим ADR не правится, как и ADR-0002 и `research-runtime/prd.md`
- [design-runtime.md](../features/research-runtime/design-runtime.md) приводится в соответствие этому ADR:
  - C2–C4 и расположение кода переходят в runtime и db
  - DI Nest (`DatabaseModule`, `DRIZZLE`, `ResearchModule`) заменяется функцией сборки
  - старт и остановка по хукам Nest (KD-7) переходят в связывание `apps/api`
  - `ThreadsService` становится портом
  - порт обработчика (`TaskHandler`, `TaskContext`, `HandlerResult`) в Snapshot числится в runtime, а zod-схемы — в contracts
  - тесты, матрица убийств и CI-задача `e2e-runtime` переходят в пакет runtime
- [design-mcp-source.md](../features/research-runtime/design-mcp-source.md) приводится в соответствие этому ADR: модуль `sources` становится пакетом вместе с `@modelcontextprotocol/client`, allowlist приходит из точки сборки, тесты `research-runtime-mcp-source` переходят в пакет sources
- [deep-research/prd.md](../features/deep-research/prd.md) — Constraints ссылаются на этот ADR; Delivery Parts
- [Node.js — Package entry points](https://nodejs.org/api/packages.html#package-entry-points) — `exports` закрывает неперечисленные подпути
- [knip — Unlisted dependencies](https://knip.dev/guides/handling-issues#unlisted-dependencies) — импорт необъявленного пакета
