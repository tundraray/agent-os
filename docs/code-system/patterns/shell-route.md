# Экран в оболочке по адресу

## Problem

Веб получает новый экран, который живёт внутри оболочки чата: с её сайдбаром, шапкой, блоком пользователя, строкой связи и уведомлениями. Признак: у экрана свой адрес, но он не должен перезапускать список бесед и поток событий, когда человек уходит на него из чата и возвращается.

## Shape

- **Раскладка группы `(chat)`** монтирует `ChatShell` один раз; файлы страниц под ней пусты и только занимают адрес. Динамический сегмент или целый раздел занимает одна пустая страница (для раздела — необязательный catch-all), и `params` она не читает: при `cacheComponents` чтение `params` потребовало бы `Suspense`.
- **`parseShellRoute`** в `lib/shell-route.ts` — единственное место, где адрес превращается в вид маршрута `ShellRoute`. Ключ записи из адреса раскодируется там же; неизвестный адрес даёт вид по умолчанию. Адреса строят только функции того же модуля (`threadPath`, `agentPath` и т. п.).
- **Потребители вида** — `MainView` (экран), `AppSidebar` (что стоит в сайдбаре и что выбрано), `ChatHeader` (заголовок `h1`, слоты заголовка и действий, кнопка рабочей области), `DocumentTitle` (вкладка), `ChatRuntimeProvider` (какую беседу открыть). Новый вид обрабатывает каждый из них.
- **Охрана по праву** — экран, которому нужно право, оборачивается компонентом-охраной в `MainView` и в `AppSidebar`; охрана читает право из общего значения `CurrentUser` и не даёт экрану читать данные, пока право не подтверждено.
- **Фокус после перехода** — на `h1` экрана через `focusShellTarget('page-title')`.

## Reference

- `apps/web/src/lib/shell-route.ts`
- `apps/web/src/components/shell/main-view.tsx`
- `apps/web/src/app/(chat)/layout.tsx`

## Not For

| Looks like | Use instead |
|---|---|
| страница без сайдбара и шапки, например вход | своя страница вне группы `(chat)` ([design-identity.md](../../features/enterprise-access/design-identity.md), C3 · web) |
| окно поверх текущего экрана | диалог в состоянии компонента; адрес не меняется |
| проверка права ради безопасности | проверка в API ([auth-boundary.md](./auth-boundary.md)); охрана в вебе только не показывает экран |

## Used In

- [design-admin.md](../../features/enterprise-access/design-admin.md) — KD-1, KD-2: вид `admin` и `AdminGate`
- [design-web.md](../../features/custom-agents/design-web.md) — KD-1: вид `library` и раздел панели `library`
- [design-schedules.md](../../features/schedules-search-memory/design-schedules.md) — виды списка расписаний и одного расписания, адреса `/schedules` и `/schedules/:id`
