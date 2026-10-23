# syntax=docker/dockerfile:1.7
# Small Node services with no Nest and no shared package: docker-guard and egress.
#   docker build --build-arg APP=egress -f docker/node-service.Dockerfile .
ARG APP
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
WORKDIR /repo

FROM base AS build
ARG APP
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/${APP}/package.json apps/${APP}/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@hermes-evals/${APP}..."
COPY apps/${APP} apps/${APP}
RUN pnpm --filter "@hermes-evals/${APP}" build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter "@hermes-evals/${APP}" deploy --prod --legacy /out
RUN test -f /out/dist/main.js

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# Socket directories, owned by the user each service runs as (guard: root, egress: node).
RUN mkdir -p /run/guard /run/egress && chown node:node /run/egress
CMD ["node", "dist/main.js"]
