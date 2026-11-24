# Нижние пакеты: `common`, `contracts`, `code-runner`

Три пакета без NestJS: lint запрещает им `@nestjs/*`, а их код — обычные функции и классы. В DI их значения попадают через провайдер того модуля, которому они нужны ([composition-root.md](../patterns/composition-root.md)).

## `common`

Логгер и маска секретов. Пакет не зависит ни от одного пакета workspace и ни от одного SDK; его используют все пакеты и оба приложения.

| Файл | Что там |
|---|---|
| `src/logger.ts` | `createLogger`, тип `Logger`, токен `LOGGER`, маска `createSecretMasker` и память секретов `rememberSecret` |
| `src/sinks.ts` | приёмники: консоль и Sentry; SDK Sentry им передаёт приложение |
| `src/testing.ts` | приёмник в памяти `memorySink` для тестов |

Как писать лог — [logging.md](../patterns/logging.md).

## `contracts`

zod-схемы данных, которые пересекают границу: тела запросов и ответов API, вход и выход задач runtime, содержимое записей библиотеки, наборы значений для CHECK. Файл на область (`library.ts`, `access.ts`, `runtime.ts` и другие). Пакет зависит только от zod, и его импортирует и бэкенд, и `apps/web`. Здесь же функции, которые нужны обеим сторонам, например `modelProvider` — провайдер по id модели ([ADR-0018](../../adr/ADR-0018-model-id-provider-prefix.md)).

## `code-runner`

Исполнитель кода для `run_code` и скриптов агента ([ADR-0011](../../adr/ADR-0011-code-runner-quickjs-process.md)): отдельный процесс Node на один скрипт с QuickJS внутри, мост с процессом API, пределы и убийство процесса. Об агентах пакет не знает, таблиц у него нет.

```mermaid
---
title: "code-runner · вызов инструмента из скрипта"
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
    @keyframes lit_cr{0%,18%{stroke:#991b1b;stroke-width:6px}20%,100%{stroke:#f4a5a5;stroke-width:2px}}
---
flowchart LR
    runcode(["▶ run_code<br/>агент"])
    runner["1 · CodeRunner<br/>процесс API"]
    exec["2 · процесс исполнителя<br/>QuickJS"]
    check["3 · исполнитель инструментов<br/>agents"]
    mcp(["сервер MCP"])
    runcode --> runner
    runner e1@-->|"скрипт"| exec
    exec e2@-->|"просьба по мосту"| runner
    runner e3@-->|"callTool"| check
    check e4@-->|"после проверки прав"| mcp
    mcp e5@-->|"результат"| check
    classDef w1 stroke:#f4a5a5,stroke-width:2px,animation:lit_cr 6s linear 0s infinite
    classDef w2 stroke:#f4a5a5,stroke-width:2px,animation:lit_cr 6s linear 1.2s infinite
    classDef w3 stroke:#f4a5a5,stroke-width:2px,animation:lit_cr 6s linear 2.4s infinite
    classDef w4 stroke:#f4a5a5,stroke-width:2px,animation:lit_cr 6s linear 3.6s infinite
    classDef w5 stroke:#f4a5a5,stroke-width:2px,animation:lit_cr 6s linear 4.8s infinite
    class e1 w1
    class e2 w2
    class e3 w3
    class e4 w4
    class e5 w5
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    class runcode entry
    class runner,exec,check,mcp unchanged
```

Процесс исполнителя ничего не решает сам: он только присылает просьбы вызвать инструмент или прочитать результат. Каждую просьбу проверяет процесс API той же проверкой, что вызов агента, и сам ходит к серверу MCP.

| Путь | Что там |
|---|---|
| `src/code-runner.ts` | `createCodeRunner` и `CodeRunner.run`: запуск процесса, мост, пределы |
| `src/executor/` | вход процесса исполнителя; Node исполняет его сам, импорты через `#executor/*` |

- Процесс запускается только с флагами модели разрешений Node и читает только каталог своего входа (`dist/executor` в сборке `apps/api`, `src/executor` пакета в тестах) и QuickJS из каталогов, где ни одна ссылка не ведёт наружу.
- Пакет зовёт только `agents`. Правила вызовов держит вызывающий, а не пакет ([design-code-execution.md](../../features/code-execution/design-code-execution.md), KD-1, KD-2).
