# Task T7.1: Политика ссылок и изображений markdown

Metadata:
- Task type: frontend (apps/web)
- Phase: 7 — лента (шаг 10 DD)
- Dependencies: task-T2.1 (Vitest-обвязка); может идти параллельно с Phase 3–6 (не делит файлов)
- Provides: `linkPolicy`, `isRenderableImageSrc`, политика `a`/`img` в `markdown-text.tsx`
- Size: Small–Medium (5 файлов)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint (**без inline-отключений**), `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Политика недоверенного markdown: ссылки (`unsafe`/`new-tab`/`fragment`/`mail`) и изображения (`https`-only, `no-referrer`), кнопка «Копировать» блока кода. Security «Недоверенный markdown»; IP7.

## Target Files
- [ ] `apps/web/src/lib/markdown-policy.ts` (new)
- [ ] `apps/web/src/lib/markdown-policy.test.ts` (new)
- [ ] `apps/web/src/components/markdown-text.tsx`
- [ ] `apps/web/src/components/markdown-text.test.tsx` (new)
- [ ] `apps/web/eslint.config.mjs`

## Investigation Targets
- DD «Недоверенный markdown» (фрагменты `linkPolicy`, `isRenderableImageSrc`, `a`/`img`)
- `apps/web/src/utils/href.ts` (`safeHref` — **не менять**), `apps/web/src/components/markdown-text.tsx`, `apps/web/eslint.config.mjs`

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Недоверенный markdown) | derived-display | «опасная схема … → `span` с текстом ссылки **без `href`**»; «абсолютные `http(s)` → `target="_blank"` + `rel="noopener noreferrer"` … + sr-only «(откроется в новой вкладке)»»; «ссылки на тот же origin … → тоже новая вкладка»; «`#фрагмент` … → переход внутри документа без `target`»; «`mailto:` → без `target`»; «`img` рендерится только для абсолютного `https:`-источника, с `referrerPolicy="no-referrer"`, `loading="lazy"`, `decoding="async"`» | Y, если политика и рендер совпадают дословно |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| `linkPolicy`, `isRenderableImageSrc` | по фрагменту DD поверх `safeHref` | План T7.1 |
| Стиль файла | `markdown-text.tsx` — двойные кавычки без `;` (стиль файла) | План T7.1 |
| `MarkdownImageFallback` | для нерендерящегося `src` | План T7.1 |
| «Копировать» | `Copy` → «Копировать» | План T7.1 |
| ESLint | `src/components/markdown-text.tsx` добавить в список `files` переопределения `@next/next/no-img-element` с дополнением комментария; inline-отключений нет | План T7.1 |
| Что не делать | `rehype-raw` не подключать, `urlTransform` не трогать | План T7.1 |

## Investigation Notes
(Таблица «вход → результат политики».)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets
- [ ] U `markdown-policy.test.ts` — таблица DD: `javascript:alert(1)`, ` JAVASCRIPT:…`, `data:text/html,…`, `vbscript:…`, `''` → `unsafe`; `https://…`, `http://…`, `/chat/x`, `./a`, `?q` → `new-tab`; `#user-content-fn-1` → `fragment`; `mailto:a@b.c` → `mail`; `isRenderableImageSrc`: `https` → `true`, прочие → `false`
- [ ] C `markdown-text.test.tsx` — пять случаев DD
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] `markdown-policy.ts`; правки `markdown-text.tsx` и `eslint.config.mjs`; тесты зелёные

### 3. Refactor Phase
- [ ] Упростить; lint без inline-отключений

## Quality Assurance Mechanisms
- ESLint (`no-img-element` выключен только списком `files`) — Config: `apps/web/eslint.config.mjs` — Type: `executable_check`
- Vitest + RTL, `tsc` — Type: `executable_check`
- Security Considerations DD (недоверенный markdown) — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: U, C + гейты. Браузер (L1-4, T8.3; Phase 7 Operational Verification 3): ответ с `[опасная](javascript:alert(1))` — не ссылка; внешняя — в новой вкладке.
- **Success criteria**: тесты зелёные; lint 0 ошибок без inline-отключений.
- **Failure response**: расхождение с DD — эскалация.
- **Verification level**: L2.

## Proof Obligations
### Obligation: Failure Mode: invalid option — опасные схемы ссылок
- **Claim**: `javascript:`/`data:`/`vbscript:`/пустое → `span` без `href`; регистр и пробелы не обходят проверку.
- **Primary failure mode**: ` JAVASCRIPT:alert(1)` рендерится как ссылка.
- **Boundary to exercise**: in-process unit (таблица) + компонентный.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Proven by**: `new: markdown-policy.test.ts — таблица`; `new: markdown-text.test.tsx — пять случаев DD (рендер)`.
- **Residual**: остаточный риск `https`-изображения (вне объёма).

### Obligation: Security — изображения
- **Claim**: `img` только для абсолютного `https:`, с `no-referrer`, `lazy`, `async`.
- **Primary failure mode**: `http:`/относительный `src` рендерится.
- **Boundary to exercise**: in-process unit + компонентный.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Proven by**: `new: markdown-policy.test.ts — isRenderableImageSrc`; `markdown-text.test.tsx`.
- **Residual**: утечка через `https`-изображение — принятый остаточный риск DD.

## Completion Criteria
- [ ] Тесты зелёные (содержательно)
- [ ] lint (без inline-отключений), tsc — 0 ошибок
- [ ] Reference Contract — `Y`; Resolved decisions применены

## Notes
- Impact scope: `markdown-text.tsx`, `eslint.config.mjs`.
- Scope boundary: `apps/web/src/utils/href.ts` не менять.
