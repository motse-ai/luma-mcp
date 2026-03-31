FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig*.json ./
COPY src ./src

# Install full deps for TypeScript build.
RUN npm ci

# Build server entry to ./build.
RUN npm run build

# Keep runtime dependencies only.
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/build ./build

EXPOSE 8080

USER node

CMD ["node", "build/index.js"]
