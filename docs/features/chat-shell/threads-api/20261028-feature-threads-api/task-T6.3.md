# Task T6.3: Ручная L1-проверка с реальной моделью

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 6, T6.3)
- Dependencies: T6.2 → Deliverable: пройденные итоговые гейты
- Provides: записанные результаты метрик № 7 и № 10 в Notes плана
- Size: Small (изменений кода нет; правится только пункт Notes плана)
- Covers: Verification (Certainty: medium); метрики № 7 и № 10

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
Ручная проверка API с реальными ключами провайдеров. Кода не пишет.
1. Метрика № 7 (автозаголовок): 20 бесед (рус./англ.) через `POST /api/threads` + `POST /api/chat/assistant` → заголовок появляется ≤ 10 с, на языке сообщения, длиной 1…80 символов. При провале — сменить `TITLE_MODEL`/уточнить инструкции (через `update` плана, т. е. эскалация оркестратору; самовольно инструкции не менять: `THREAD_TITLE_INSTRUCTIONS` — дословный контракт).
2. Метрика № 10 (время до первого токена `POST /api/chat/assistant`): «до» и «после» на одном и том же промпте, по 5 прогонов на каждой стороне. «До» — `main` (коммит 83fd532) в отдельном git worktree вне репозитория (`git worktree add <каталог вне репозитория> 83fd532`; в нём `pnpm install` и копия `apps/api/.env`); `pnpm --filter api dev` из worktree. «После» — рабочее дерево `feature/chat-shell` после Phase 5. Серверы запускаются по очереди на одном порту, прогоны чередуются. После замеров worktree удаляется (`git worktree remove`). Разница измеряет всю добавленную на отправку работу. В T2.5 на каждую отправку добавлены один SELECT по PK (`getOwnedThread`) и `recall` до 20 строк («сброс хвоста»); `deleteMessages` — только при перегенерации. Порог Design Doc («Стоимость сброса хвоста»): добавка ≪ 50 мс.
Результаты записываются в Notes плана. L1 через UI — после слияния с `web-shell` (вне этой части).

## Target Files
- [ ] `docs/features/chat-shell/threads-api/20261028-feature-threads-api.md` (только пункт «L1 / метрики № 7, № 10» в Notes)

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации. Продуктовый код и тесты не меняются.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Verification Strategy — Certainty: medium, § Performance Tests)
- `apps/api/.env.example`, `apps/api/.env` (ключи провайдеров, `TITLE_MODEL`)
- Notes плана: пункт «L1 / метрики № 7, № 10»

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ AC-17.1) | derived-display | «не позднее 10 с записать заголовок длиной 1…80 символов без кавычек и переводов строк»; e2e: ««План отпуска на Байкал» в течение 10 с (опрос 100 мс)» | Y, если в каждой из 20 бесед заголовок появился ≤ 10 с, длиной 1…80 символов, без кавычек и переводов строк, на языке сообщения |

## Decisions and Unresolved Items
Blocking unresolved items:

| Item | Required Input | Escalation Condition |
|---|---|---|
| Реальные ключи провайдеров | `apps/api/.env` с ключами, предоставленными пользователем | Ключей нет — задача не выполняется: вернуть оркестратору `blocked` с запросом ключей; не подменять мок-моделью |
| Провал метрики № 7 (заголовок > 10 с, не на языке сообщения, вне 1…80) | решение пользователя: сменить `TITLE_MODEL` или уточнить инструкции (через `update` плана) | При любом провале — записать результат в Notes и эскалировать оркестратору; код и инструкции самовольно не менять |

## Investigation Notes
(Заполняется исполнителем: окружение, `TITLE_MODEL`, таблица 20 бесед, 5 замеров «до» (`main` 83fd532) и 5 «после».)

## Implementation Steps
- [ ] Подготовить `apps/api/.env` с реальными ключами; `pnpm db:up`; `pnpm --filter api dev`
- [ ] Метрика № 7: 20 бесед (рус./англ.) — `POST /api/threads` + `POST /api/chat/assistant`; опрос `GET /api/threads/:id`; записать время появления, заголовок, язык, длину
- [ ] Метрика № 10, «до»: `git worktree add <каталог вне репозитория> 83fd532` (`main`); в worktree `pnpm install`, копия `apps/api/.env`; `pnpm --filter api dev` из worktree на выбранном порту; 5 замеров времени до первого токена одним и тем же промптом
- [ ] Метрика № 10, «после»: рабочее дерево `feature/chat-shell` после Phase 5, тот же порт (серверы запускаются по очереди, не одновременно), тот же промпт, 5 замеров; прогоны «до» и «после» чередуются
- [ ] Удалить worktree: `git worktree remove <каталог>`; основное рабочее дерево через git не откатывается (`git stash`/`checkout`/`reset` не запускаются)
- [ ] Записать результаты и отклонения в пункт Notes плана
- [ ] Отклонения эскалировать оркестратору
- [ ] Исполнитель **не коммитит** (в том числе и правку Notes)


## Quality Assurance Mechanisms
- oxlint type-aware (`typescript/no-floating-promises: error`) — Enforces: нет висящих промисов, типовые ошибки — Config/Source: `apps/api/.oxlintrc.json` — Type: `executable_check`
- TypeScript `strict`, `nodenext`, `.js`-суффиксы импортов — Enforces: строгие типы, без `as`-обхода — Config/Source: `apps/api/tsconfig.json`, `packages/contracts/tsconfig.json` — Type: `executable_check`
- Prettier — Enforces: форматирование — Config/Source: `apps/api/.prettierrc` — Type: `executable_check`
- Vitest unit / e2e (реальный Postgres) — Enforces: поведение и AC — Config/Source: `apps/api/vitest.config.ts`, `apps/api/vitest.config.e2e.ts` — Type: `executable_check`
- `nest build` — Enforces: сборка production-кода — Config/Source: `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json` — Type: `executable_check`
- Без миграций и новых таблиц — Enforces: система записи — `mastra_threads`/`mastra_messages` — Config/Source: Design Doc «Agreement Checklist» — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: ручной прогон `pnpm --filter api dev` с реальной моделью; запросы `curl`/HTTP-клиентом на `/api/threads` и `/api/chat/assistant`.
- **Success criteria**: 20/20 заголовков в пределах 10 с, на языке сообщения, 1…80 символов; метрика № 10 — 5 замеров «до» (`main`, коммит 83fd532) и 5 «после» (`feature/chat-shell` после Phase 5) записаны, увеличение времени до первого токена не выходит за порог Design Doc (≪ 50 мс) либо отклонение эскалировано.
- **Failure response**: любое отклонение — записать в Notes и эскалировать оркестратору; не менять код.
- **Verification level**: L1.

## Proof Obligations
### Obligation: Certainty: medium (реальная модель заголовков)
- **Claim**: реальная модель заголовков укладывается в 8 с таймаута/10 с AC и отвечает на языке сообщения.
- **Primary failure mode**: медленная или англоязычная модель по умолчанию; кавычки/`<think>` просачиваются в заголовок.
- **Boundary to exercise**: реальный провайдер модели через полный стек.
- **State assertion**: до: `title: null` → после: заголовок 1…80 символов.
- **Mock boundary rationale**: none (нет моков).
- **Residual**: L1 через UI — после слияния с `web-shell`.

### Obligation: метрика № 10
- **Claim**: добавленные в T2.5 SELECT по PK и `recall` до 20 строк («сброс хвоста») не ухудшают заметно время до первого токена (добавка ≪ 50 мс).
- **Primary failure mode**: проверка владельца и «сброс хвоста» выполняются неоптимально (лишние запросы, `recall` без ограничения 20 строк).
- **Boundary to exercise**: полный стек с реальной моделью.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Residual**: нет.

## Completion Criteria
- [ ] Результаты 20 бесед записаны; 5 замеров «до» (`main` 83fd532) и 5 «после» записаны в Notes плана
- [ ] Worktree удалён (`git worktree remove`)
- [ ] Отклонения эскалированы
- [ ] Compliance Check = `Y` либо провал эскалирован
- [ ] `git commit` не выполнялся

## Notes
- Impact scope: только Notes плана.
- Scope boundary: worktree создаётся вне репозитория и удаляется после замеров; код, тесты, `.env.example` не меняются (реальные ключи в репозиторий не попадают).
