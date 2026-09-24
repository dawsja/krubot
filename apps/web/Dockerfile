# syntax=docker/dockerfile:1

# The Kru Bot web app: Next.js, installed and built with Bun, served by Bun.
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock* ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN if [ -f bun.lock ]; then bun install --frozen-lockfile --filter @krubot/web --filter @krubot/shared; else bun install --filter @krubot/web --filter @krubot/shared; fi
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
ENV NEXT_TELEMETRY_DISABLED=1 \
    KRU_STANDALONE=1
RUN cd apps/web && bun run build

FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
# Application files stay owned by root; the server can only write Next's cache.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
RUN mkdir -p apps/web/.next/cache && chown -R bun:bun apps/web/.next/cache
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "apps/web/server.js"]
