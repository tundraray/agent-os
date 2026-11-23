# Объявление инструментов

## Problem

Сессии агента нужен набор инструментов для модели. Его части решают разные стороны: внешние инструменты (MCP, `run_code`) ограничены правами сотрудника, от чьего имени идёт задача, а системные (старт агентов, `task`, список задач) зависят от того, какой это агент. Признак: код, который собирает набор, начинает ветвиться по виду агента или знать инструменты по именам.

## Shape

```mermaid
---
title: "Откуда сессия получает инструменты"
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
    @keyframes litr_tools{0%,30%{stroke:#1d4ed8;stroke-width:6px}33.3%,100%{stroke:#9ec1f7;stroke-width:2px}}
---
flowchart LR
    entry(["▶ runtime отдаёт шаг<br/>с владельцем задачи"])
    snap["версия агента"]
    agent["1 · класс агента<br/>объявление"]
    lib["2 · toolsFor<br/>библиотека инструментов"]
    gate["AccessGate<br/>права сотрудника"]
    set["3 · набор сессии<br/>системные и внешние"]
    entry --> agent
    snap --> agent
    agent e1@-->|"владелец и объявление"| lib
    gate -->|"права"| lib
    lib e2@-->|"набор"| set
    set e3@-->|"инструменты модели"| agent
    classDef r1 stroke:#9ec1f7,stroke-width:2px,animation:litr_tools 3.6s linear 0s infinite
    classDef r2 stroke:#9ec1f7,stroke-width:2px,animation:litr_tools 3.6s linear 1.2s infinite
    classDef r3 stroke:#9ec1f7,stroke-width:2px,animation:litr_tools 3.6s linear 2.4s infinite
    class e1 r1
    class e2 r2
    class e3 r3
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    class entry entry
    class snap,agent,lib,gate,set unchanged
```

- **Один вход** — `toolsFor(ownerId, declaration)` реестра. Владельца даёт runtime в контексте шага, объявление — класс агента. Ответ — набор инструментов сессии; между шагами он не хранится.
- **Объявление** — простые данные (`ToolDeclaration`): серверы MCP агента, имена его системных инструментов по порядку, признак корня беседы и то, из чего инструменты строят свои описания: строки «кого можно запустить», флажки `taskList` и `listDelegation`. Его собирает конструктор `BaseAgent` из определения версии (`runDefinition`) в поле `declaration`; `ChatAgent` для вызова модели добавляет живой список записей сотрудника.
- **Внешние инструменты** выбирает только библиотека: `run_code` — каждой сессии, инструменты MCP — по правам владельца (`AccessGate.tools`) и его аккаунтам, суженные объявленными серверами. Вид агента в это решение не входит.
- **Системные инструменты** добавляются по объявлению. Библиотека не знает ни одного по имени: каждый регистрируется снаружи (`register`). Инструмент, чьё описание или схема зависят от агента, несёт в регистрации функцию `describe(declaration)`. Два флажка регистрации закрывают случаи, когда агент не может назвать инструмент сам: `rootOnly` — инструмент получает только корень беседы (инструменты записей из `apps/api`), `everySession` — каждая сессия.
- **Системный или внешний** — свойство инструмента в наборе: `kind` равен `system` или `external`. В историю и ответы API оно не попадает.
- **Исполнение** идёт через ту же библиотеку: вызов сверяют с набором без фильтра прав (`checkTools`), а исполнитель перед каждым вызовом заново спрашивает права.

## Reference

- `packages/agents/src/tools/tool.ts` — `ToolDeclaration`, контракт инструмента с `describe`
- `packages/agents/src/tools/tool-registry.ts` — `toolsFor`, `checkTools`, регистрация
- `packages/agents/src/agent/base-agent.ts` — `declaration` и `offeredDeclaration`; `agent/chat-agent.ts` — объявление корня
- `packages/agents/src/tools/system/index.ts` — набор системных инструментов; `apps/api/src/library/record-tools.ts` — инструменты записей

## Not For

| Looks like | Use instead |
|---|---|
| право сотрудника на сервер или инструмент | `AccessGate` в `apps/api`; библиотека только спрашивает его |
| правило, можно ли запустить запись или агента | чистая функция решения ([pure-decision.md](./pure-decision.md)) |
| определение агента: промпт, модель, флажки | версия агента ([immutable-versions.md](./immutable-versions.md)) |

## Used In

- [design-agents.md](../../features/agent-platform/design-agents.md) — инструменты сессии и их проверка
- [design-task.md](../../features/deep-agents/design-task.md) — описание и схема `task` по флажкам глубокого агента (DC-6)
