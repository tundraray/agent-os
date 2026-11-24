# Настройки по ключу

## Problem

Модулю нужна группа значений, которые администратор меняет одной формой в панели и которые действуют на всю платформу: сроки сеанса, лимит ходов нового агента, пороги больших результатов, модели по умолчанию. Признак: значение — не секрет, его правят без рестарта, а переменная окружения запрещена (настройки — в базе и в панели).

## Shape

- **Таблица** `settings` в `packages/db`: строка на ключ. `key` — первичный ключ, CHECK `settings_key_check` пускает только ключи реестра; `value` — JSON группы; `updated_at` и `updated_by` (FK на `identity_users`, обнуление) пусты, пока стоят значения по умолчанию.
- **Ключ** — группа, которую администратор меняет одной формой. Имя ключа — и объект её записи аудита (`sign_in_settings`, `library_settings`, `tool_result_settings`, `model_defaults`).
- **Реестр ключей** — в `packages/contracts/src/settings.ts`: перечисление ключей и zod-схема значения каждого ключа. Правила между полями группы проверяет та же схема. Разбирает значение `parseSettingsValue`; значение вне схемы — сбой, а не значение по умолчанию.
- **Строки по умолчанию** создаёт миграция встроенных строк ([builtin-record.md](./builtin-record.md)). Строка ключа есть всегда, её отсутствие — сбой.
- **Репозиторий** `SettingsRepository` — чтение строки ключа, запись администратора со временем и автором, условная замена ([repository-over-transaction.md](./repository-over-transaction.md)).
- **Один писатель** — `SettingsService` в `apps/api/src/settings/`. `read` отдаёт разобранное значение, время и автора. `write` проверяет значение схемой ключа, заменяет строку и пишет одну `admin_change` с «было» и «стало» в транзакции вызывающего. `replaceIf` записывает значение, только если строка не изменилась с прочтения, без аудита и без смены времени и автора; это служебные записи вроде первого сохранения публичного адреса.
- **Сервис группы** — в модуле, который владеет значениями (`IdentitySettings`, `LibrarySettingsService`, модели по умолчанию в `AccessService`). Он читает и пишет через `SettingsService`, а правило поверх схемы проверяет до записи в той же транзакции. Маршруты `GET` и `PUT` стоят под `@AdminOnly()` ([auth-boundary.md](./auth-boundary.md)); ответ — значение с `updatedAt`.
- **Чтение** — там, где значение нужно, каждый раз заново, без кэша в памяти: правка действует со следующего чтения. Код вне `apps/api` читает строку через `SettingsRepository` и разбирает её схемой ключа (`readToolResultSettings` в `agents`); проверка сеанса получает значение ключа соединением в своём запросе (`IdentitySessionsRepository.findByTokenHash`).
- **Новый ключ** — схема в реестре и строка по умолчанию в миграции встроенных строк.

## Reference

- `apps/api/src/settings/settings.service.ts` — `SettingsService`
- `packages/contracts/src/settings.ts` — реестр ключей и `parseSettingsValue`
- `packages/db/src/repositories/settings.repository.ts` — `SettingsRepository`; таблица — `packages/db/src/schema/settings.ts`
- `apps/api/src/library/library-settings.ts` — сервис группы

## Not For

| Looks like | Use instead |
|---|---|
| секрет или адрес, который нужен до подключения к базе | переменная окружения, которую `apps/api` передаёт в `forRootAsync` модуля ([composition-root.md](./composition-root.md)) |
| секрет чужой системы, который задаёт администратор | [write-only-secret.md](./write-only-secret.md) |
| значение одной строки, которое правит её владелец | колонка этой строки или поле в версии агента |

## Used In

- [design-schema.md](../../features/data-model/design-schema.md) — таблица `settings`, реестр ключей и один писатель (KD-3)
- [design-agents.md](../../features/data-model/design-agents.md) — системная модель беседы — поле `chatModel` ключа `model_defaults` (KD-3)
- [design-memory.md](../../features/self-learning/design-memory.md) — размер оглавления памяти в ключе `self_learning_settings` (KD-6)
