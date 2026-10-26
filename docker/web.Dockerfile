# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
# The first `docker compose up --build` runs every image's install at once,
# beside the 1.1 GB Hermes pull; on a slow link pnpm's 60 s request timeout
# then fails the build (Phase 7). Fewer requests at a time, each allowed
# 10 minutes, retried 5 times; a fast link loses nothing to it.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true \
    pnpm_config_network_concurrency=4 pnpm_config_fetch_timeout=600000 pnpm_config_fetch_retries=5
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@hermes-evals/web..."
COPY packages/shared packages/shared
COPY apps/web apps/web
# The image talks to the real API (through nginx's /api proxy). Build with
# --build-arg VITE_API_MODE=fixtures for a fixtures-only demo build.
ARG VITE_API_MODE=live
ENV VITE_API_MODE=$VITE_API_MODE
RUN pnpm turbo run build --filter=@hermes-evals/web

FROM nginx:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
