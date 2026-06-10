# Hosted deployment (Streamable HTTP)

Run one shared instance of the Azure DevOps MCP server on an internal host and
let developers connect over the LAN. This is the **hosted** counterpart to the
local stdio mode each developer would otherwise run themselves.

> **Security model in one line:** the server holds **no** token. Each request
> must carry the caller's own Personal Access Token in the `X-ADO-PAT` header,
> and that PAT is used only for that request. Because PATs travel on every
> request, **hosted mode must be encrypted** — terminate TLS at a reverse proxy
> (recommended) or configure TLS on the server itself. Never expose the plain
> HTTP port to an untrusted network.

---

## 1. Build the image

```bash
docker build -t azure-devops-mcp:latest .
```

The [`Dockerfile`](../Dockerfile) is multi-stage: it compiles TypeScript with
dev dependencies, then ships only `dist/` plus production dependencies on a
slim Node base, running as the non-root `node` user.

To pin a Node major (defaults to the project floor, Node 22):

```bash
docker build --build-arg NODE_VERSION=20 -t azure-devops-mcp:latest .
```

## 2. Run the container

The default command is `--http`, binding `0.0.0.0:3000` inside the container.

```bash
docker run --rm -p 3000:3000 \
  -e ADO_SERVER_URL="https://devops.corp.local/tfs" \
  -e ADO_COLLECTION="DefaultCollection" \
  -e ADO_API_VERSION="7.1" \
  -e ADO_ALLOWED_ORIGINS="https://devbox.corp.local" \
  azure-devops-mcp:latest
```

Note there is **no `ADO_PAT`** here — in hosted mode the PAT comes from each
client request, not from server config.

### docker compose

```yaml
services:
  azure-devops-mcp:
    image: azure-devops-mcp:latest
    restart: unless-stopped
    # Bind to loopback on the host; the reverse proxy (below) is the public face.
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      ADO_SERVER_URL: "https://devops.corp.local/tfs"
      ADO_COLLECTION: "DefaultCollection"
      ADO_API_VERSION: "7.1"
      ADO_ALLOWED_ORIGINS: "https://devbox.corp.local"
      ADO_LOG_LEVEL: "info"
```

## 3. Configuration

All configuration is via environment variables (same as stdio mode). The ones
that matter for hosted deployments:

| Variable | Default | Notes |
|---|---|---|
| `ADO_SERVER_URL` | _(required)_ | Base URL of the on-prem server, e.g. `https://devops.corp.local/tfs`. |
| `ADO_COLLECTION` | `DefaultCollection` | Collection name. |
| `ADO_API_VERSION` | `7.1` | REST API version your server build supports. |
| `ADO_DEFAULT_PROJECT` | _(unset)_ | Optional default project. |
| `ADO_DOMAINS` | _(all)_ | Comma-separated tool domains to enable. |
| `ADO_HTTP_HOST` | `0.0.0.0` _(in image)_ | Bind interface. Keep `0.0.0.0` in a container. |
| `ADO_HTTP_PORT` | `3000` | Listen port. |
| `ADO_ALLOWED_ORIGINS` | _(none)_ | Comma-separated `Origin` allowlist for **browser** clients (DNS-rebinding defense). Non-browser clients send no `Origin` and are allowed. |
| `ADO_TLS_CERT` / `ADO_TLS_KEY` | _(unset)_ | Paths to PEM cert/key. When **both** are set the server serves HTTPS directly. Leave unset when terminating TLS at a proxy. |
| `ADO_PAGE_SIZE` | `50` | ADO paging size. |
| `ADO_MAX_RESULTS` | `200` | Cap on list results. |
| `ADO_TIMEOUT_MS` | `30000` | Per-request upstream timeout. |
| `ADO_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. PATs are always redacted. |

The single MCP endpoint is **`POST /mcp`**. There is no GET/SSE stream or
session teardown — the transport is stateless and POST-only.

---

## 4. TLS

### Option A — reverse proxy (recommended)

Keep the container on loopback and let a proxy handle TLS. Example nginx:

```nginx
server {
    listen 443 ssl;
    server_name devops-mcp.corp.local;

    ssl_certificate     /etc/ssl/corp/devops-mcp.crt;
    ssl_certificate_key /etc/ssl/corp/devops-mcp.key;

    location /mcp {
        proxy_pass http://127.0.0.1:3000/mcp;
        proxy_http_version 1.1;

        # Preserve the Host so the server's Host allowlist matches, and pass the
        # PAT header through to the app.
        proxy_set_header Host              $host;
        proxy_set_header X-ADO-PAT         $http_x_ado_pat;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
    }
}
```

The server validates the `Host` header for DNS-rebinding defense. It accepts the
configured bind host, loopback aliases, and any host implied by
`ADO_ALLOWED_ORIGINS`. If your proxy presents a different public hostname
(e.g. `devops-mcp.corp.local`), add it to `ADO_ALLOWED_ORIGINS` (as an origin
such as `https://devops-mcp.corp.local`) so its `Host` is allowed too.

### Option B — TLS in the container

Mount your cert/key and point the server at them:

```bash
docker run --rm -p 3000:3000 \
  -e ADO_SERVER_URL="https://devops.corp.local/tfs" \
  -e ADO_TLS_CERT="/certs/server.crt" \
  -e ADO_TLS_KEY="/certs/server.key" \
  -v /etc/ssl/corp:/certs:ro \
  azure-devops-mcp:latest
```

When serving HTTPS in-container, the built-in `HEALTHCHECK` (which speaks plain
HTTP on loopback) will not match — override or disable it
(`--no-healthcheck`, or a custom `HEALTHCHECK` in a wrapper image).

---

## 5. Verify it's working

The transport enforces three gates before any Azure DevOps call. Confirm each
from a shell that can reach the deployment.

**a) Missing PAT → `401`**

```bash
curl -i -X POST https://devops-mcp.corp.local/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# HTTP/1.1 401 Unauthorized — "missing X-ADO-PAT header"
```

**b) Disallowed `Origin` → `403`** (simulates a browser DNS-rebinding attempt)

```bash
curl -i -X POST https://devops-mcp.corp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Origin: https://evil.example" \
  -H "X-ADO-PAT: dummy" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# HTTP/1.1 403 Forbidden — Origin not in ADO_ALLOWED_ORIGINS
```

**c) Valid PAT → MCP `initialize` succeeds**

```bash
curl -i -X POST https://devops-mcp.corp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-ADO-PAT: <your-pat>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# HTTP/1.1 200 OK with a JSON-RPC result describing server capabilities
```

A wrong method (e.g. `GET /mcp`) returns `405`, and any other path returns `404`.

### Container health

```bash
docker inspect --format '{{.State.Health.Status}}' <container>
# healthy
```

---

## 6. Connecting a client

Point your MCP client at the hosted URL and supply the per-user PAT as the
`X-ADO-PAT` header. Example (shape varies by client):

```json
{
  "mcpServers": {
    "azure-devops": {
      "url": "https://devops-mcp.corp.local/mcp",
      "headers": { "X-ADO-PAT": "<your-pat>" }
    }
  }
}
```

---

## 7. Production checklist

- [ ] TLS in front of the server (reverse proxy) **or** `ADO_TLS_CERT`/`ADO_TLS_KEY` set.
- [ ] Plain HTTP port not reachable from untrusted networks (bind to loopback / private interface).
- [ ] `ADO_ALLOWED_ORIGINS` set if any browser-based clients connect.
- [ ] Proxy forwards the `X-ADO-PAT` header and a correct `Host`.
- [ ] `401` (no PAT) and `403` (bad Origin) verified against the deployed URL.
- [ ] Log level appropriate (`info` or `warn`); confirm PATs are redacted in logs.
- [ ] Container runs as non-root (default) and restarts on failure.
