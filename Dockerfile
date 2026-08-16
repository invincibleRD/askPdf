# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# AskPDF image
#
# One image serves both processes; the command decides whether a container is
# the API or the ingestion worker. That keeps the two in lockstep — a worker
# can never run a different build of the pipeline than the API that enqueues
# for it.
# ---------------------------------------------------------------------------

ARG NODE_VERSION=22.12.0

# ---- deps -----------------------------------------------------------------
# Production dependencies only, resolved in a layer that is rebuilt just when
# the lockfile changes.
FROM node:${NODE_VERSION}-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# ---- dev-deps -------------------------------------------------------------
# The full tree, used only to lint and test inside CI.
FROM node:${NODE_VERSION}-bookworm-slim AS dev-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

# ---- test -----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS test

WORKDIR /app

COPY --from=dev-deps /app/node_modules ./node_modules
COPY . .

RUN npm run lint && npm run test:unit

# ---- runtime --------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    # Node does not see cgroup memory limits by default, so a container with a
    # 512Mi limit will happily grow its heap past it and get OOM-killed.
    NODE_OPTIONS="--max-old-space-size=384"

# dumb-init reaps zombies and, more importantly, forwards SIGTERM to Node so
# the graceful shutdown path actually runs during a rolling deploy.
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The base image ships an unprivileged `node` user (uid 1000); use it rather
# than minting another, and give it ownership of the local storage mount.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

RUN mkdir -p /app/storage && chown -R node:node /app/storage

USER node

EXPOSE 3000

# Compose and standalone Docker use this; Kubernetes uses the HTTP probes in
# the Deployment instead.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/entrypoints/api.js"]
