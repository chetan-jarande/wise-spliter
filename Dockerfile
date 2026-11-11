# syntax=docker/dockerfile:1
#
# Wise-Spliter - production container image (Backend API + Frontend).
# Modeled on merry-tools/Dockerfile.

FROM oven/bun:1.2-debian AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile || bun install

FROM oven/bun:1.2-debian AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN bun run build

FROM oven/bun:1.2-debian AS runner
WORKDIR /app

ENV NODE_ENV=production \
    APP_PORT=4173 \
    API_PORT=4174 \
    SUPABASE_SCHEMA=wise_spliter

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/vite.config.ts ./vite.config.ts

EXPOSE 4173 4174

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4174)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "start"]
