# syntax=docker/dockerfile:1.7
# API image. The worker image shares its build stages (see worker.Dockerfile).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
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
# The image must carry the compiled entrypoints and the SQL migrations applied at boot.
# pnpm 11's legacy deploy links workspace packages back into this build stage;
# replace each link with a real copy of the package's manifest and build output.
RUN set -e; for link in /out/node_modules/@hermes-evals/*; do \
      if [ -L "$link" ]; then target="$(readlink -f "$link")"; rm "$link"; mkdir -p "$link"; \
        cp "$target/package.json" "$link/"; cp -r "$target/dist" "$link/dist"; fi; \
    done
RUN test -f /out/dist/main.js && test -f /out/dist/worker.js && test -f /out/drizzle/meta/_journal.json \
 && test -f /out/node_modules/@hermes-evals/shared/dist/index.js

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# api and worker share the evaldata volume and run as the same uid as trials.
RUN groupadd -g 10000 hermes && useradd -u 10000 -g 10000 -M -s /usr/sbin/nologin hermes \
 && mkdir -p /data && chown 10000:10000 /data
USER 10000:10000
EXPOSE 3000
CMD ["node", "dist/main.js"]
