# Настройка до первой отрисовки

## Problem

Настройка сотрудника или устройства должна действовать с первого кадра страницы: тема, язык, открытый сайдбар. Признак: если значение приходит позже первого кадра, сотрудник видит вспышку цвета, прыжок раскладки или текст не на своём языке.

## Shape

- **Хранение** — cookie с закрытым набором значений. Имя cookie и набор лежат в `@agent-os/contracts`, когда cookie пишет API; настройку одного устройства пишет сам веб через `document.cookie`.
- **Цвет или вид всей страницы** — статичный скрипт в `<head>` корневого layout читает cookie и без сверки с набором ставит её значение атрибутом на `<html>`; CSS выбирает значения по атрибуту. Текст скрипта собран из констант при сборке, данных запроса в нём нет, поэтому layout остаётся статичным, а скрипт выполняется до разбора `<body>`. Cookie для него — без `HttpOnly`.
- **Разметка, которую рисует сервер** — серверный компонент внутри `<Suspense>` читает `cookies()` и выбирает значение чистой функцией; если нужен атрибут `<html>`, его ставит встроенный скрипт рядом. Этот скрипт приходит с потоковым содержимым, поэтому так передают только то, что не видно на пустой странице: язык, состояние сайдбара.
- **Значение после входа на новом устройстве** приходит с сервера: API ставит cookie ответом при входе, и следующая загрузка страницы уже с ним. Cookie без `HttpOnly` при сохранении пишет сам веб; cookie с `HttpOnly` веб записать не может, и её ставит ответ на сохранение.
- **Режим** светлый или тёмный хранит next-themes в своём ключе `localStorage` со своим скриптом до отрисовки; второй механизм для него не нужен.

## Reference

- `apps/web/src/app/layout.tsx` — скрипт в `<head>`: тема по cookie `aos_theme` и `<meta name="theme-color">`
- `apps/web/src/i18n/locale-root.tsx` — сервер внутри `<Suspense>`: язык по cookie `aos_locale`
- `apps/web/src/app/(chat)/layout.tsx` — сервер внутри `<Suspense>`: сайдбар по cookie `sidebar_state`

## Not For

| Looks like | Use instead |
|---|---|
| значение, которое один экран передаёт другому без перезагрузки | [shell-store.md](./shell-store.md) |
| данные сотрудника из API, нужные одному экрану | [read-on-open.md](./read-on-open.md) |
| значение, которое должно открываться ссылкой | адрес ([shell-route.md](./shell-route.md)) |

## Used In

- [design-engine.md](../../features/theming/design-engine.md) — cookie `aos_theme` и скрипт в `<head>` (KD-3)
- [design-preference.md](../../features/theming/design-preference.md) — cookie `aos_theme` ответом на вход (KD-3)
- [design-web.md](../../features/i18n/design-web.md) — cookie `aos_locale` и языковой корень (KD-2)
- [design-web-shell.md](../../features/chat-shell/design-web-shell.md) — cookie `sidebar_state`
