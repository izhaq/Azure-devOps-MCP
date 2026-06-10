# syntax=docker/dockerfile:1

# Multi-stage build for the Azure DevOps (on-prem) MCP server.
# Default command runs the Streamable HTTP transport for hosted deployments.
# Pin the Node major to the project's floor (engines: ">=20"); bump deliberately.
ARG NODE_VERSION=22

# --- Stage 1: build -----------------------------------------------------------
# Compile TypeScript to dist/ with full (dev) dependencies available.
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

# Install dependencies first for better layer caching. `npm ci` is reproducible
# and fails if package.json and package-lock.json have drifted.
COPY package.json package-lock.json ./
RUN npm ci

# Copy only what the build needs (prebuild generates src/version.ts).
COPY tsconfig.json tsup.config.ts ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# --- Stage 2: production dependencies ----------------------------------------
# A clean install with dev dependencies pruned, for a lean runtime image.
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Stage 3: runtime ---------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Bind to all interfaces so the server is reachable from outside the container.
# SECURITY: this serves plaintext. Run behind a TLS-terminating reverse proxy,
# or set ADO_TLS_CERT/ADO_TLS_KEY. Per-user PATs travel per request — never
# expose this port directly to an untrusted network without TLS.
ENV ADO_HTTP_HOST=0.0.0.0 \
    ADO_HTTP_PORT=3000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 3000

# Run as the unprivileged user shipped with the official Node image.
USER node

# Liveness probe: any HTTP response to POST /mcp proves the transport is up
# (with no PAT header the server replies 401, which counts as alive). Uses node
# (no shell/curl needed). If you terminate TLS *inside* the container, this
# plain-HTTP probe won't match — adjust or drop it (see docs/setup-hosted-http.md).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "const p=process.env.ADO_HTTP_PORT||3000;const r=require('http').request({host:'127.0.0.1',port:p,path:'/mcp',method:'POST',timeout:3000},(res)=>process.exit(res.statusCode?0:1));r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)});r.end();"]

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--http"]
