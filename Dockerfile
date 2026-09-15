# syntax=docker/dockerfile:1

# =============================================================================
# Parlon — backend API
#
# Builds the API only. The salon app and the platform console are separate
# Next.js projects and are not in this image.
#
#   docker build -t parlon-api .
#   docker run --env-file .env -p 4000:4000 parlon-api
#
# Three stages, so what ships is the compiled output and production
# dependencies — no TypeScript, no test runner, no source. The build tools live
# in a layer that is thrown away.
#
# One process runs the API and the background worker together, which is what
# `JOB_WORKER_ENABLED` controls. That is right until message volume justifies
# splitting them; at that point run a second container of this same image with
# `JOB_WORKER_ENABLED=false` on the API and `npm run start:worker` as the
# command on the other.
# =============================================================================

# ----------------------------------------------------------------- base -----
# Debian slim rather than Alpine: Prisma's query engine wants glibc and OpenSSL,
# and fighting musl to save 40MB is a poor trade on a server image.
FROM node:22-slim AS base
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------- build ----
FROM base AS build
# NODE_ENV stays unset here so `npm ci` installs devDependencies — TypeScript
# and the Prisma CLI are both build-time-only.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

# Generate before compiling: the client's types are what the compiler checks against.
RUN npx prisma generate
RUN npx tsc -p tsconfig.json

# --------------------------------------------------------------- runtime ----
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4000

# Production dependencies only. `npm ci` is deterministic from the lockfile, so
# the image cannot drift from what was tested.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The generated Prisma client and its query engine. `@prisma/client` is a real
# dependency and was installed above; `.prisma` is generated output, so it has
# to come from the build stage — the CLI that produces it is not in this image.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

# The compiled app. tsconfig has rootDir "." and includes both src/ and
# prisma/, so the entry point is dist/src/server.js — not dist/server.js.
COPY --from=build /app/dist ./dist

# The schema and migrations travel with the image so the same container can run
# `npx prisma migrate deploy` on the way up.
COPY --from=build /app/prisma ./prisma

# Never root. The node user ships with the base image as uid 1000.
RUN chown -R node:node /app
USER node

EXPOSE 4000

# Asks the app the same question a load balancer would. Uses Node's built-in
# fetch rather than adding curl to the image for one line.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node is PID 1, which is fine here: server.ts installs SIGTERM and SIGINT
# handlers and drains the worker before exiting. Run with `--init` if you want
# a reaper for stray child processes.
CMD ["node", "dist/src/server.js"]
