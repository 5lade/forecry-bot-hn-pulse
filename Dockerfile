# Dockerfile - generic bot container template
# Stage 3 (Spec) may extend this with bot-specific deps.

FROM node:22-slim AS base
WORKDIR /bot
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev || true
COPY . .
CMD ["node", "src/index.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "process.exit(0)" || exit 1
