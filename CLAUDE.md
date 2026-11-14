# Agent OS

## Project status: PoC

Agent OS is a proof of concept, not a product in production.

- Prefer the shortest path to working code and an observable result.
- No backward compatibility, ever. There is exactly one version of everything: we are developing a PoC. Replace old formats, configs, APIs and versions outright and delete the old code. No compatibility layers, side-by-side versions, feature switches, deprecation periods or migrations of existing records.
- Delete unused code. When a change leaves old code without a caller — a replaced module, a dead branch, an orphaned helper, its tests and config — remove it in the same change. Nothing is kept "just in case".
- Keep documents and review rounds to what blocks building. Do not propagate "affected decisions" marks into neighbouring documents, and do not spend fix rounds on recommended-level findings.

## Code rules

- KISS: the simplest code that does the job. No abstraction, option or layer until a second real use needs it.
- DRY: one place for each piece of logic and each value. Reuse what exists before writing new code.
- Simple, readable code first: clear names, small functions, straight control flow. Clever code loses to obvious code.
- Describe the architecture: layers, package boundaries and dependency direction are written down (Design Docs, ADRs, `docs/code-system/`) and kept in step with the code.
- Use common patterns: solve a problem the way the codebase and the ecosystem already solve it. A new pattern needs a reason and goes into the architecture description.

## Tests

- Few tests, on what is critical: security and rights checks, isolation between users, data integrity, money and limits, restarts and concurrency, and the main path of each feature.
- Many tests are a cost, not a virtue: they mostly duplicate each other and only add run time. Before adding a test, check that no existing test already catches the same defect.
- No tests for trivial code, library behaviour, or the same behaviour at several levels. One test at the lowest level that catches the defect.
- When code is deleted or replaced, delete its tests with it.

## Logging

- Logging goes through our own logger wrapper, never through Sentry or `console` directly. The wrapper writes every record to both Sentry and the console.
- The wrapper lives in the shared package `packages/common`, used by both `apps/api` (NestJS) and `apps/web` (Next.js) and by every other package. `packages/common` depends on no other workspace package.
- Log as much as possible: every step of an agent, workflow and background task, with identifiers (session, agent, run, user, tool call, model), inputs, outcomes, durations and full error details.
- Never log secrets: credentials, tokens, API keys.

Project context (problem, users, constraints, conventions): `.claude/skills/project-context/SKILL.md`.
