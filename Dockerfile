# syntax=docker/dockerfile:1.7

# ---- build: compile the server and bundle the web client -----------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm run build:web

# ---- prod-deps: only what the server needs at runtime ---------------------------
# Kept separate so the runtime image never contains the compiler, Vite, React,
# CodeMirror, or anything else that was only needed to build the client.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- node-bin: where the node binary comes from --------------------------------------
FROM node:22-alpine AS node-bin

# ---- runtime ----------------------------------------------------------------------------
# Built from a clean Alpine and given only the `node` binary. The official
# node image also carries npm, yarn, and Node's C++ headers (about 30 MB) that
# a runtime never uses, and deleting them in a later layer would not shrink the
# image, since the base layer still holds them. Starting from scratch is what
# actually removes them. (The migration job calls the node-pg-migrate script
# directly, so it needs no npm.)
FROM alpine:3.21 AS runtime
RUN apk add --no-cache libstdc++ \
 && addgroup -g 1000 -S node && adduser -u 1000 -S -G node node
COPY --from=node-bin /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    WEB_ROOT=/app/web/dist
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY migrations ./migrations
COPY package.json ./
USER node
EXPOSE 8080
# Liveness only (see /healthz vs /readyz): this must not depend on Redis or
# Postgres, or an outage would restart healthy instances.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "dist/index.js"]
