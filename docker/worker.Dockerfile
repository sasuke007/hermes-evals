# syntax=docker/dockerfile:1.7
# Worker: the API build plus Python for verifier scripts. Hermes is NOT here:
# every trial runs in its own container from the trial image, started through
# docker-guard. The worker holds no Docker socket and no Hermes install.
FROM node:22-bookworm-slim AS base
# The first `docker compose up --build` runs every image's install at once,
# beside the 1.1 GB Hermes pull; on a slow link pnpm's 60 s request timeout
# then fails the build (Phase 7). Fewer requests at a time, each allowed
# 10 minutes, retried 5 times; a fast link loses nothing to it.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true \
    pnpm_config_network_concurrency=4 pnpm_config_fetch_timeout=600000 pnpm_config_fetch_retries=5
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/docker-guard/package.json apps/docker-guard/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@hermes-evals/api..."

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/docker-guard apps/docker-guard
COPY apps/api apps/api
RUN pnpm turbo run build --filter=@hermes-evals/api
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @hermes-evals/api deploy --prod --legacy /out
# pnpm 11's legacy deploy links workspace packages back into this build stage;
# replace each link with a real copy of the package's manifest and build output.
RUN set -e; for link in /out/node_modules/@hermes-evals/*; do \
      if [ -L "$link" ]; then target="$(readlink -f "$link")"; rm "$link"; mkdir -p "$link"; \
        cp "$target/package.json" "$link/"; cp -r "$target/dist" "$link/dist"; fi; \
    done
RUN test -f /out/dist/main.js && test -f /out/dist/worker.js && test -f /out/drizzle/meta/_journal.json \
 && test -f /out/node_modules/@hermes-evals/shared/dist/index.js

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
# Same uid as trials, so the worker can create and clean trial directories.
RUN groupadd -g 10000 hermes && useradd -u 10000 -g 10000 -M -s /usr/sbin/nologin hermes \
 && mkdir -p /data /trials && chown 10000:10000 /data /trials
USER 10000:10000
CMD ["node", "dist/worker.js"]
