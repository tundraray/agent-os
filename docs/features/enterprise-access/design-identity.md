# Корпоративный вход и управление доступом — Design Document — identity

**Status:** На утверждении · **Date:** 2026-11-15 · **PRD:** [prd.md](./prd.md) · **UXRD:** [uxrd.md](./uxrd.md) · **Depends on:** ничего — первая часть

## Snapshot

**Overview.** Сегодня сервер верит заголовку `x-user-id`, а без него считает каждого тестовым сотрудником `dev-user`. Эта часть даёт настоящий вход: по логину и паролю, который включён всегда, и через провайдеров, которых администратор подключил, — Google, Facebook, GitHub, корпоративный IdP по OIDC или SAML; сотрудника узнают по логину или по почте от провайдера. Сервер открывает сеанс — случайный токен в cookie и строку в базе, — и одна проверка на входе в API узнаёт по нему сотрудника, а без сеанса пропускает только вход, SCIM и проверку здоровья. Первого администратора оператор заводит командой, которая пишет в базу локальную учётную запись со встроенной ролью «Супер-администратор»; остальное хранится в базе и правится в панели. Отключение закрывает сеансы и останавливает работу сотрудника без единого нового вызова модели или инструмента, а входы и изменения администратора пишутся в аудит.

- **Не меняется**: беседы, агенты и расход по-прежнему принадлежат строке владельца в своих таблицах; контроллеры берут её из `req.user.id`, как сейчас. Панель администратора и её пункт в меню строит `admin`.
- **Biggest risk**: почте от провайдера платформа доверяет как есть, поэтому провайдер, где человек может назвать любую почту, пустит его под чужой учётной записью — защита в том, что провайдеров подключает только администратор (PRD, Risks; [Risks and Mitigation](#risks-and-mitigation)).
- **Open questions**: нет.

### Key Decisions

#### KD-1: Один провайдер — тип и настройки этого типа; OAuth 2.0 и OIDC ведёт `openid-client`, SAML — `samlify`, сервер SCIM пишется своими руками

Провайдер — строка `identity_providers`: тип из закрытого списка, название кнопки, включён ли, и настройки, которые проверяет схема типа. Новый тип — это новая схема и, для OAuth 2.0 без OIDC, адрес профиля.

| Тип | Протокол | Настройки администратора | Откуда почта и имя |
|---|---|---|---|
| `google` | OIDC, издатель `https://accounts.google.com` | `clientId`, `clientSecret` | ID-токен |
| `oidc` | OIDC с discovery | `issuer`, `clientId`, `clientSecret` | ID-токен; группы — claim `groups` |
| `github` | OAuth 2.0 | `clientId`, `clientSecret` | `GET /user` и основная почта из `GET /user/emails` (скоуп `user:email`) |
| `facebook` | OAuth 2.0 | `clientId` (App ID), `clientSecret` (App Secret) | Graph API `/me` с полями `name`, `email` (разрешение `email`) |
| `saml` | SAML 2.0 | `metadataUrl` | атрибуты `email`, `name`, `groups` |

`openid-client` 6 ведёт поток authorization code для всех четырёх OAuth-типов: у `google` и `oidc` — с discovery и проверкой ID-токена, у `github` и `facebook` — по постоянным адресам кода и с чтением профиля по токену доступа (`new Configuration`, `fetchProtectedResource`; [документация](https://github.com/panva/openid-client/blob/v6.8.9/docs/classes/Configuration.md)). OIDC-входа у GitHub нет, а почта приходит списком с признаком `primary` ([GitHub REST](https://docs.github.com/en/rest/users/emails?apiVersion=2022-11-28)); OIDC веб-входа Facebook документация называет тестовым ([Facebook Login](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow)). `samlify` проверяет ответ SAML, читает метаданные IdP и в тестах играет роль IdP ([документация](https://github.com/tngan/samlify/blob/master/docs/README.md)). SCIM — несколько маршрутов `Users` и `Groups`, которые пишут прямо в наши таблицы; включается он токеном у провайдера `oidc` или `saml`.

Варианты, которые не взяты:

- **Better Auth.** Вход по паролю, Google, Facebook и GitHub у него есть, но социальных провайдеров он настраивает в коде при старте, а не в базе, поэтому правка провайдера требовала бы рестарта (AC-03.3). Провайдеры OIDC и SAML его плагин SSO хранит в базе, но вместе с ними приходят свои таблицы пользователей, сеансов и семь таблиц SCIM ([схема SCIM](https://github.com/better-auth/better-auth/blob/v1.7.15/docs/content/docs/plugins/scim/reference.mdx)) — второе место правды о сотруднике.
- **Стратегии passport.** Это обёртки над теми же протоколами с сеансом Express; сеанс и проверка у нас свои (KD-2, KD-3), поэтому слой passport ничего не добавляет.
- **Таблица на каждый тип.** Пять таблиц с одинаковыми полями «название, включён, секрет» и пять наборов операций администратора ради разных настроек, которые схема типа проверяет и в одной таблице.
- **`@node-saml/node-saml` вместо `samlify`.** Он не читает метаданные IdP и не умеет быть IdP для тестов. Уязвимости подписи были у обоих; `samlify` берётся не ниже 2.13.0 ([CVE-2025-47949](https://advisories.gitlab.com/npm/samlify/CVE-2025-47949/), [CVE-2026-46490](https://nvd.nist.gov/vuln/detail/CVE-2026-46490)).

#### KD-2: Сеанс — случайный токен в cookie `HttpOnly; SameSite=Lax` и строка в базе с хешем токена; сроки сеанса и публичный адрес — настройки в `identity_settings`; изменяющие запросы проверяют `Origin`

Браузер хранит 32 случайных байта в cookie `aos_session`, а база — только SHA-256 от них, поэтому выход и отключение действуют сразу на всех экземплярах. Сеанс кончается после срока без запросов или после общего срока; оба — настройки администратора (по умолчанию 8 и 24 часа). Сервер считает сроки от времени входа и последнего запроса, а не хранит их в сеансе, поэтому новое значение действует со следующего запроса (FR-07).

Настройки части лежат в одной строке таблицы `identity_settings` — по столбцу с проверкой границ на каждую настройку: сроки сеанса и публичный адрес Agent OS, на который провайдеры возвращают сотрудника. Пока адрес не сохранён, первое сохранение провайдера записывает адрес, по которому браузер обратился к API (AC-03.4). Проверка сеанса читает эту строку в том же запросе, что сеанс и сотрудника, поэтому лишнего чтения из базы на запрос нет. По этому образцу часть `access` хранит свою настройку в одной строке `access_settings`.

Веб и API — один сайт и в разработке (порты `localhost`), и за nginx, поэтому cookie с `SameSite=Lax` уходит с `fetch` и `EventSource`. `Lax` не пускает cookie в межсайтовый `POST`, а у изменяющего запроса с cookie сервер ещё сверяет `Origin` с `FRONTEND_ORIGIN` (DC-3).

Варианты, которые не взяты:

- **JWT в cookie без строки в базе.** Отключение и выход не действовали бы до истечения токена, а AC-07.2 требует отказа со следующего запроса.
- **Токен с CSRF двойной отправкой.** Он требует от веба читать и пересылать второй токен в каждом запросе; проверка `Origin` даёт ту же защиту без изменений веба.

#### KD-3: Одна глобальная проверка сеанса с пометкой открытых маршрутов; сотрудник — строка `identity_users` с UUID, который выдаёт сервер

`SessionGuard` становится глобальным и асинхронным. Он пропускает только маршруты с пометкой `@Public()`, а маршрут с пометкой `@AdminOnly()` пускает только сотрудника с правом администратора. Новый контроллер закрыт, пока его не пометили открытым: забытая пометка даёт отказ, а не дыру (NFR-03). В `req.user` лежит `AuthUser`: `id`, `email`, `name`, `isAdmin` и `sessionId`. `id` — это `identity_users.id`, UUID, который сервер создаёт сам: для локальной учётной записи, при JIT, при `POST /Users` по SCIM и командой оператора. Строка с префиксом `system:` в UUID не помещается, поэтому AC-04.4 держит тип столбца. Поле `roles` уходит: его никто не читает.

Шесть столбцов `owner_id` и `runtime_inbox.sender` остаются текстом без внешнего ключа и хранят тот же `id`. Обработчики вида `const ownerId = req.user.id` не меняются, а поиск «чужое отвечает как отсутствующее» работает как прежде. Заголовок `x-user-id`, `dev-user`, `DEV_USER` в вебе, `system-owners.ts` и тест заглушки удаляются; веб узнаёт сотрудника из `GET /api/auth/me` (C3 · web), а разработчик и e2e-тесты входят по логину и паролю (Test Strategy).

Варианты, которые не взяты:

- **Почта или идентификатор провайдера как идентификатор.** Почта меняется (AC-05.2), у сотрудника бывает несколько способов входа (AC-04.2), а строка от провайдера могла бы начаться с `system:`.
- **Внешний ключ из `owner_id` на `identity_users`.** Он привязал бы таблицы `runtime` и `agents` к слою приложения, против правила слоёв (code-system README), и запретил бы служебных владельцев.
- **Проверка на каждом контроллере, как сейчас.** Новый контроллер был бы открыт по умолчанию.

Решение записано в [ADR-0012](../../adr/ADR-0012-closed-api-and-server-issued-employee-id.md).

#### KD-4: Отключение — одна операция для SCIM и панели; она останавливает работу сотрудника, а порт `OwnerGate` закрывает гонки перед каждым вызовом модели и инструмента

`UsersService.disable` в одной транзакции ставит сотруднику статус `disabled`, завершает его сеансы с причиной `account_disabled`, шлёт `NOTIFY identity_sessions_closed` и пишет аудит. После фиксации новая операция runtime `TaskControl.stopOwner` останавливает все незавершённые задачи сотрудника с причиной `owner_disabled`. Каждый экземпляр получает NOTIFY: `LiveHub` закрывает потоки SSE сотрудника, а шаги в полёте получают сигнал остановки, как при обычной остановке.

Запрос, который прошёл проверку сеанса за миллисекунду до отключения, ещё может создать задачу. Поэтому `createAgents` получает порт `OwnerGate`, и агенты спрашивают его перед каждым вызовом модели (`ModelClient.call`, `ModelClient.completeText`) и инструмента (`ToolRunner`). Для отключённого или неизвестного владельца порт сам вызывает `stopOwner` и бросает `OWNER_DISABLED`, и вызов не начинается. Так «ни одного вызова после отключения» держит одно место у самого вызова, а не порядок операций (DC-8). Часть `access` строит одну проверку прав перед теми же вызовами (FR-18) и может вобрать этот порт.

Варианты, которые не взяты:

- **Только `stopOwner` без порта.** Задача из гонки выше прожила бы до следующей остановки.
- **Только порт без `stopOwner`.** Агент, который ждёт сообщений, остался бы в статусе «ждёт», а AC-07.2 требует «остановлен».
- **Проверка статуса сотрудника в runtime при захвате шага.** Runtime не знает о сотрудниках (правило слоёв).

#### KD-5: Пароль хранится хешем argon2id из `node:crypto`; неверный логин и неверный пароль дают одну причину; после 5 неудач подряд введённый логин закрыт на 15 минут, есть он или нет

Хеш — argon2id со случайной солью 16 байт и параметрами из минимума OWASP: память 19 МиБ, 2 прохода, 1 поток ([OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)). Он хранится одной строкой вместе с параметрами, поэтому параметры можно поднять позже, не меняя строк. Argon2 есть в `node:crypto` с Node 24.7, а в документации Node 26 у `crypto.argon2` нет своей отметки стабильности, то есть действует отметка модуля «Stable» ([Node 26 crypto](https://nodejs.org/api/crypto.html)); новой зависимости не нужно.

Неверный логин и неверный пароль отвечают одним кодом `INVALID_CREDENTIALS`, а для неизвестного логина сервер всё равно считает хеш, чтобы время ответа не выдавало, есть ли логин. Неудачи считаются по введённому логину, а не по сотруднику: пятая подряд закрывает этот логин на 15 минут, и любая попытка с ним получает 429 `TOO_MANY_ATTEMPTS` (`uxrd.md` MC-3 «Слишком много попыток»). Закрываются и несуществующие логины, поэтому ответ не выдаёт, есть ли учётная запись. Успешный вход, сброс пароля администратором и команда оператора обнуляют счётчик, а каждая попытка пишется в аудит с настоящей причиной (DC-14). Пароль — от 12 до 256 знаков; другого правила сложности нет. Сброс пароля администратором завершает все сеансы сотрудника, а смена своего пароля — нет.

Варианты, которые не взяты:

- **`scrypt` из `node:crypto` или пакет `argon2`.** `scrypt` OWASP ставит после argon2id, а пакет — нативная зависимость ради того, что уже есть в Node 26.
- **Предел попыток по адресу клиента.** За прокси компании многие сотрудники приходят с одного адреса, и предел закрывал бы вход всем; предел по логину защищает ту учётную запись, которую подбирают.
- **Счётчик в строке сотрудника и ответ `INVALID_CREDENTIALS` при закрытии.** Сотрудник не узнал бы, что логин закрыт, а отдельный ответ только для существующих логинов выдал бы, какие логины есть.

#### KD-6: Членство в ролях из IdP вычисляется из групп сотрудника при чтении; встроенная роль «Супер-администратор» неизменяема; первого администратора заводит команда оператора; последнего администратора сторожит advisory-блокировка

У сотрудника хранится набор имён его групп IdP. Вход через `oidc` или `saml` заменяет набор целиком тем, что прислал провайдер, а SCIM `Groups` добавляет и убирает членов (FR-06). Вход по паролю и через `google`, `github`, `facebook` групп не присылает и набор не трогает (AC-06.5). Роль хранит сопоставленные имена групп, поэтому членство «из IdP» — это пересечение групп сотрудника с группами роли. Назначение в панели — отдельная строка, и IdP её не трогает (AC-06.3, AC-06.4). Право администратора дают пометка роли или личная пометка сотрудника.

Роль «Супер-администратор» создаёт миграция с пометкой встроенной; её нельзя удалить, переименовать и лишить права администратора (DC-15), потому что на ней держится возврат доступа (FR-32). Назначают и снимают её как любую роль. Оператор запускает `pnpm --filter api identity:super-admin` с логином, именем и почтой, а пароль команда читает из стандартного ввода, чтобы он не остался в истории оболочки. Команда создаёт или находит по логину локальную учётную запись, задаёт пароль, обнуляет счётчик неудач, включает её, назначает встроенную роль и пишет `admin_change` с исполнителем `system`. Она идёт отдельно от сервера, как миграции, с существующим `DATABASE_URL`.

Каждое изменение в панели, которое может снять последнего администратора, берёт транзакционную advisory-блокировку `identity.admins`. Под блокировкой сервер считает включённых сотрудников с правом после изменения и при нуле отклоняет изменение кодом `LAST_ADMIN` (AC-08.3). Изменения от IdP блокировку берут, но не отклоняются: при нуле они пишут в аудит и лог `last_admin_removed` (AC-08.4).

Варианты, которые не взяты:

- **Строка SQL вместо команды.** Хеш argon2id вручную не написать, а команда делает ровно то, что требует FR-32, без экрана и без настроек окружения.
- **Хранить членство из IdP строками и пересчитывать при каждом изменении групп.** Это второе место правды, которое расходится с группами при сбое посреди пересчёта.
- **Проверка последнего администратора без блокировки.** Две встречные транзакции видели бы по одному оставшемуся администратору.

#### KD-7: Секреты провайдеров хранятся как есть; наружу секрет не выходит, а `AuditLog` пишет в транзакции изменения и маскирует секреты

Шифрования секретов нет (PRD, Won't Have): ключ шифрования пришлось бы хранить вне базы, а тот, у кого есть база или её копия, получает секреты провайдеров — риск принят (PRD, Risks). Остаётся: ответ сервера не возвращает секрет, только признак «задан»; секрет не пишется в лог; пароли, токен сеанса и токен SCIM хранятся хешами (NFR-01). [ADR-0013](../../adr/ADR-0013-sealed-secret-format.md) (Deprecated) больше не применяется.

`AuditLog.record` пишет запись в транзакции той операции, которую описывает: изменение администратора и его запись фиксируются или откатываются вместе. Отказы и входы пишутся в своей короткой транзакции. Запись несёт вид, исполнителя, объект, «было», «стало», исход и причину. Поля с именами секретов и паролей `AuditLog` заменяет пометками `secret_changed` и `password_changed` по тому же списку имён, что логгер (AC-11.2). Части `mcp-connect` и `access` пишут свои записи через этот же `AuditLog`. `AuditService` (сырой DDL вне Drizzle, буфер, который теряется при падении) и перехватчик «метод и маршрут на каждый запрос» удаляются.

## Terms

- **Запрос входа** — одноразовая строка между уходом браузера к провайдеру и возвратом: какой провайдер, куда вернуть, чем проверить ответ. Живёт 10 минут.
- **Привязка к браузеру** — cookie `aos_login` со случайным значением, хеш которого лежит в запросе входа. Ответ провайдера принимается только в том браузере, который начал вход.
- **`OwnerGate`** — порт агентов «может ли владелец работать», который спрашивают перед каждым вызовом модели и инструмента (KD-4).

## Part

- **Part**: `identity`
- **Covers**: FR-01, FR-02, FR-03, FR-04, FR-05, FR-06, FR-07, FR-08, FR-11, FR-32, FR-33; NFR-01, NFR-02, NFR-03 в части секретов и маршрутов этой части
- **Depends on**: none — first part
- **Prerequisite ADRs**: [ADR-0001](../../adr/ADR-0001-durable-runtime-owner.md) (состояние в Postgres), [ADR-0003](../../adr/ADR-0003-drizzle-data-layer.md) (Drizzle, схема `app`, миграции отдельной командой), [ADR-0004](../../adr/ADR-0004-agent-framework-packages.md) (пакеты не читают окружение, порты параметрами), [ADR-0012](../../adr/ADR-0012-closed-api-and-server-issued-employee-id.md) (закрытый API и UUID сотрудника)
- **Sibling parts**: `mcp-connect` (FR-12–FR-15), `access` (FR-16–FR-23), `admin` (FR-24–FR-31)

**Out of scope**

- Панель с разделом «Авторизация» — часть `admin`; подключения и модели на «Мой доступ» (`uxrd.md` MA-01, MA-02) — `mcp-connect` и `access`. Из экранов эта часть строит страницу входа, имя, почту и «Выйти» в меню, переход на вход по 401 и страницу «Мой доступ» с одной секцией «Пароль» (MA-03) (PRD, Delivery Parts).
- Права на серверы, инструменты и модели, их проверка и замена `MCP_ACCESS_TABLE` — часть `access`; до неё таблица живёт по правилу из Constraints.
- Маршрут nginx для `/api/events` без буферизации: это существующая настройка доставки потока, а не вход.
- Регистрация по логину и паролю, восстановление пароля по почте, MFA, выход из IdP и вход, начатый в IdP (PRD, Won't Have).

**Constraints**

- PoC без обратной совместимости: заглушка и всё, что от неё зависит, заменяются сразу, существующие строки с `dev-user` не переносятся (PRD, Constraints).
- Фича не добавляет переменных окружения: настройки входа лежат в `identity_settings`, провайдеры — в `identity_providers`, а база берётся из существующего `DATABASE_URL`.
- Части строятся по порядку `identity` → `mcp-connect` → `access`. Пока `access` не собрана, `MCP_ACCESS_TABLE` остаётся и ключуется `identity_users.id`; ключ `*` даёт серверы каждому сотруднику, и `.env.example` использует его.
- Логи идут через логгер `packages/common` с идентификаторами сотрудника, сеанса, провайдера и запроса входа; пароли, токены, коды, ответы провайдеров и секреты в лог не попадают (Security Considerations).

## Building-block Inventory

Follows the [code system](../../code-system/README.md). Поиск перед «new» шёл по `docs/code-system/`, `apps/api/src`, `packages/*/src` (`auth`, `session`, `password`, `hash`, `scim`, `saml`, `oidc`, `oauth`, `audit`): входа, паролей и SCIM в коде нет, есть только заглушка `SessionGuard` и `AuditService`.

| Building block | Pattern | Status | Note |
|---|---|---|---|
| `SessionGuard`, `@Public()`, `@AdminOnly()` | [auth-boundary.md](../../code-system/patterns/auth-boundary.md) (KD-3) | extended | Глобальная проверка вместо заглушки |
| `IdentityModule` в `apps/api/src/identity` | [repository-over-transaction.md](../../code-system/patterns/repository-over-transaction.md) | new | Таблицы `identity_*` в `packages/db`, как `chat_conversations` |
| `OAuthSignIn`, `SamlSignIn`, `PasswordSignIn` | — | new | Обёртки над `openid-client`, `samlify` и `node:crypto` (KD-1, KD-5) |
| `ScimController` | [auth-boundary.md](../../code-system/patterns/auth-boundary.md) | new | Открыт для сеанса, закрыт токеном провайдера |
| Команда `identity:super-admin` | — | new | Отдельный вход `apps/api`, как `migrate-cli` (KD-6) |
| Логгер `packages/common` | [logging.md](../../code-system/patterns/logging.md) | extended | Новые имена полей |
| `AuditLog` | [repository-over-transaction.md](../../code-system/patterns/repository-over-transaction.md) | new | Вместо `AuditService` (KD-7) |
| `TaskControl.stopOwner`, причина остановки | [step-handler.md](../../code-system/patterns/step-handler.md) | extended | Остановка всех задач владельца с причиной; шаг в полёте отсекается, как при обычной остановке (KD-4) |
| `OwnerGate` в `createAgents` | [composition-root.md](../../code-system/patterns/composition-root.md) | extended | Новый порт функции сборки (KD-4) |
| `LiveHub` | [transactional-outbox.md](../../code-system/patterns/transactional-outbox.md) | extended | Наблюдатель по NOTIFY: слушает `identity_sessions_closed`, закрывает потоки сеанса |
| Страница `/login` веба | [shell-route.md](../../code-system/patterns/shell-route.md), Not For | new | Своя страница вне группы `(chat)` |
| Страница «Мой доступ» с секцией MA-03 | [shell-route.md](../../code-system/patterns/shell-route.md) | new | Экран в оболочке; другие части добавляют секции |
| `UserMenu` веба | — | extended | Имя и почта из `GET /api/auth/me` вместо `DEV_USER`, «Выйти»; паттерна code-system нет, меню следует chat-shell UXRD SB-11 |
| Клиенты API веба (`lib/threads`, поток событий) | [web-api-client.md](../../code-system/patterns/web-api-client.md) | extended | Один обработчик ответа 401: переход на вход |

## Acceptance Criteria

### FR-01: Вход по логину и паролю

- From the PRD: AC-01.1, AC-01.2, AC-01.3, AC-01.4, AC-01.5, AC-01.6
- Запрос без действующего сеанса к любому маршруту, кроме открытых (вход, SCIM, `GET /api/health`), получает 401 с `errorCode` `AUTH_REQUIRED` (DC-1).
- Изменяющий запрос с cookie сеанса и с `Origin`, отличным от `FRONTEND_ORIGIN` или пустым, получает 403 `ORIGIN_REJECTED` и ничего не меняет (DC-3).
- После пяти неудачных попыток подряд введённый логин, существующий или нет, закрыт на 15 минут: любая попытка с ним, даже с верным паролем, получает 429 `TOO_MANY_ATTEMPTS`, а аудит пишет причину `locked`; успешный вход, сброс пароля и команда оператора обнуляют счётчик (DC-14).
- Ответ 401 на любой запрос веба, в том числе обрыв потока событий без сеанса, переводит вкладку на `/login` с причиной («Сеанс закончился» или «учётная запись отключена», `uxrd.md` MC-3) и адресом текущей страницы; после входа сотрудник возвращается на неё (DC-13).

### FR-02: Вход через провайдера

- From the PRD: AC-02.1, AC-02.2, AC-02.3, AC-02.5
- Ответ провайдера принимается один раз и только в браузере, который начал вход, не позже 10 минут после начала; повтор, чужой браузер или опоздание отклоняют вход с причиной `failed` (DC-4).

### FR-03: Провайдеры входа

- From the PRD: AC-03.1, AC-03.2, AC-03.3, AC-03.4, AC-03.5
- Провайдер создаётся выключенным по типу и названию, и его «Данные для провайдера» известны сразу после создания. Сохранение настроек `oidc` и `saml` проверяет их по сети: discovery издателя или метаданные по адресу; при неудаче настройки не сохраняются, а ответ — 422 `PROVIDER_CHECK_FAILED`. Включить провайдера без полных настроек его типа нельзя: 409 `PROVIDER_INCOMPLETE` (DC-6).

### FR-04: Учётная запись сотрудника

- From the PRD: AC-04.1, AC-04.2, AC-04.3, AC-04.4, AC-04.5

### FR-05: Синхронизация через SCIM 2.0

- From the PRD: AC-05.1, AC-05.2, AC-05.3, AC-05.4

### FR-06: Роли и членство из двух источников

- From the PRD: AC-06.1, AC-06.2, AC-06.3, AC-06.4, AC-06.5

### FR-07: Сеанс входа, выход и отключение

- From the PRD: AC-07.1, AC-07.2, AC-07.3, AC-07.4, AC-07.5
- Сеанс кончается по сроку без запросов или по общему сроку из настроек (по умолчанию 8 и 24 часа), смотря что раньше; следующий запрос получает `AUTH_REQUIRED` (DC-2).
- Задача отключённого или неизвестного владельца не начинает ни одного вызова модели или инструмента: перед вызовом её останавливают с причиной `owner_disabled` (DC-8).
- Открытые потоки SSE сеанса закрываются при выходе и при отключении сотрудника на любом экземпляре; каждый запрос с cookie сеанса, завершённого отключением, получает 401 `ACCOUNT_DISABLED`, пока сотрудник отключён и общий срок сеанса не истёк, а после включения — `AUTH_REQUIRED` (DC-9).
- Остановленный при отключении агент показывает в истории событие `stopped` с причиной `owner_disabled` (DC-10).

### FR-08: Право администратора

- From the PRD: AC-08.1, AC-08.2, AC-08.3, AC-08.4
- Операция администратора без права получает 403 `ADMIN_REQUIRED` (DC-11).
- Роль «Супер-администратор» нельзя удалить, переименовать и лишить права администратора: 409 `BUILTIN_ROLE` (DC-15).

### FR-32: Первый администратор через базу

- From the PRD: AC-32.1, AC-32.2, AC-32.3

### FR-33: Локальные учётные записи

- From the PRD: AC-33.1, AC-33.2, AC-33.3, AC-33.4
- Сброс пароля администратором завершает все сеансы сотрудника (DC-16).

### FR-11: Аудит входа и изменений администратора

- From the PRD: AC-11.1, AC-11.2, AC-11.3

## Design

### Architecture (C1–C4)

#### C1 · Context

Agent OS говорит с провайдерами двумя путями: браузер сотрудника ходит через провайдера при входе, а корпоративный IdP сам шлёт SCIM.

```mermaid
---
title: "C1 · Context — вход через провайдера"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  flowchart:
    curve: step
  themeCSS: |
    @keyframes lit_c1{0%,30%{stroke:#991b1b;stroke-width:6px}33.33%,100%{stroke:#f4a5a5;stroke-width:2px}}
---
flowchart LR
    entry(["▶ сотрудник открывает Agent OS"])
    aos["1 · Agent OS<br/>вход, сеанс, роли"]
    idp(["2 · провайдеры входа<br/>Google, GitHub, Okta"])
    oper(["оператор<br/>первый администратор"])
    admin(["администратор<br/>Agent OS"])
    entry --> aos
    aos e1@-->|"вход у провайдера"| idp
    idp e2@-->|"почта, имя, группы"| aos
    idp e3@-->|"SCIM"| aos
    admin -.->|"провайдеры, роли"| aos
    oper -.->|"команда в базу"| aos
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef w1 stroke:#f4a5a5,stroke-width:2px,animation:lit_c1 3.6s linear 0s infinite
    classDef w2 stroke:#f4a5a5,stroke-width:2px,animation:lit_c1 3.6s linear 1.2s infinite
    classDef w3 stroke:#f4a5a5,stroke-width:2px,animation:lit_c1 3.6s linear 2.4s infinite
    class entry entry
    class aos changed
    class idp,admin,oper new
    class e1 w1
    class e2 w2
    class e3 w3
```

#### C2 · Containers

```mermaid
---
title: "C2 · Containers — вход и запрос с сеансом"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  flowchart:
    curve: step
  themeCSS: |
    @keyframes lit_c2{0%,15%{stroke:#991b1b;stroke-width:6px}16.67%,100%{stroke:#f4a5a5;stroke-width:2px}}
    @keyframes litr_c2{0%,15%{stroke:#1d4ed8;stroke-width:6px}16.67%,100%{stroke:#9ec1f7;stroke-width:2px}}
---
flowchart LR
    entry(["▶ сотрудник нажимает кнопку провайдера"])
    subgraph aos["Agent OS"]
        web["1 · web<br/>страница входа, чат"]
        api["2 · api<br/>вход, сеанс, SCIM"]
        db[("Postgres<br/>сотрудники, сеансы")]
    end
    idp(["3 · провайдер входа"])
    entry --> web
    web e1@-->|"начать вход"| api
    api e2@-->|"перенаправление"| idp
    idp e3@-->|"ответ провайдера"| api
    api e4@-->|"сотрудник, сеанс"| db
    db e5@-->|"сеанс"| api
    api e6@-->|"cookie, чат"| web
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef w1 stroke:#f4a5a5,stroke-width:2px,animation:lit_c2 7.2s linear 0s infinite
    classDef w2 stroke:#f4a5a5,stroke-width:2px,animation:lit_c2 7.2s linear 1.2s infinite
    classDef w3 stroke:#f4a5a5,stroke-width:2px,animation:lit_c2 7.2s linear 2.4s infinite
    classDef w4 stroke:#f4a5a5,stroke-width:2px,animation:lit_c2 7.2s linear 3.6s infinite
    classDef r1 stroke:#9ec1f7,stroke-width:2px,animation:litr_c2 7.2s linear 4.8s infinite
    classDef r2 stroke:#9ec1f7,stroke-width:2px,animation:litr_c2 7.2s linear 6s infinite
    class entry entry
    class web,api,db changed
    class idp new
    class e1 w1
    class e2 w2
    class e3 w3
    class e4 w4
    class e5 r1
    class e6 r2
    style aos fill:none,stroke:#4b5563,stroke-dasharray:5 5
```

- `web` получает страницу `/login`, имя, почту и «Выйти» в меню, переход на вход по 401 и смену пароля на «Мой доступ»; cookie он уже шлёт с каждым запросом.
- `api` ведёт вход, сеансы, SCIM и операции администратора и проверяет сеанс каждого запроса.
- `Postgres` получает таблицы `identity_*` и `audit_events`, а `runtime_tasks` — причину остановки.

#### C3 · Components: api

**api — вход сотрудника.** Все способы входа сходятся в одной точке: `SignInService` получает почту, имя и, у корпоративного провайдера, группы и дальше не знает, откуда они.

```mermaid
---
title: "C3 · Components — api, вход сотрудника"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  flowchart:
    curve: step
  themeCSS: |
    @keyframes lit_c3a{0%,15%{stroke:#991b1b;stroke-width:6px}16.67%,100%{stroke:#f4a5a5;stroke-width:2px}}
    @keyframes litr_c3a{0%,15%{stroke:#1d4ed8;stroke-width:6px}16.67%,100%{stroke:#9ec1f7;stroke-width:2px}}
---
flowchart TB
    entry(["▶ браузер возвращается от провайдера"])
    subgraph api["api"]
        ctl["1 · AuthController<br/>маршруты входа"]
        proto["2 · OAuthSignIn / SamlSignIn<br/>проверка ответа"]
        sign["3 · SignInService<br/>сотрудник, группы, сеанс"]
        sess["4 · SessionStore<br/>сеансы"]
        pwd["PasswordSignIn<br/>логин и хеш"]
        audit["AuditLog"]
    end
    db[("Postgres")]
    idp(["провайдер входа"])
    entry --> ctl
    ctl e1@-->|"ответ и запрос входа"| proto
    proto e2@-->|"почта, имя, группы"| sign
    sign e3@-->|"открыть сеанс"| sess
    sess e4@-->|"строка сеанса"| db
    sess e5@-->|"токен"| ctl
    ctl e6@-->|"cookie, переход"| entry
    proto -.->|"токены, профиль"| idp
    pwd -.->|"проверенный сотрудник"| sign
    sign -.->|"вход в аудит"| audit
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef w1 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3a 7.2s linear 0s infinite
    classDef w2 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3a 7.2s linear 1.2s infinite
    classDef w3 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3a 7.2s linear 2.4s infinite
    classDef w4 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3a 7.2s linear 3.6s infinite
    classDef r1 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3a 7.2s linear 4.8s infinite
    classDef r2 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3a 7.2s linear 6s infinite
    class entry entry
    class ctl,proto,sign,sess,pwd,audit new
    class db unchanged
    class idp new
    class e1 w1
    class e2 w2
    class e3 w3
    class e4 w4
    class e5 r1
    class e6 r2
```

- `OAuthSignIn` гасит запрос входа, обменивает код на токены и по типу проверяет ID-токен или читает профиль (KD-1). Конфигурацию клиента он держит в памяти по номеру версии провайдера, поэтому правка провайдера действует со следующего входа (AC-03.3). Адреса `github` и `facebook` — параметр модуля, и тесты подменяют их адресами тестового провайдера.
- `SamlSignIn` проверяет подпись ответа ключом из сохранённых метаданных IdP, срок, получателя и `InResponseTo` по запросу входа.
- `PasswordSignIn` проверяет логин, хеш и счётчик неудач (KD-5) и отдаёт сотрудника тому же `SignInService`.
- `SignInService` в одной транзакции отказывает выключенному провайдеру, ответу без почты и отключённому сотруднику, находит сотрудника по почте без учёта регистра или создаёт его без ролей, у `oidc` и `saml` заменяет группы IdP, открывает сеанс и пишет аудит.

**api — запрос с сеансом и отключение.** Здесь сходятся две дороги: каждый запрос проходит проверку сеанса, а отключение — из SCIM или из панели — идёт одной операцией.

```mermaid
---
title: "C3 · Components — api, запрос и отключение"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  flowchart:
    curve: step
  themeCSS: |
    @keyframes lit_c3b{0%,18%{stroke:#991b1b;stroke-width:6px}20%,100%{stroke:#f4a5a5;stroke-width:2px}}
---
flowchart TB
    entry(["▶ IdP или администратор отключает сотрудника"])
    subgraph api["api"]
        scim["1 · ScimController / AdminUsersController<br/>отключить"]
        users["2 · UsersService<br/>статус, сеансы, аудит"]
        ctrl["3 · TaskControl<br/>stopOwner"]
        hub["4 · LiveHub<br/>закрыть потоки"]
        guard["SessionGuard<br/>каждый запрос"]
        gate["IdentityOwnerGate<br/>перед вызовом"]
    end
    db[("Postgres")]
    entry --> scim
    scim e1@-->|"disable"| users
    users e2@-->|"статус, сеансы"| db
    users e3@-->|"остановить работу"| ctrl
    ctrl e4@-->|"задачи stopped"| db
    users e5@-->|"NOTIFY через Postgres"| hub
    guard -.->|"сеанс и статус"| db
    gate -.->|"статус владельца"| db
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef w1 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3b 6s linear 0s infinite
    classDef w2 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3b 6s linear 1.2s infinite
    classDef w3 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3b 6s linear 2.4s infinite
    classDef w4 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3b 6s linear 3.6s infinite
    classDef w5 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3b 6s linear 4.8s infinite
    class entry entry
    class scim,users,gate new
    class ctrl,hub,guard changed
    class db unchanged
    class e1 w1
    class e2 w2
    class e3 w3
    class e4 w4
    class e5 w5
```

- `SessionGuard` ищет сеанс по хешу токена из cookie и читает сотрудника, его право администратора и сроки сеанса из `identity_settings` одним запросом. Время последнего запроса он обновляет не чаще раза в 5 минут.
- `TaskControl.stopOwner` останавливает каждую незавершённую задачу владельца по дереву за раз, сверху вниз, теми же правилами блокировок, что `stop`, и пишет у каждой причину. Шаг в полёте отсекается, как при обычной остановке: в своём процессе сразу, в других — по NOTIFY.
- `LiveHub` помнит у каждого потока его сеанс и закрывает потоки по NOTIFY `identity_sessions_closed` и в момент общего срока сеанса, рассчитанного при подключении потока; новое значение срока поток получит при следующем подключении. Открытый поток сеанс не продлевает.
- `IdentityOwnerGate` — реализация `OwnerGate` в `apps/api`: одно чтение статуса по первичному ключу перед каждым вызовом модели и инструмента (KD-4).

#### C3 · Components: web

**web — сеанс закончился.** Веб узнаёт о сеансе только по ответам API: своих cookie он не читает, а сервер Next к API не ходит.

```mermaid
---
title: "C3 · Components — web, ответ 401 и вход"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  flowchart:
    curve: step
  themeCSS: |
    @keyframes litr_c3w{0%,18%{stroke:#1d4ed8;stroke-width:6px}20%,100%{stroke:#9ec1f7;stroke-width:2px}}
---
flowchart TB
    entry(["▶ сотрудник работает в открытой вкладке"])
    subgraph web["web"]
        client["1 · клиенты API<br/>fetch и поток событий"]
        expired["2 · обработчик 401<br/>причина и next"]
        login["3 · страница /login<br/>форма и кнопки"]
        menu["UserMenu<br/>имя, «Выйти»"]
    end
    api["api"]
    entry --> client
    client e1@-->|"запрос"| api
    api e2@-->|"401 и код"| client
    client e3@-->|"401"| expired
    expired e4@-->|"переход"| login
    login e5@-->|"провайдеры"| api
    menu -.->|"кто вошёл, выход"| api
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef r1 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3w 6s linear 0s infinite
    classDef r2 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3w 6s linear 1.2s infinite
    classDef r3 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3w 6s linear 2.4s infinite
    classDef r4 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3w 6s linear 3.6s infinite
    classDef r5 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3w 6s linear 4.8s infinite
    class entry entry
    class client,menu changed
    class expired,login new
    class api unchanged
    class e1 r1
    class e2 r2
    class e3 r3
    class e4 r4
    class e5 r5
```

- Клиенты API веба отдают каждый ответ 401 одному обработчику. Поток событий кода ответа не видит, поэтому при обрыве без переподключения обработчик спрашивает `GET /api/auth/me`, и код его ответа даёт причину.
- Обработчик 401 переводит вкладку на `/login?reason=expired` или `reason=disabled` с `next` — адресом текущей страницы (DC-13).
- Страница `/login` — форма логина и пароля и кнопки из `GET /api/auth/providers` по `uxrd.md`; причина — из `error` или `reason` (`uxrd.md` MC-3). Форма зовёт `POST /api/auth/password`, кнопка ведёт на `GET /api/auth/sign-in/:providerId` с тем же `next`.
- `UserMenu` берёт имя и почту из `GET /api/auth/me` и ведёт пунктом «Мой доступ» на `/account`; «Выйти» зовёт `POST /api/auth/sign-out` и открывает `/login?reason=signed_out`. `DEV_USER` и строка «Режим разработки» удаляются.
- Страница «Мой доступ» (`/account`, экран в оболочке) появляется здесь с одной секцией «Пароль» (`uxrd.md` MA-03): она видна при `hasPassword` и зовёт `POST /api/auth/password/change`. `mcp-connect` и `access` добавляют на ту же страницу свои секции.

### Runtime Flows

#### Flow 1: Вход через провайдера

**Starts when:** сотрудник нажимает кнопку провайдера `oidc` на странице входа, for AC-02.1, AC-02.3, AC-02.5, AC-04.1, AC-04.2, AC-04.5, AC-06.1, AC-06.2, AC-08.4, AC-11.3, DC-4

```mermaid
---
title: "Flow 1 · Вход через провайдера OIDC"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  themeCSS: |
    @keyframes lit_f1{0%,11.25%{stroke:#991b1b;stroke-width:6px}12.5%,100%{stroke:#37474f;stroke-width:2px}}
    @keyframes litr_f1{0%,11.25%{stroke:#1d4ed8;stroke-width:6px}12.5%,100%{stroke:#37474f;stroke-width:2px}}
    .messageLine0[data-id='i0'],.messageLine1[data-id='i0']{animation:lit_f1 9.6s linear 0s infinite}
    .messageLine0[data-id='i2'],.messageLine1[data-id='i2']{animation:litr_f1 9.6s linear 1.2s infinite}
    .messageLine0[data-id='i3'],.messageLine1[data-id='i3']{animation:lit_f1 9.6s linear 2.4s infinite}
    .messageLine0[data-id='i4'],.messageLine1[data-id='i4']{animation:litr_f1 9.6s linear 3.6s infinite}
    .messageLine0[data-id='i5'],.messageLine1[data-id='i5']{animation:lit_f1 9.6s linear 4.8s infinite}
    .messageLine0[data-id='i6'],.messageLine1[data-id='i6']{animation:lit_f1 9.6s linear 6s infinite}
    .messageLine0[data-id='i7'],.messageLine1[data-id='i7']{animation:litr_f1 9.6s linear 7.2s infinite}
    .messageLine0[data-id='i9'],.messageLine1[data-id='i9']{animation:litr_f1 9.6s linear 8.4s infinite}
---
sequenceDiagram
    actor U as Сотрудник в браузере
    box Agent OS
    participant A as api
    participant DB@{ "type": "database" } as Postgres
    end
    participant I as Провайдер
    U->>A: начать вход через провайдера
    Note over A,DB: запрос входа: state, nonce, PKCE, хеш привязки, куда вернуть
    A-->>U: перенаправление к провайдеру, cookie привязки
    U->>I: вход у провайдера
    I-->>U: перенаправление с кодом и state
    U->>A: возврат с кодом и cookie привязки
    A->>I: обмен кода на токены
    I-->>A: ID-токен
    Note over A,DB: запрос входа погашен, сотрудник найден по почте или создан без ролей, группы заменены, сеанс открыт, вход в аудите
    A-->>U: cookie сеанса, переход в чат
```

**Outcome:** в браузере cookie `aos_session`, срок которой — верхняя граница общего срока (действует ли сеанс, решает сервер), в базе строка сеанса с хешем токена. У сотрудника записаны имя, почта, время входа и группы из ID-токена, в аудите `sign_in` со способом входа. У `google` групп нет; у `github` и `facebook` вместо ID-токена сервер читает профиль; у `saml` браузер приносит подписанный ответ формой `POST` на ACS без обмена токенами.

**Failure handling:**

- Сотрудник отменил вход или провайдер вернул ошибку → перенаправление на `/login?error=cancelled` или `error=failed`, сеанса нет, запись `sign_in_rejected` с причиной (AC-02.3, AC-11.3).
- Неверная подпись, истёкший ответ, чужой `InResponseTo`, неверный `nonce` или издатель → `error=failed`, запись `sign_in_rejected` с причиной проверки; текст ответа провайдера в лог и аудит не идёт (AC-02.2).
- Запрос входа не найден, уже погашен, старше 10 минут или привязка не совпала → `error=failed` (DC-4).
- Провайдер не вернул почту → `error=no_email`, запись `sign_in_rejected` с причиной `no_email` (AC-04.5).
- Провайдер выключен или его нет → `error=provider_unavailable` (AC-03.2).
- Сотрудник отключён → `error=account_disabled` (AC-07.3).
- Новые группы из IdP снимают последнего администратора → вход применяется, а в аудите и логе `last_admin_removed`, как у изменения по SCIM (KD-6, AC-08.4).
- Сбой базы на шаге фиксации → откат всей транзакции; сеанса и записей нет, браузер получает `error=failed`, лог пишет ошибку с идентификатором запроса входа.

#### Flow 2: Вход по логину и паролю

**Starts when:** сотрудник отправляет форму логина и пароля, for AC-01.2, AC-01.3, AC-07.3, AC-33.1, AC-33.2, DC-14

```mermaid
---
title: "Flow 2 · Вход по логину и паролю"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  themeCSS: |
    @keyframes lit_f2p{0%,22.5%{stroke:#991b1b;stroke-width:6px}25%,100%{stroke:#37474f;stroke-width:2px}}
    @keyframes litr_f2p{0%,22.5%{stroke:#1d4ed8;stroke-width:6px}25%,100%{stroke:#37474f;stroke-width:2px}}
    .messageLine0[data-id='i0'],.messageLine1[data-id='i0']{animation:lit_f2p 4.8s linear 0s infinite}
    .messageLine0[data-id='i3'],.messageLine1[data-id='i3']{animation:litr_f2p 4.8s linear 1.2s infinite}
    .messageLine0[data-id='i5'],.messageLine1[data-id='i5']{animation:litr_f2p 4.8s linear 2.4s infinite}
    .messageLine0[data-id='i7'],.messageLine1[data-id='i7']{animation:litr_f2p 4.8s linear 3.6s infinite}
---
sequenceDiagram
    actor U as Сотрудник в браузере
    box Agent OS
    participant A as api
    participant DB@{ "type": "database" } as Postgres
    end
    U->>A: логин и пароль
    Note over A,DB: сотрудник по логину, хеш argon2id, счётчик неудач, запись аудита
    alt логин закрыт пятью неудачами
        A-->>U: 429 TOO_MANY_ATTEMPTS
    else логин неизвестен или пароль неверен
        A-->>U: 401 INVALID_CREDENTIALS
    else пароль верен
        A-->>U: 204 и cookie сеанса, или 401 ACCOUNT_DISABLED
    end
```

**Outcome:** при успехе счётчик обнулён, сеанс открыт тем же `SignInService`, в аудите `sign_in` со способом `password`. При неудаче счётчик логина вырос (KD-5), в аудите `sign_in_rejected` с причиной `unknown_login`, `wrong_password` или `locked`; неизвестный логин и неверный пароль отвечают одинаково (AC-01.3).

**Failure handling:**

- Сбой базы → 500 с общим телом, сеанса нет, лог с логином, но без пароля.

#### Flow 3: Запрос с сеансом

**Starts when:** веб шлёт любой запрос к API, for AC-01.4, AC-01.6, AC-07.1, AC-07.5, AC-08.1, DC-1, DC-2, DC-3, DC-9, DC-11

```mermaid
---
title: "Flow 3 · Проверка сеанса"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  themeCSS: |
    @keyframes litr_f2{0%,22.5%{stroke:#1d4ed8;stroke-width:6px}25%,100%{stroke:#37474f;stroke-width:2px}}
    .messageLine0[data-id='i0'],.messageLine1[data-id='i0']{animation:litr_f2 4.8s linear 0s infinite}
    .messageLine0[data-id='i3'],.messageLine1[data-id='i3']{animation:litr_f2 4.8s linear 1.2s infinite}
    .messageLine0[data-id='i5'],.messageLine1[data-id='i5']{animation:litr_f2 4.8s linear 2.4s infinite}
    .messageLine0[data-id='i7'],.messageLine1[data-id='i7']{animation:litr_f2 4.8s linear 3.6s infinite}
---
sequenceDiagram
    actor U as Сотрудник в браузере
    box Agent OS
    participant A as api
    participant DB@{ "type": "database" } as Postgres
    end
    U->>A: запрос с cookie сеанса
    Note over A,DB: сеанс по хешу токена, сроки из identity_settings, статус сотрудника, право администратора
    alt нет сеанса, истёк или только заголовок x-user-id
        A-->>U: 401 AUTH_REQUIRED
    else сеанс завершён отключением
        A-->>U: 401 ACCOUNT_DISABLED
    else сеанс действует
        A-->>U: данные сотрудника, или 403 ADMIN_REQUIRED для операции администратора без права
    end
```

**Outcome:** `req.user` несёт `AuthUser`, и обработчик работает с `req.user.id`, как раньше. Отказ `ADMIN_REQUIRED` пишет в аудит запись `access_denied` с сотрудником и маршрутом (AC-08.1). Отказы `AUTH_REQUIRED` в аудит не идут: у них нет исполнителя.

**Failure handling:**

- Изменяющий запрос с cookie и чужим или пустым `Origin` → 403 `ORIGIN_REJECTED` до обработчика (DC-3).
- Сбой базы при поиске сеанса → 500 с общим телом, лог с идентификатором запроса; данные не отдаются.

#### Flow 4: Отключение сотрудника

**Starts when:** Okta шлёт по SCIM `active: false` или администратор блокирует сотрудника, for AC-05.3, AC-07.2, AC-07.4, AC-08.4, DC-8, DC-9, DC-10

```mermaid
---
title: "Flow 4 · Отключение по SCIM"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  themeCSS: |
    @keyframes lit_f3{0%,22.5%{stroke:#991b1b;stroke-width:6px}25%,100%{stroke:#37474f;stroke-width:2px}}
    @keyframes litr_f3{0%,22.5%{stroke:#1d4ed8;stroke-width:6px}25%,100%{stroke:#37474f;stroke-width:2px}}
    .messageLine0[data-id='i0'],.messageLine1[data-id='i0']{animation:lit_f3 4.8s linear 0s infinite}
    .messageLine0[data-id='i3'],.messageLine1[data-id='i3']{animation:litr_f3 4.8s linear 1.2s infinite}
    .messageLine0[data-id='i5'],.messageLine1[data-id='i5']{animation:lit_f3 4.8s linear 2.4s infinite}
    .messageLine0[data-id='i6'],.messageLine1[data-id='i6']{animation:litr_f3 4.8s linear 3.6s infinite}
---
sequenceDiagram
    participant I as IdP
    box Agent OS
    participant A as api
    participant DB@{ "type": "database" } as Postgres
    participant B as api, другой экземпляр
    end
    actor U as Сотрудник в браузере
    I->>A: SCIM PATCH Users, active false
    Note over A,DB: одна транзакция: статус disabled, сеансы завершены с причиной, NOTIFY identity_sessions_closed, запись scim в аудите
    Note over A,DB: stopOwner: задачи stopped с причиной owner_disabled, NOTIFY runtime
    A-->>I: 200, сотрудник с active false
    Note over DB,B: по NOTIFY потоки SSE сотрудника закрыты, шаги в полёте получили сигнал остановки
    U->>B: следующий запрос с тем же cookie
    B-->>U: 401 ACCOUNT_DISABLED
```

**Outcome:** сотрудник `disabled`, его сеансы завершены, все его задачи `stopped` с причиной `owner_disabled`, беседы и данные на месте. Блокировка из панели идёт тем же путём; её запись аудита — `admin_change` с администратором. Включение снова (`active: true` или «Разблокировать») возвращает статус `active` и ничего больше: старые сеансы и задачи не оживают, а сотрудник входит заново и видит прежние беседы (AC-07.4).

**Failure handling:**

- Запрос SCIM без токена или с отменённым → 401 по SCIM, ничего не меняется (AC-05.3).
- Задача, которую запрос сотрудника создал в миллисекунду до отключения, доходит до вызова модели или инструмента → `OwnerGate` вызывает `stopOwner` и не даёт вызову начаться (DC-8).
- `stopOwner` упал после фиксации отключения → лог с ошибкой и id сотрудника; задачи остановит `OwnerGate` перед их следующим вызовом, а сеансы уже закрыты.
- Отключение снимает последнего администратора → изменение от IdP применяется, в аудите и логе `last_admin_removed` (AC-08.4); блокировка из панели в этом случае отклоняется кодом `LAST_ADMIN`, и ничего не меняется (AC-08.3, KD-6).

### Contract Definitions

Все маршруты — под глобальным префиксом `/api`. Тело ошибки — `ApiErrorSchema` (`statusCode`, `message`, `error`, `errorCode` и необязательный `reason` — машинная причина отказа там, где операция её называет). Изменяющий запрос с cookie сеанса проверяется по `Origin` (DC-3).

#### Вход и сеанс — для веба

- **`GET /api/health`** (открыт) — 200 с пустым телом, когда процесс принимает запросы.
- **`GET /api/auth/providers`** (открыт) — включённые провайдеры в порядке создания: `id`, `name` (название кнопки), `type`. Форма логина и пароля есть всегда и в списке не значится.
- **`POST /api/auth/password`** (открыт) с `login` и `password` — вход по логину и паролю. Returns 204 и cookie `aos_session`. 401 `INVALID_CREDENTIALS` — неизвестный логин или неверный пароль, одним ответом. 429 `TOO_MANY_ATTEMPTS` — логин закрыт (DC-14). 401 `ACCOUNT_DISABLED` — пароль верен, сотрудник отключён.
- **`GET /api/auth/sign-in/:providerId?next=<путь>`** (открыт) — начинает вход у провайдера: 302 к провайдеру и cookie `aos_login`. `next` — путь веба, который начинается с одного `/`; иной заменяется на `/`. Выключенный или неизвестный провайдер — 302 на `{FRONTEND_ORIGIN}/login?error=provider_unavailable`.
- **`GET /api/auth/oauth/:providerId/callback`** (для `google`, `oidc`, `github`, `facebook`), **`POST /api/auth/saml/:providerId/acs`** (открыты) — возврат от провайдера. Успех — 302 на `{FRONTEND_ORIGIN}{next}` с cookie `aos_session`. Отказ — 302 на `{FRONTEND_ORIGIN}/login?error=<причина>&provider=<id>`, где причина — `cancelled`, `failed`, `no_email`, `account_disabled` или `provider_unavailable`. Тексты к причинам — `uxrd.md` MC-3.
- **`GET /api/auth/saml/:providerId`** (открыт) — метаданные SP в XML: Entity ID и ACS для настройки IdP.
- **`GET /api/auth/me`** — текущий сотрудник. Returns `CurrentUser`. Без сеанса — 401.
- **`POST /api/auth/password/change`** с `currentPassword` и `newPassword` — меняет свой пароль; другие сеансы сотрудника остаются. Returns 204. 400 `VALIDATION_FAILED` с `reason`: `wrong_current_password` (считается неудачей этого логина, DC-14), `weak_password` (короче 12 или длиннее 256 знаков) или `not_local_account`; 429 `TOO_MANY_ATTEMPTS`, пока логин закрыт.
- **`POST /api/auth/sign-out`** (открыт) — завершает сеанс этого cookie, закрывает его потоки, стирает cookie, пишет `sign_out`. Returns 204, в том числе без сеанса.
- **Поток `GET /api/events`** проверяется как любой маршрут при подключении: без сеанса — 401. Открытый поток сервер закрывает при выходе, отключении сотрудника и по общему сроку сеанса; после этого переподключение получает 401.

**CurrentUser**

- `id` (UUID), `email`, `name` (пустая строка, если имени нет — меню показывает почту до «@»).
- `isAdmin` — есть ли право администратора сейчас; `hasPassword` — локальная ли учётная запись, то есть можно ли сменить пароль.

**Error handling**

- `AUTH_REQUIRED` — 401: нет cookie, сеанс не найден или истёк, в том числе при одном заголовке `x-user-id`. Веб переводит на вход с `next` текущей страницы.
- `ACCOUNT_DISABLED` — 401: запрос с cookie сеанса, завершённого отключением, пока сотрудник отключён и общий срок сеанса не истёк (DC-9), и вход отключённого сотрудника по верному паролю.
- `TOO_MANY_ATTEMPTS` — 429: логин закрыт пятью неудачами (DC-14); веб показывает `uxrd.md` MC-3 «Слишком много попыток».
- `ADMIN_REQUIRED` — 403: операция администратора без права, запись `access_denied` в аудите.
- `ORIGIN_REJECTED` — 403: изменяющий запрос с cookie и чужим или пустым `Origin`.

#### Операции администратора — для `admin`

Все маршруты помечены `@AdminOnly()`; каждое изменение пишет `admin_change` с «было» и «стало» в той же транзакции.

- **`GET /api/admin/users?query=&cursor=`** — сотрудники по имени, 50 на страницу, поиск по имени, почте и логину без учёта регистра. Returns страницу `AdminUserSummary` и `nextCursor`.
- **`POST /api/admin/users`** с `login`, `name`, `email`, `password` — заводит локальную учётную запись без ролей (FR-33). Returns `AdminUserSummary`. 409 `LOGIN_TAKEN` или `EMAIL_TAKEN`; 400 `VALIDATION_FAILED` с `reason` `weak_password`. Аудит пишет `password_changed` вместо пароля.
- **`GET /api/admin/users/:id`** — `AdminUserSummary`, `adminRight` (`personal` и роли, которые дают право) и `groups` — группы IdP. 404 `USER_NOT_FOUND`.
- **`PUT /api/admin/users/:id/password`** с `password` — сбрасывает пароль локальной учётной записи, обнуляет счётчик неудач и завершает все сеансы сотрудника (DC-16). Returns 204. 409 `NOT_LOCAL_ACCOUNT`; 400 `VALIDATION_FAILED` с `reason` `weak_password`.
- **`POST /api/admin/users/:id/block`**, **`/unblock`** — блокирует (Flow 4) или включает сотрудника. Returns `AdminUserSummary`. 409 `LAST_ADMIN`, если блокировка оставит развёртывание без администратора.
- **`PUT /api/admin/users/:id/admin`** с `enabled` — даёт или снимает личное право администратора. 409 `LAST_ADMIN` при снятии последнего.
- **`PUT /api/admin/users/:id/roles/:roleId`**, **`DELETE` тот же путь** — назначает роль из панели или снимает только назначение из панели; членство из IdP не трогается. 404 `USER_NOT_FOUND` или `ROLE_NOT_FOUND`; 409 `LAST_ADMIN` при снятии.
- **`GET /api/admin/roles`**, **`GET /api/admin/roles/:id`** — роли по названию (группы IdP, число сотрудников, `isAdmin`, `builtin`) и одна роль с сотрудниками и источником членства: `idp` с группой или `panel`.
- **`POST /api/admin/roles`** с `name` (1–80 знаков после обрезки пробелов), **`PATCH /api/admin/roles/:id`** с `name` и/или `isAdmin`, **`DELETE /api/admin/roles/:id`** — создают, правят и удаляют роль; удаление уносит каскадом её сопоставления, назначения и строки других частей со ссылкой на роль. 409 `ROLE_NAME_TAKEN` (без учёта регистра), `LAST_ADMIN`, `BUILTIN_ROLE`.
- **`PUT /api/admin/roles/:id/groups/:group`**, **`DELETE` тот же путь** — сопоставляет имя группы IdP с ролью или снимает сопоставление. Имя — 1–256 знаков, как его пишет IdP, сравнение без учёта регистра. 409 `LAST_ADMIN` при снятии.
- **`GET /api/admin/providers`** — провайдеры в порядке создания: `id`, `type`, `name`, `enabled`.
- **`POST /api/admin/providers`** с `type`, `name` (1–60 знаков) и необязательными `options` — создаёт выключенного провайдера. Returns `ProviderView` с `providerData`, которые администратор переносит к провайдеру до того, как тот выдаст свои данные. Если публичный адрес ещё не сохранён, он становится адресом, по которому браузер обратился к API (AC-03.4). 400 `VALIDATION_FAILED` с `reason` `unknown_type` для типа не из списка (AC-03.5). 422 `PROVIDER_CHECK_FAILED`, если переданные настройки `oidc` или `saml` не прошли проверку (DC-6).
- **`GET /api/admin/providers/:id`** — `ProviderView`. 404 `PROVIDER_NOT_FOUND`.
- **`PATCH /api/admin/providers/:id`** — меняет `name`, `enabled` и `options`; `clientSecret` заменяется, только когда передан. Новые настройки `oidc` и `saml` проверяются (DC-6), смена типа запрещена. 409 `PROVIDER_INCOMPLETE` при включении провайдера без полных настроек его типа.
- **`POST /api/admin/providers/:id/scim-token`** — создаёт токен SCIM этого провайдера и отменяет его прежний. Returns `token` — единственный раз (AC-05.4); аудит пишет `scim_token_created` без значения. 409 `SCIM_NOT_SUPPORTED` у `google`, `github`, `facebook`.
- **`GET /api/admin/settings/sign-in`** — настройки входа (FR-26). Returns `SignInSettings`.
- **`PUT /api/admin/settings/sign-in`** с `publicUrl`, `idleMinutes`, `absoluteMinutes` — меняет их; новые сроки действуют для существующих сеансов с их следующего запроса (FR-07, AC-07.5), новый адрес — для следующего входа через провайдера. Returns `SignInSettings`. 400 `VALIDATION_FAILED`, если значение вне границ или срок без запросов больше общего; ничего не меняется. Запись `admin_change` с объектом `sign_in_settings`.

`PROVIDER_CHECK_FAILED` несёт в `reason` одно из трёх значений: `insecure_url` — адрес издателя или метаданных не `https` и не `http://localhost`; `unreachable` — адрес не ответил или ответил не успехом; `invalid_document` — ответ не документ discovery OIDC этого издателя или не метаданные IdP SAML с адресом входа и ключом подписи.

**AdminUserSummary**

- `id`, `email`, `name`; `login` — логин локальной учётной записи или `null`; `status` — `active` или `disabled`; `lastSignInAt` — время или `null`.
- `roles` — список: `id`, `name` и `sources`, где источник — `panel` или `idp` с именем группы. Роль с двумя источниками — одна строка с обоими.

**ProviderView**

- `id`, `type` (`google`, `facebook`, `github`, `oidc`, `saml`), `name`, `enabled`, `complete` — заданы ли все настройки типа.
- `options` — настройки типа по KD-1 без секрета: `clientId`, `issuer`, `metadataUrl`, где они есть у типа (`null`, пока не заданы), и `clientSecretSet` — задан ли секрет; значения секрета нет ни в одном ответе.
- `providerData` — значения для настройки приложения у провайдера. У OAuth-типов: `redirectUri` (`{publicUrl}/api/auth/oauth/<id>/callback`); у `oidc` ещё `scopes` (`openid email profile groups`) и `groupsClaim` (`groups`). У `saml`: `acsUrl` (`{publicUrl}/api/auth/saml/<id>/acs`), `entityId` (`{publicUrl}/api/auth/saml/<id>`) и `attributes` (`email`, `name`, `groups`).
- `scim` — у `oidc` и `saml`: `url` (`{publicUrl}/api/scim/v2`) и `tokenCreatedAt` (или `null`); у остальных типов поля нет.

**SignInSettings**

- `publicUrl` — публичный адрес без `/api`: `https://…` или `http://localhost…`, без пути; `null`, пока не сохранён.
- `idleMinutes` — срок без запросов, целое от 15 до 1440; по умолчанию 480.
- `absoluteMinutes` — общий срок с момента входа, целое от 60 до 43200 (30 суток); по умолчанию 1440; не меньше `idleMinutes`.
- `updatedAt` — время последнего изменения или `null`, пока стоят значения по умолчанию.

#### SCIM 2.0 — для IdP

- **База** — `{publicUrl}/api/scim/v2`, заголовок `Authorization: Bearer <токен провайдера>`, тела `application/scim+json` или `application/json`. Неверный или отменённый токен — 401 по SCIM, ничего не меняется (AC-05.3).
- **`Users`** — `GET` списка с фильтром `userName eq`, `GET /:id`, `POST`, `PUT /:id`, `PATCH /:id` (`active`, имя, почта), `DELETE /:id`. `id` ресурса — UUID сотрудника. Почта — основная из `emails` или `userName`. `active: false` и `DELETE` отключают сотрудника (Flow 4), строка остаётся. `POST` с почтой, которая уже есть, — 409 `uniqueness`.
- **`Groups`** — `GET` с фильтром `displayName eq`, `GET /:id`, `POST`, `PUT /:id`, `PATCH /:id` (`members` add, remove, replace; `displayName`), `DELETE /:id`. Изменение членов меняет группы IdP сотрудников (KD-6). Переименование группы меняет имя и у сотрудников, но не у ролей: роль сопоставлена с прежним именем, пока администратор его не поправит.
- Каждая операция SCIM — запись `scim` в аудите с провайдером, объектом и «было/стало».

#### Для `mcp-connect`, `access` и всех частей

- **Секреты других систем** хранятся как есть (KD-7). Часть, которая хранит секрет, не возвращает его ни в одном ответе (только «задан»), не пишет в лог и кладёт в аудит под именем поля из списка секретных имён логгера, чтобы `AuditLog` его скрыл.
- **`IdentitySettings.publicUrl(request)`** — публичный адрес для адресов возврата: сохранённое значение, а если его нет — адрес, по которому браузер обратился к API, который при этом сохраняется (правило AC-03.4). `mcp-connect` строит по нему адрес возврата OAuth своих серверов.
- **`AuditLog.record(tx | null, entry)`** — пишет запись: `kind`, `actor` (id сотрудника, `scim` или `system`), `objectType`, `objectId`, `before`, `after`, `outcome`, `reason`. С `tx` пишет в транзакции вызывающего, без него — в своей. Поля с именами секретов и паролей в `before` и `after` становятся `secret_changed` и `password_changed`. Виды этой части: `sign_in`, `sign_in_rejected`, `sign_out`, `password_changed`, `password_reset`, `scim`, `scim_token_created`, `admin_change`, `access_denied`, `last_admin_removed`; части добавляют свои.
- **`@Public()`, `@AdminOnly()` и `req.user`** — маршрут любой части закрыт сеансом по умолчанию; `req.user.id` — UUID сотрудника, им же заполняются столбцы владельца. Если части нужен маршрут без сеанса, она помечает его `@Public()` и защищает сама, как SCIM — своим токеном.
- **Сотрудник для `access`** — `IdentityDirectory.rolesOf(userId)`: id ролей сотрудника из обоих источников на момент вызова; `IdentityDirectory.isActive(userId)`. Таблицы прав `access` ссылаются на `identity_roles` и `identity_users` внешним ключом с каскадом.
- **`OwnerGate`** (порт `createAgents`) — `check(ownerId)` завершается, когда владелец может работать. Для отключённого или неизвестного владельца реализация вызывает `TaskControl.stopOwner(ownerId, 'owner_disabled')` и отклоняет вызов с `OWNER_DISABLED`. Часть `access` вправе заменить порт своей проверкой, если та делает то же для отключённого владельца.
- **`TaskControl.stopOwner(ownerId, reason)`** — останавливает все незавершённые задачи владельца; возвращает id остановленных. `reason` — значение `StopReasonSchema`: здесь `owner_disabled`. У задачи появляется `stopReason`, а событие истории `stopped` несёт его в `reason`; ручная остановка оставляет `null`.
- **Вход в тестах** — любая часть входит в тестах через `POST /api/auth/password` локальной учётной записи, а её `id` читает из `GET /api/auth/me`.

**Runtime settings**

- Новых переменных окружения нет; существующий `FRONTEND_ORIGIN` — адрес возврата после входа и единственный разрешённый `Origin`. Настройки администратора — `SignInSettings`.
- Постоянные кода: запрос входа — 10 минут; страница сотрудников — 50; пароль и предел попыток — KD-5.

### Data Model

Все новые таблицы лежат в схеме `app`, объявлены в `packages/db/src/schema.ts` и приходят одной сгенерированной миграцией. Префикс `identity_` принадлежит этой части, `audit_` — модулю аудита `apps/api`.

- **`identity_users`** — сотрудник: UUID, почта (уникальна без учёта регистра), имя, статус, личное право администратора, время последнего входа; у локальной учётной записи ещё логин (уникален без учёта регистра) и хеш пароля.
- **`identity_login_attempts`** — по введённому логину (нормализованному, существующему или нет): число неудач подряд и время, до которого логин закрыт. Строка удаляется при успешном входе, сбросе пароля и команде оператора.
- **`identity_user_groups`** — имена групп IdP сотрудника; одна строка на пару «сотрудник — группа».
- **`identity_scim_groups`** — группы, которые IdP завёл по SCIM: SCIM-id и имя. Нужны, чтобы `PATCH /Groups/:id` знал имя группы.
- **`identity_roles`**, **`identity_role_groups`**, **`identity_role_members`** — роль (уникальное без учёта регистра название, право администратора, пометка встроенной), её сопоставленные имена групп и назначения из панели. Удаление роли уносит обе дочерние таблицы каскадом. Миграция создаёт роль «Супер-администратор» с пометкой встроенной и правом администратора.
- **`identity_providers`** — провайдер: тип, название, включён ли, номер версии, настройки типа вместе с секретом клиента как есть, у `saml` — сохранённые метаданные IdP, у `oidc` и `saml` — SHA-256 токена SCIM и время его создания. Тип после создания не меняется, а включён может быть только провайдер с полными настройками типа.
- **`identity_login_requests`** — запрос входа: провайдер, хеш привязки к браузеру, `nonce`, PKCE-верификатор или id запроса SAML, путь возврата, срок. Строка удаляется при первом возврате от провайдера.
- **`identity_sessions`** — сеанс: SHA-256 токена (уникален), сотрудник, время создания и последнего запроса, причина завершения или пусто; сроков строка не хранит (KD-2). Выход и сброс пароля администратором удаляют строки, отключение ставит причину (DC-9), а строки после общего срока удаляются при каждом успешном входе.
- **`identity_settings`** — одна строка настроек части (`SignInSettings`, границы проверяет база), время и автор их последнего изменения. Строку создаёт миграция; это образец для `access_settings` части `access`.
- **`audit_events`** — записи аудита (KD-7). Прежняя таблица `public.audit_events` больше не пишется; её строки не переносятся.
- **`runtime_tasks`** получает необязательную причину остановки с CHECK по `StopReasonSchema`.

### State Transitions and Invariants

```mermaid
---
title: "Сотрудник и его сеанс"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
---
stateDiagram-v2
    direction LR
    state "включён" as active
    state "отключён" as disabled
    [*] --> active: локальная запись, JIT, SCIM POST, команда оператора
    active --> disabled: SCIM active false или DELETE, блокировка
    disabled --> active: SCIM active true, разблокировка, команда оператора
```

**Invariants**

1. У включённого сотрудника нет действующего сеанса, открытого до его последнего отключения или последнего сброса пароля администратором.
2. Отключённый сотрудник не открывает сеанс ни одним способом входа.
3. После изменения из панели в развёртывании есть хотя бы один включённый сотрудник с правом администратора.
4. Идентификатор сотрудника выдаёт сервер, и он не берётся из данных провайдера.
5. Пароль, токен сеанса и токен SCIM хранятся только хешем; ни один ответ сервера не содержит пароля и секрета провайдера.
6. Запрос входа принимается не больше одного раза.
7. Задача отключённого владельца не начинает вызова модели или инструмента.
8. Роль «Супер-администратор» существует всегда и всегда даёт право администратора.

## Test Strategy

Тесты входа идут без интернета: тестовый провайдер OAuth и OIDC в процессе теста (на его адреса подменены и `github`, `facebook`) и `samlify` в роли IdP SAML; тест сам играет браузер. E2E-тесты, которые ставили `x-user-id`, входят по логину и паролю (Contract Definitions, «Вход в тестах»).

### Main Use Cases

- **UC-1: Первый вход через OIDC с группами** — covers AC-01.5, AC-02.1, AC-04.1, AC-04.4, AC-06.1, AC-08.2, AC-11.3
  - Given: включены `google` «Google» и `oidc` «Okta»; группа `sre` сопоставлена с ролью «SRE» с правом администратора; Ани в базе нет
  - When: список провайдеров читают без сеанса; Аня входит через «Okta» с группами `sre` и `all`
  - Then: в списке две кнопки с этими названиями; браузер приходит в `next` с cookie; `GET /api/auth/me` — её имя, почта, `isAdmin: true`, `id` — UUID; у неё роль «SRE» с источником `idp` и группой `sre`; в аудите `sign_in`
- **UC-2: Одна почта — одна учётная запись** — covers AC-02.5, AC-04.2, AC-06.5
  - Given: у Ани локальная учётная запись с почтой `anna@company.ru` и роль «SRE» из группы Okta; включены `github`, `facebook`, `saml`
  - When: она входит через каждый из них с той же почтой в другом регистре
  - Then: каждый раз тот же `id` и прежние беседы; после `github` и `facebook` роль «SRE» на месте
- **UC-3: SCIM заводит, меняет и отключает сотрудника с работающим агентом** — covers AC-05.1, AC-05.2, AC-06.2, AC-07.2, AC-07.4, DC-8, DC-9, DC-10
  - Given: у провайдера `oidc` создан токен SCIM; Борис заведён по SCIM и входит; у него работает агент, который вызывает модель, и открыт поток событий
  - When: SCIM меняет его почту, убирает его из группы `sre`, затем шлёт `active: false`; позже — `active: true`, и Борис входит снова
  - Then: почта обновлена в той же строке; роли «SRE» нет; после отключения поток закрыт, запросы с его cookie — 401 `ACCOUNT_DISABLED`, агент `stopped` с причиной `owner_disabled` в истории, а тестовая модель не получила ни одного вызова; после включения и входа видны прежние беседы
- **UC-4: Провайдер с секретом** — covers AC-03.1, AC-03.3, AC-03.4, AC-03.5, AC-11.2, DC-6, NFR-02
  - Given: администратор вошёл, публичный адрес не сохранён
  - When: он создаёт провайдера неизвестного типа; создаёт `oidc` и включает его без настроек; сохраняет издателя без discovery; сохраняет верные настройки с известным секретом; заменяет секрет и `clientId`; сотрудник входит
  - Then: по порядку — 400 с `reason` `unknown_type`; публичный адрес стал адресом запроса, `redirectUri` построен от него; 409 `PROVIDER_INCOMPLETE`; 422 `PROVIDER_CHECK_FAILED` с `reason` `unreachable`; ответы показывают только `clientSecretSet: true`; лог и аудит не содержат ни одного значения секрета, запись о замене несёт `secret_changed`; вход идёт с новым `clientId` без рестарта
- **UC-5: Роли из двух источников** — covers AC-06.3, AC-06.4, AC-11.1
  - Given: у Ани роль «Дежурный» из панели и роль «SRE» из IdP и из панели
  - When: администратор меняет сопоставление групп роли «SRE», затем Аня входит через `oidc` без групп `sre` и `oncall`
  - Then: у Ани остаются «Дежурный» и «SRE» с источником `panel`; аудит содержит запись с администратором, ролью, прежним и новым набором групп
- **UC-6: Первый администратор командой оператора** — covers AC-32.1, AC-32.2, AC-32.3, DC-15
  - Given: пустая база после миграций
  - When: открывают страницу входа; оператор запускает `identity:super-admin` для логина `igor`; Игорь входит; затем администратор пробует удалить и переименовать «Супер-администратор»; позже Игорь забыл пароль, и оператор запускает команду снова с новым паролем
  - Then: на странице входа только форма логина и пароля и нет способа создать учётную запись; после входа `isAdmin: true`; удаление и переименование — 409 `BUILTIN_ROLE`; после повторной команды Игорь входит с новым паролем и снова администратор
- **UC-7: Локальные учётные записи и пароль** — covers AC-01.1, AC-01.2, AC-01.3, AC-01.6, AC-33.1, AC-33.2, AC-33.3, AC-33.4, AC-11.3, DC-14, DC-16, NFR-01
  - Given: ни одного провайдера; администратор завёл Бориса с начальным паролем
  - When: Борис входит; меняет пароль с неверным, затем с верным текущим; администратор сбрасывает пароль; Борис пробует старый пароль пять раз, затем новый; запрос несёт только `x-user-id`
  - Then: вход открывает чат; первая смена — 400 с `reason` `wrong_current_password`, вторая проходит; после сброса прежний сеанс получает `AUTH_REQUIRED`; неверный и неизвестный логин отвечают одинаково `INVALID_CREDENTIALS`; после пятой неудачи и новый пароль получает 429 `TOO_MANY_ATTEMPTS`, а аудит — причину `locked`; пять неудач с несуществующим логином дают тот же 429; в строках базы нет паролей в открытом виде; одиночный `x-user-id` — 401 `AUTH_REQUIRED`
- **UC-8: Два сотрудника не видят данных друг друга** — covers AC-04.3
  - Given: Аня и Борис вошли, у каждого своя беседа с агентом и расход
  - When: каждый читает список бесед, агентов и расход, а Аня запрашивает беседу Бориса по её адресу
  - Then: каждый видит только своё; ответ на чужую беседу — 404 `THREAD_NOT_FOUND` с тем же телом, что у несуществующей
- **UC-9: Веб: вход, выход и конец сеанса** — covers AC-01.1, AC-07.1, DC-13
  - Given: вкладка веба без сеанса на адресе беседы; API отвечает одним включённым провайдером
  - When: вкладка открывается; сотрудник входит по логину и паролю; затем выбирает «Выйти»; затем, после нового входа, API отвечает на запрос 401 `ACCOUNT_DISABLED`
  - Then: сначала видна страница входа с формой и одной кнопкой и без чата; после входа открыта та же беседа, в меню имя и почта, а на «Мой доступ» — секция «Пароль»; после выхода — страница входа с текстом «Вы вышли»; после 401 — страница входа с причиной «учётная запись отключена»

### Error and Edge Use Cases

- **UC-E1: Подделанный или просроченный ответ SAML** — covers AC-02.2, AC-11.3
  - Given: провайдер `saml` и запрос входа
  - When: на ACS приходит ответ с подписью чужого ключа; затем ответ с истёкшим сроком
  - Then: оба раза переход на `/login?error=failed`, сеанса нет, в аудите две записи `sign_in_rejected` с провайдером, временем и причиной
- **UC-E2: Повтор, чужой браузер, отмена, нет почты** — covers AC-02.3, AC-04.5, DC-4
  - Given: начатый вход через `oidc`; отдельно — вход через `facebook`
  - When: возврат приходит с ошибкой `access_denied`; затем верный возврат повторяют второй раз; затем возврат без cookie привязки; профиль `facebook` приходит без почты
  - Then: первый — `error=cancelled`, следующие два — `error=failed`, последний — `error=no_email` с записью `sign_in_rejected`; сеанс ни разу не открыт
- **UC-E3: Выключенный провайдер и отключённый сотрудник** — covers AC-03.2, AC-07.3
  - Given: провайдер выключен; отдельно — Борис с локальной учётной записью отключён
  - When: список провайдеров читают, а вход через выключенного начинают по старой ссылке; Борис входит по верному паролю
  - Then: выключенного нет в списке, переход — `error=provider_unavailable`; Борис получает 401 `ACCOUNT_DISABLED`
- **UC-E4: Токен SCIM** — covers AC-05.3, AC-05.4
  - Given: администратор создал токен провайдера `saml`, затем второй
  - When: SCIM зовут без токена, с первым и со вторым; токен просят у провайдера `github`; читают провайдера и аудит
  - Then: без токена и с первым — 401 и ничего не изменено; со вторым — работает; у `github` — 409 `SCIM_NOT_SUPPORTED`; значение токена есть только в ответе на его создание
- **UC-E5: Последний администратор** — covers AC-08.3, AC-08.4
  - Given: право администратора есть только у Игоря через роль из группы IdP
  - When: администратор пробует в панели снять право с роли, затем заблокировать Игоря; затем IdP убирает Игоря из группы по SCIM
  - Then: оба изменения в панели — 409 `LAST_ADMIN`, ничего не изменено; изменение от IdP применено, в аудите и логе `last_admin_removed`
- **UC-E6: Без права и без сеанса** — covers AC-01.4, AC-08.1, AC-07.1, DC-1, DC-2, DC-3, DC-11, NFR-03
  - Given: приложение с маршрутами всех модулей; сотрудник без права администратора
  - When: тест обходит все зарегистрированные маршруты без cookie; сотрудник зовёт операцию администратора; изменяющий запрос идёт с чужим `Origin`; сотрудник выходит и повторяет запрос; сеанс старше 24 часов (часы теста)
  - Then: каждый маршрут, кроме входа, SCIM (свой отказ 401) и `GET /api/health`, — 401 `AUTH_REQUIRED`; операция администратора — 403 `ADMIN_REQUIRED` и запись `access_denied`; чужой `Origin` — 403 `ORIGIN_REJECTED`; после выхода и для старого сеанса — 401 `AUTH_REQUIRED`
- **UC-E7: Администратор сокращает сроки сеанса** — covers AC-07.5, DC-2
  - Given: сроки по умолчанию; Аня вошла 2 часа назад и последний запрос сделала час назад
  - When: администратор ставит срок без запросов 30 минут и общий срок 61 минуту, затем пробует срок без запросов 2000 минут; Аня делает запрос
  - Then: первое изменение сохранено, в аудите `admin_change` с прежними и новыми сроками; второе — 400 `VALIDATION_FAILED`, сроки не изменились; запрос Ани — 401 `AUTH_REQUIRED`

## Security Considerations

- **Authentication & Authorization**: закрытый по умолчанию API и `@AdminOnly()` (KD-3), сеанс и проверка `Origin` (KD-2), пароль (KD-5). Запрос входа одноразовый, живёт 10 минут и привязан к браузеру cookie `aos_login` с `SameSite=None; Secure`: ответ SAML приходит межсайтовым `POST`, и только такая cookie до него доходит. `google` и `oidc` используют PKCE, `state` и `nonce`, `github` и `facebook` — `state` и секрет клиента. Путь возврата — только путь веба, поэтому подменить адрес возврата нельзя. Экрана первого запуска нет (AC-32.3): встроенную роль первому администратору даёт команда оператора с доступом к базе.
- **Input Validation**: тела запросов проверяет zod на границе контроллера, настройки провайдера — схема его типа (KD-1), ответы провайдеров — `openid-client` и `samlify` со схемой XML. Почта и логин нормализуются (обрезка, нижний регистр) до поиска. Адрес издателя и метаданных — `https` или `http://localhost` для тестового провайдера.
- **Sensitive Data Handling**: секреты провайдеров хранятся как есть (KD-7). Логгер получает новые имена секретных полей: `clientSecret`, `idToken`, `accessToken` (уже есть), `samlResponse`, `assertion`, `codeVerifier`, `scimToken`, `sessionToken`, `currentPassword`, `newPassword` (`password` уже есть). Код входа не пишет в лог сырой запрос возврата, токены и XML ответа провайдера: лог несёт id провайдера, id запроса входа, id сотрудника, исход и длительность. `AuditLog` заменяет секретные поля на `secret_changed`, а пароли — на `password_changed`. Тест NFR-02 ищет известные значения в логе, аудите и ответах (UC-4), тест NFR-01 — пароли и токены SCIM в строках базы (UC-7, UC-E4).

## Risks and Mitigation

- **Провайдер, где человек может назвать любую почту, пускает его под чужой учётной записью** — принято в PRD (Risks); провайдеров подключает только администратор, каждый вход — в аудите со способом входа.
- **Уязвимость проверки подписи SAML в библиотеке** — высокое влияние, низкая вероятность при текущей версии. `samlify` не ниже 2.13.0, схема XML включена, `wantAssertionsSigned` обязателен, e2e на чужую подпись (UC-E1); ревью безопасности дизайна и кода входа до выпуска.
- **Валидатор схемы XML для `samlify`** — `samlify` без валидатора не проверяет ответы. Берётся валидатор на `xmllint` в WebAssembly без Java; точный пакет выбирается при реализации, а UC-E1 подтверждает, что проверка включена.
- **Профиль Facebook не сверен со справочником Graph API** — что `/me` отдаёт `email` при разрешении `email`, взято из руководства по веб-входу; ручная приёмка на тестовом приложении (PRD, Assumptions) подтверждает это до выпуска.
- **Закрытие чужого логина подбором** — пять неверных паролей закрывают логин на 15 минут. Принято: закрытие временное, а сброс пароля администратором и команда оператора его снимают.
- **Сотрудника убрали в IdP, а SCIM не настроен** — он работает до конца сеанса, не дольше общего срока из настроек (по умолчанию 24 часа, KD-2).
## Appendix: Fact Disposition

| Fact | Disposition | Handled in |
|------|-------------|------------|
| Заглушка `SessionGuard` с `x-user-id` и `dev-user`, по контроллеру (`apps/api/src/auth/session.guard.ts:SessionGuard`) | transform | KD-3: глобальная асинхронная проверка, `AuthUser` с `isAdmin`; заглушка и её тест удалены |
| Префикс `system:` держит только заголовок (`apps/api/src/auth/system-owners.ts:RESERVED_USER_PREFIX`) | remove | KD-3: id — UUID от сервера; `system-owners.ts` удалён, Invariant 4 |
| Шесть текстовых `owner_id` без FK (`packages/db/src/schema.ts:owner_id`) | out-of-scope | KD-3: столбцы не меняются, хранят UUID сотрудника; Data Model |
| Обработчики берут `req.user.id` (`apps/api/src/chat/threads.controller.ts:ownerId`) | out-of-scope | KD-3: смысл `req.user.id` сохранён; новые коды 401 и 403 — Contract Definitions |
| SSE привязан к владельцу только при подключении (`apps/api/src/chat/live-hub.ts:LiveHub.register`) | transform | KD-4: поток закрывается по NOTIFY и сроку (DC-9), веб уходит на вход (DC-13); nginx — Out of scope |
| Остановка без причины и без «всего владельца» (`packages/runtime/src/task-control.ts:TaskControl.stop`) | transform | KD-4: `stopOwner` с причиной, `stopReason` у задачи, `OwnerGate` перед вызовами (DC-8, DC-10) |
| Таблица доступа по строке владельца (`packages/agents/src/config.ts:MCP_ACCESS_TABLE`) | transform | Constraints: ключ — UUID сотрудника и `*` до части `access` |
| Аудит перехватчиком, сырой DDL, буфер (`apps/api/src/audit/audit.service.ts:AuditService`) | remove | KD-7: `AuditLog` над `audit_events` в схеме `app` |
| Маскировка по точному имени и списку значений при старте (`packages/common/src/logger.ts:createLogger`) | transform | Security Considerations: новые имена полей |
| Имя в меню из `DEV_USER`, нет входа и ветки 401 (`apps/web/src/lib/dev-user.ts:DEV_USER`) | remove | KD-3, C3 · web: имя из `GET /api/auth/me`, страница `/login`, обработчик 401 |
| CORS без cookie, CSRF, типов SCIM (`apps/api/src/app.setup.ts:configureApp`) | transform | KD-2: разбор cookie, проверка `Origin`, тело `application/scim+json`; публичный адрес — настройка в базе |
| E2E-помощники ставят `x-user-id` (`apps/api/test/support/api.ts:chatApi`) | transform | Contract Definitions, «Вход в тестах»: `POST /api/auth/password` |
| Миграции отдельной командой (`packages/db/src/migrate.ts:applyMigrations`) | out-of-scope | KD-6: команда оператора — отдельный вход, как миграции |
| Ничего не хранит секрет в базе, настройки через `readXSettings` (`apps/api/src/app.module.ts:AppModule`) | transform | KD-7: секреты провайдеров как есть; новых переменных окружения нет |
| Новые контроллеры открыты, `health` нет; образ с `NODE_ENV=development` (constraints) | transform | KD-3: глобальная проверка, `GET /api/health`. Образ не меняется: вход больше не зависит от `NODE_ENV` |
| Отклонения от code-system: DDL и Nest `Logger` в аудите (conformance) | remove | KD-7 |
| Каталогом не описаны проверка на контроллере и поиск «чужое = нет» (conformance) | transform | Новый паттерн [auth-boundary.md](../../code-system/patterns/auth-boundary.md) |

Дизайн сохраняет паттерны функции сборки, логирования и репозитория над транзакцией (conformance); задачи `packages/workflows` принадлежат тому же владельцу и останавливаются `stopOwner`.

## Update History

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-11-15 | Первая версия |
| 1.1 | 2026-11-15 | Сроки сеанса — настройка администратора; ссылки на ADR-0012 и ADR-0013 |
| 1.2 | 2026-11-15 | Необязательное поле `reason` в `ApiErrorSchema` |
| 2.0 | 2026-11-15 | По PRD 2.0: вход по логину и паролю, провайдеры пяти типов, первый администратор командой оператора, публичный адрес в базе; убраны bootstrap, вход для разработки, переменные окружения и шифрование секретов |
