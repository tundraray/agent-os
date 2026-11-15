# web

Веб Agent OS (Next.js, App Router, assistant-ui): беседы с чатом, экран «Агенты» и страница агента.

Как устроен клиент: команды — HTTP-запросы к `apps/api`, живые обновления — один поток SSE `GET /api/events`, лента — assistant-ui с внешним хранилищем (`useExternalStoreRuntime` над хранилищем ленты, которое перечитывает историю по заметкам потока).

## Как запустить локально

1. Запустить `api` по `apps/api/README.md` («How to run locally»): API слушает `http://localhost:4000`. В `apps/api/.env` переменная `FRONTEND_ORIGIN` должна совпадать с адресом веба (по умолчанию `http://localhost:3000`), иначе браузер не пропустит запросы с куками.
2. Создать `apps/web/.env.local` из `apps/web/.env.example`:

   ```
   NEXT_PUBLIC_API_URL=http://localhost:4000
   # необязательно; пусто — логи только в консоль браузера
   NEXT_PUBLIC_SENTRY_DSN=
   ```

   Без `NEXT_PUBLIC_API_URL` (или с неабсолютным адресом) приложение не стартует. Переменные `NEXT_PUBLIC_*` попадают в клиентскую сборку: после правки перезапустить `dev` или пересобрать.
3. Из корня репозитория:

   ```bash
   pnpm turbo build --filter=web^...   # собрать @agent-os/contracts и @agent-os/common
   pnpm --filter web dev               # http://localhost:3000
   ```

   Сборка и запуск собранного: `pnpm --filter web build`, затем `pnpm --filter web start` (тоже порт 3000).

## Маршруты

| Путь | Что показывает |
|---|---|
| `/` | новый чат |
| `/chat/<id>` | беседа |
| `/agents` | дерево агентов всех бесед |
| `/agents/<id>` | страница агента: лента, задание, управление |

## Проверки

```bash
pnpm --filter web test        # vitest: unit и интеграционные тесты (MSW, тестовый источник событий)
pnpm --filter web typecheck   # next typegen и tsc --noEmit
pnpm --filter web lint
```
