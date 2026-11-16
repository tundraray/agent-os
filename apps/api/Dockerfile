# Image of the API server. Build context is the repository root:
#   docker build -f apps/api/Dockerfile -t agent-os-api:local .

FROM node:26-bookworm-slim AS build
RUN npm install --global pnpm@10.9.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter . --filter "api..."
RUN pnpm turbo build --filter=api...
# Production dependencies only, in the same workspace layout as in development: the code runner
# lets its executor read `packages/code-runner/dist` and the QuickJS entries of the pnpm store by
# real path, and `config/mcp-servers.json` starts the fixture MCP servers by a relative path.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/web \
  && pnpm install --prod --frozen-lockfile --offline --ignore-scripts \
    --filter "api..." --filter @agent-os/mcp-fixture

FROM node:26-bookworm-slim
# tini is PID 1: it passes signals to Node and reaps the short-lived child processes (code
# executors, MCP servers) that would otherwise stay zombies.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
# The API reads NODE_ENV in two places only, and `production` turns both test hooks off:
# RUNTIME_CRASH_AT (packages/runtime) and FIXTURE_FAULTS (packages/mcp-fixture). Sign-in does not read it.
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/api
USER node
EXPOSE 4000
ENTRYPOINT ["tini", "--"]
# `start:prod` of package.json.
CMD ["node", "--disable-sigusr1", "dist/main"]
