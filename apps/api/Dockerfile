# Image of the API server. Build context is the repository root:
#   docker build -f apps/api/Dockerfile -t agent-os-api:local .

FROM node:26-bookworm-slim AS build
RUN npm install --global pnpm@10.9.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter . --filter "api..."
RUN pnpm --filter api build
# `apps/api/dist` is the whole application: the workspace packages are compiled into it, with the code
# executor (`dist/executor`) and the migrations (`dist/migrations`) next to the bundle. What stays outside
# is third-party: the production dependencies of api, in the pnpm layout of development, because the code
# runner lets its executor read the QuickJS entries of the pnpm store by real path. The package sources
# are not needed at run time.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/web \
  && pnpm install --prod --frozen-lockfile --offline --ignore-scripts --filter api \
  && rm -rf packages apps/api/src apps/api/test

FROM node:26-bookworm-slim
# tini is PID 1: it passes signals to Node and reaps the short-lived child processes (code
# executors) that would otherwise stay zombies.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
# The API reads NODE_ENV in two places only, and `production` turns both off: the test hook
# RUNTIME_CRASH_AT (packages/runtime) and `http` MCP server addresses (packages/agents). Sign-in does not read it.
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/api
USER node
EXPOSE 4000
ENTRYPOINT ["tini", "--"]
# `start:prod` of package.json.
CMD ["node", "--disable-sigusr1", "dist/main"]
