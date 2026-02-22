FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Agent data directory (keyfile, logs, history)
VOLUME /app/.agent-data

ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
