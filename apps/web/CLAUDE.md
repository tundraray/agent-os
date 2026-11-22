# apps/web (`web`)

The web interface on Next.js: the chat shell with conversations and agents, the library, the employee account, the admin panel and sign-in. It depends only on `@agent-os/contracts` and `@agent-os/common`; nothing depends on it.

## Rules here

- This Next.js version differs from older ones: read `AGENTS.md` in this folder before writing Next code.
- All user-visible text goes to `src/i18n/translations/<lang>/<area>.json`, with the same key in every language. Components read it with `useTranslations`, dates and numbers with `useFormatter`. Lint rejects Cyrillic literals and the `'ru-RU'` locale in code.
- Code outside React (stores, services) does not build text: it passes a message key with values, and the component that shows it translates.
- API access goes only through the single client `apiRequest` in `src/lib/api/`; a component calls a function of its area module in `src/lib/<area>/`. No other `fetch` to the API.
- Request and response types and schemas come from `@agent-os/contracts`; do not redeclare them here.
- The browser reads the data. The Next server does not call the API for data, it only forwards `/api` requests.
- Follow the design system in `docs/design-system/` (foundations and component specs); use its tokens, no ad-hoc colours or sizes.
- Comfort over long sessions comes first: bounded contrast, no pure white and no pure black, in both themes.
- Log through `src/lib/logger.ts`, never `console` or Sentry directly.

## Check your work

- `pnpm --filter web lint`
- `pnpm --filter web typecheck`
- `pnpm --filter web test`
- `pnpm --filter web build`

## More

- [docs/code-system/packages/web.md](../../docs/code-system/packages/web.md)
- [interface-text.md](../../docs/code-system/patterns/interface-text.md), [web-api-client.md](../../docs/code-system/patterns/web-api-client.md), [shell-route.md](../../docs/code-system/patterns/shell-route.md)
- [docs/design-system/README.md](../../docs/design-system/README.md)
