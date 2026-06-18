# Verification runbook (on-prem checkpoints)

The automated suite (unit tests + CI) cannot reach your air-gapped Azure DevOps
Server, so the final sign-off is **manual**. This runbook walks a human through
the three remaining checkpoints on **Windows, macOS, and Linux**:

| Checkpoint | Proves | Needs |
|---|---|---|
| **B** | A real authenticated ADO call works over **stdio** (PAT auth + api-version + connectivity). | Server URL + your PAT |
| **C** | The **hosted HTTP** transport serves the security gates (`401`/`403`) and answers MCP over the wire. | A built image/host + your PAT |
| **E** | Final go/no-go: all of the above plus artifacts present. | The two above passing |

> **PAT hygiene (read first).** Your PAT is a secret. Don't paste it into shared
> terminals, screen-shares, or chat. Prefer setting it as an environment variable
> in your own shell. On Linux/macOS, prefix a command with a space (when
> `HISTCONTROL=ignorespace`) to keep it out of shell history; on Windows, clear
> the variable when you're done (`Remove-Item Env:ADO_PAT`).

---

## 0. Prerequisites (all platforms)

- **Node.js >= 20** (`node --version`).
- Network line of sight to your on-prem server (e.g. `https://devops.corp.local/tfs`).
- A **PAT** with at least *Project & Team (read)* scope (enough for `core_list_projects`).
- `curl` for the HTTP checkpoint:
  - macOS/Linux: preinstalled.
  - Windows 10/11: use **`curl.exe`** (PowerShell aliases `curl` to a different
    command). All examples below call `curl.exe` on Windows.

### Get the server

Either install from your internal registry…

```bash
npm install -g @corp/azure-devops-mcp     # provides `mcp-server-azuredevops`
```

…or build from source:

```bash
git clone https://github.com/izhaq/Azure-devOps-MCP.git
cd Azure-devOps-MCP
npm ci
npm run build                              # entry point: dist/index.js
```

In the commands below, the **run command** is one of:

- installed: `mcp-server-azuredevops`
- from source: `node dist/index.js`

---

## Checkpoint B — stdio real authenticated call

This drives the server over stdio with three newline-delimited JSON-RPC messages
(`initialize` → `notifications/initialized` → `tools/call core_list_projects`)
and pipes them in. A successful run prints a JSON-RPC result listing your
projects. Closing stdin (end of the pipe) makes the server exit on its own.

### macOS / Linux (bash or zsh)

```bash
export ADO_SERVER_URL="https://devops.corp.local/tfs"
export ADO_COLLECTION="DefaultCollection"
export ADO_PAT="<your-pat>"

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"runbook","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"core_list_projects","arguments":{}}}' \
  | node dist/index.js --stdio
```

### Windows (PowerShell)

```powershell
$env:ADO_SERVER_URL = "https://devops.corp.local/tfs"
$env:ADO_COLLECTION = "DefaultCollection"
$env:ADO_PAT        = "<your-pat>"

@(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"runbook","version":"1"}}}'
  '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"core_list_projects","arguments":{}}}'
) | node dist/index.js --stdio
```

> Using the installed binary instead of source? Replace `node dist/index.js`
> with `mcp-server-azuredevops`.

### What to look for

- **PASS:** stdout contains a JSON-RPC response with `"id":2` whose `result`
  lists projects (a `content` array with the projects JSON). Log lines on stderr
  show `transport: "stdio"`.
- **FAIL & fixes:**
  - `Invalid configuration: ADO_SERVER_URL …` → server URL missing/malformed.
  - Result for `id:2` is an error mentioning auth/401 → PAT wrong, expired, or
    lacks scope.
  - Error mentioning `api-version` or a 404 → set `ADO_API_VERSION` to match your
    server build (e.g. `7.0`), then re-run.

### Alternative: via your MCP client

If you'd rather not pipe JSON, point any MCP client at the server using
[`setup-local-stdio.md`](setup-local-stdio.md) and run the `core_list_projects`
tool from the client. Same outcome.

---

## Checkpoint C — hosted HTTP transport

Two parts: (1) prove the **security gates** with `curl`, and (2) prove the server
**answers MCP over HTTP**. Start the server in HTTP mode, then run the checks
from another shell.

### Start it

**From source (any OS):**

```bash
# macOS/Linux
ADO_SERVER_URL="https://devops.corp.local/tfs" \
ADO_ALLOWED_ORIGINS="https://devops-mcp.corp.local" \
node dist/index.js --http --port 3000
```

```powershell
# Windows (PowerShell)
$env:ADO_SERVER_URL      = "https://devops.corp.local/tfs"
$env:ADO_ALLOWED_ORIGINS = "https://devops-mcp.corp.local"
node dist/index.js --http --port 3000
```

**Or with Docker (any OS):**

```bash
docker build -t azure-devops-mcp:latest .
docker run --rm -p 3000:3000 \
  -e ADO_SERVER_URL="https://devops.corp.local/tfs" \
  -e ADO_ALLOWED_ORIGINS="https://devops-mcp.corp.local" \
  azure-devops-mcp:latest
```

### Part 1 — security gates (no real PAT needed)

Run these from a second terminal. Use `curl` on macOS/Linux and `curl.exe` on Windows.

**a) Missing PAT → `401`**

```bash
# macOS/Linux
curl -i -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

```powershell
# Windows
curl.exe -i -s -o NUL -w "%{http_code}`n" -X POST http://127.0.0.1:3000/mcp `
  -H "Content-Type: application/json" `
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expect `401`.

**b) Disallowed `Origin` → `403`**

```bash
# macOS/Linux
curl -i -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Origin: https://evil.example" \
  -H "X-ADO-PAT: dummy" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

```powershell
# Windows
curl.exe -i -s -o NUL -w "%{http_code}`n" -X POST http://127.0.0.1:3000/mcp `
  -H "Content-Type: application/json" `
  -H "Origin: https://evil.example" `
  -H "X-ADO-PAT: dummy" `
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expect `403`. (`GET /mcp` → `405`; any other path → `404`.)

### Part 2 — MCP over HTTP with a real PAT → `200`

```bash
# macOS/Linux
curl -i -s -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-ADO-PAT: <your-pat>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"runbook","version":"1"}}}'
```

```powershell
# Windows
curl.exe -i -s -X POST http://127.0.0.1:3000/mcp `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  -H "X-ADO-PAT: <your-pat>" `
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"runbook","version":"1"}}}'
```

Expect `200 OK` with a JSON-RPC `result` describing the server's capabilities.

### End-to-end hosted tool call

A full `core_list_projects` over HTTP is best driven by a real MCP client
pointed at the hosted URL (it performs the `initialize` handshake for you) — see
[`setup-hosted-http.md`](setup-hosted-http.md). The actual **ADO call path**
(auth header, api-version, connectivity) is already proven by **Checkpoint B**;
Checkpoint C's job is to prove the **HTTP transport + security gates**.

### What to look for

- **PASS:** `401`, `403`, and `200` (initialize) as above; behind a proxy, run
  the same checks against the public `https://…` URL.
- **FAIL & fixes:**
  - `403` on your *real* request → the `Host`/`Origin` isn't allowed; add your
    public host to `ADO_ALLOWED_ORIGINS` (e.g. `https://devops-mcp.corp.local`).
  - Connection refused → wrong port, or the container bound loopback only
    (the image sets `ADO_HTTP_HOST=0.0.0.0`; from source set it explicitly).
  - PATs in cleartext warning in logs → expected unless TLS is configured; for
    real deployments terminate TLS (see `setup-hosted-http.md`).

---

## Checkpoint E — final sign-off

Tick every box; record evidence (command output / screenshots) next to each.

- [ ] **Build is clean** on the target OS: `npm ci && npm run build` succeeds.
- [ ] **Unit suite green**: `npm test` (and `npm run test:coverage` — the suite
      enforces ≥ 80% coverage, with `src/azure` + `src/tools` well above that).
- [ ] **Checkpoint B passed** — `core_list_projects` returned real projects over
      stdio (record the OS used).
- [ ] **Checkpoint C passed** — `401` / `403` gates hold and `initialize`
      returns `200` over HTTP (record source-run and/or Docker).
- [ ] **Cross-platform**: B (and ideally C) confirmed on **at least** the OSes
      your team uses (Windows / macOS / Linux).
- [ ] **Artifacts present**: npm tarball builds (`npm pack`) and the Docker image
      builds + runs (`docker build` / `docker run`).
- [ ] **CI green** on `main` (the badge in the README).
- [ ] **Secrets clean**: no PAT in logs, shell history, or committed files.

When all boxes are checked, the server is verified for your environment.

---

## Quick OS-specific gotchas

| Platform | Gotcha |
|---|---|
| **Windows** | Use `curl.exe` (not `curl`). In PowerShell, pass JSON to `-d` as a **single-quoted** string (the inner `"` are literal — no `\"` escaping), and line continuation is a backtick `` ` ``. Clear the PAT with `Remove-Item Env:ADO_PAT`. |
| **macOS** | If `node` isn't found, install an LTS (e.g. via `nvm`/Homebrew). Gatekeeper doesn't affect Node scripts. |
| **Linux** | Headless boxes: the stdio check needs no display. If `npm ci` can't reach your registry, confirm the `@corp` scope in `.npmrc`. |

See [`configuration.md`](configuration.md) for every setting and
[`setup-local-stdio.md`](setup-local-stdio.md) / [`setup-hosted-http.md`](setup-hosted-http.md)
for client and hosted setup.
