# Multi-stage Dockerfile for forecry-bot-hn-pulse production image.
# Switched from node:22-slim to node:22-alpine to keep the final image
# under the 300MB ticket budget. apk postgresql-client matches the alpine base.

# --- builder: install all deps and compile TypeScript -------------------------
FROM node:22-alpine AS builder
WORKDIR /bot
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- prod-deps: production-only node_modules ---------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /bot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime: minimal image with psql client and migrate-on-boot entrypoint ---
FROM node:22-alpine AS runtime
WORKDIR /bot

RUN apk add --no-cache postgresql-client ca-certificates

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY --from=prod-deps /bot/node_modules ./node_modules
COPY --from=builder /bot/dist ./dist
COPY db ./db
COPY bin ./bin
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh ./bin/*.sh

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "dist/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "process.exit(0)" || exit 1
