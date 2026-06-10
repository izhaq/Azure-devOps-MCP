# Configuration reference

The server is configured with **environment variables**, plus a few **CLI flags**
that pick the transport and can override two settings. This page is the complete
reference for both. For copy-paste client setups see
[`setup-local-stdio.md`](setup-local-stdio.md) (local) and
[`setup-hosted-http.md`](setup-hosted-http.md) (hosted).

## How configuration is loaded

- All options are read from environment variables at startup and validated with
  [zod](https://zod.dev). **Invalid config fails fast** with a single message
  listing every bad field (e.g. a missing `ADO_SERVER_URL` or a non-numeric port).
- A `.env` file is **not** loaded automatically. Export the variables in your
  shell, pass them via your MCP client's `env` block, or `-e`/`environment` in
  Docker. The repo ships [`.env.example`](../.env.example) as a template you can
  source yourself.
- Two CLI flags override the environment: `--port` overrides `ADO_HTTP_PORT`, and
  `--domains`/`-d` overrides `ADO_DOMAINS`. Everything else is env-only.

## Environment variables

### Connection (required / common)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADO_SERVER_URL` | **Yes** | — | Base URL of the on-prem Azure DevOps Server, e.g. `https://devops.corp.local/tfs`. Must be a valid URL. |
| `ADO_COLLECTION` | No | `DefaultCollection` | Collection name. |
| `ADO_PAT` | stdio only | — | Personal Access Token. **stdio:** required (this is your identity). **HTTP:** leave unset — each client sends its own PAT in the `X-ADO-PAT` header per request. Never commit a real value. |
| `ADO_API_VERSION` | No | `7.1` | REST API version your server build supports. On-prem builds vary; override if `7.1` isn't available. |
| `ADO_DEFAULT_PROJECT` | No | — | Optional default project name used when a tool doesn't get one. |

### Tool surface

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADO_DOMAINS` | No | all | Comma-separated list of tool domains to enable. Valid: `core`, `work`, `work-items`, `repositories`, `pipelines`, `wiki`, `test-plans`. Empty/unset = all. Unknown names fail at startup. Overridden by `--domains`/`-d`. |

### HTTP (hosted) transport

These only matter when running with `--http`. See
[`setup-hosted-http.md`](setup-hosted-http.md) for the full hosted guide.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADO_HTTP_HOST` | No | `127.0.0.1` | Bind interface. Use `0.0.0.0` to accept LAN connections (the Docker image sets this). |
| `ADO_HTTP_PORT` | No | `3000` | Listen port. Must be a positive integer. Overridden by `--port`. |
| `ADO_ALLOWED_ORIGINS` | No | — | Comma-separated `Origin` allowlist for **browser** clients (DNS-rebinding defense). Non-browser clients send no `Origin` and are allowed. Also feeds the `Host` allowlist. |
| `ADO_TLS_CERT` | No | — | Path to a PEM certificate. When **both** cert and key are set, the server serves HTTPS directly. |
| `ADO_TLS_KEY` | No | — | Path to the matching PEM private key. |

> **Security:** binding a non-loopback interface without TLS sends per-user PATs
> in cleartext. For hosted mode, either set `ADO_TLS_CERT`/`ADO_TLS_KEY` or run
> behind a TLS-terminating reverse proxy. The server logs a warning if you bind a
> non-loopback host without TLS.

### Tuning & logging

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADO_PAGE_SIZE` | No | `50` | Page size for paged Azure DevOps requests. Positive integer. |
| `ADO_MAX_RESULTS` | No | `200` | Upper bound on items a list tool returns. Positive integer. |
| `ADO_TIMEOUT_MS` | No | `30000` | Per-request upstream timeout in milliseconds. Positive integer. |
| `ADO_LOG_LEVEL` | No | `info` | One of `debug`, `info`, `warn`, `error`. PATs are always redacted from logs regardless of level. |

## CLI flags

```text
mcp-server-azuredevops [options]

  --stdio              Run over stdio (default)
  --http               Run the Streamable HTTP transport
  --port <number>      HTTP port (overrides ADO_HTTP_PORT)
  -d, --domains <list> Comma-separated domains to enable (overrides ADO_DOMAINS)
  --version            Print version and exit
  --help               Show help and exit
```

- If neither `--stdio` nor `--http` is given, **stdio** is used.
- `--port` must be a positive integer or the process exits with an error.

## Precedence

For the two overridable settings, **CLI flag → environment → default**:

| Setting | CLI flag | Env var | Default |
|---|---|---|---|
| HTTP port | `--port` | `ADO_HTTP_PORT` | `3000` |
| Domains | `-d` / `--domains` | `ADO_DOMAINS` | all |

All other settings are environment-only.

## How the PAT is resolved

The server never stores a shared token. Per request, the client used to call
Azure DevOps is built from:

1. The per-request `X-ADO-PAT` header (HTTP mode), else
2. `ADO_PAT` from the environment (stdio mode).

If neither is present, the tool call fails with a clear error. This is why
**stdio mode needs `ADO_PAT`** (your identity) and **HTTP mode does not** (each
caller authenticates themselves).

## Examples

### Minimal stdio (shell export)

```bash
export ADO_SERVER_URL="https://devops.corp.local/tfs"
export ADO_PAT="<your-pat>"
node dist/index.js --stdio
```

### Subset of domains

```bash
node dist/index.js --stdio -d core,work-items,repositories
```

### Hosted HTTP on a LAN interface, behind a proxy

```bash
ADO_SERVER_URL="https://devops.corp.local/tfs" \
ADO_HTTP_HOST="0.0.0.0" \
ADO_ALLOWED_ORIGINS="https://devops-mcp.corp.local" \
node dist/index.js --http --port 3000
```
