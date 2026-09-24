# syntax=docker/dockerfile:1

# The Kru Bot API runs on Bun straight from source: no build step, and
# bun:sqlite for the database.
FROM oven/bun:1.4.2 AS install
WORKDIR /app
COPY package.json bun.lock* ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
# Only the API and what it needs; the web app's dependencies stay out.
# Frozen when the lockfile is committed; a first build without one resolves fresh.
RUN if [ -f bun.lock ]; then bun install --frozen-lockfile --production --filter @krubot/api --filter @krubot/shared; else bun install --production --filter @krubot/api --filter @krubot/shared; fi

FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8790 \
    KRU_DATA_DIR=/data
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json ./
COPY packages/shared ./packages/shared
# Bun's isolated linker puts each workspace's links in its own node_modules
# (shared's zod lives here, pointing into node_modules/.bun).
COPY --from=install /app/packages/shared/node_modules ./packages/shared/node_modules
COPY apps/api ./apps/api
RUN mkdir -p /data && chown bun:bun /data && chmod 700 /data
USER bun
VOLUME ["/data"]
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8790) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
WORKDIR /app/apps/api
CMD ["bun", "run", "src/index.ts"]
