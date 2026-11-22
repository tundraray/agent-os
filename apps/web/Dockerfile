# Image of the web server. Build context is the repository root; BuildKit reads the exclusions
# from `apps/web/Dockerfile.dockerignore` instead of the root `.dockerignore`, which hides the web:
#   docker build -f apps/web/Dockerfile -t agent-os-web:local .

FROM node:26-bookworm-slim AS build
RUN npm install --global pnpm@10.9.0
# Where the web server forwards `/api`. `next build` writes it into the routes manifest, so it is
# fixed per image; the default is the API service name in the compose network.
ARG API_INTERNAL_URL=http://api:4000
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter . --filter "web..."
RUN pnpm --filter web build

FROM node:26-bookworm-slim
# tini is PID 1: it passes signals to Node so the server stops cleanly.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# The standalone server listens on HOSTNAME:PORT; the default host is the container name only.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
# The standalone output is the whole application: `server.js` and the traced dependencies, laid out
# from the repository root. It does not carry the static files, which are served next to it. Owned
# by `node` because Next writes its cache into `.next/cache`.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/web/server.js"]
