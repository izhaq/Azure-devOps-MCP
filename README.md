# Azure DevOps MCP (on-prem)

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes an
**on-premises Azure DevOps Server** to AI agents (Cursor, Copilot, Tabnine, and any
other MCP client) over the official Azure DevOps REST APIs.

Built for **fully offline / air-gapped** environments: the only outbound network
destination is your configured on-prem Azure DevOps Server. No internet, no telemetry.

> Status: **in active development.** Foundation, both transports, and the `core`,
> `work-items`, `repositories` (Git read + pull requests), `pipelines` (builds), and
> `work` (boards/iterations) tool domains are implemented. Remaining domains and
> packaging are in progress — see [Roadmap](#roadmap).

## Features

- **Two transports from one codebase**
  - **stdio** — each developer runs it locally; the MCP client spawns it.
  - **Streamable HTTP** — one instance hosted on an internal server; developers connect over the LAN.
- **Per-user PAT auth.** Personal Access Token via Basic auth (empty username). In HTTP
  mode the PAT is supplied per request via the `X-ADO-PAT` header and is **never stored or logged**.
- **Configurable REST `api-version`** (default `7.1`) for on-prem server builds.
- **Domain-based tools** you can selectively enable, mirroring `microsoft/azure-devops-mcp`.
- **Offline-first.** Native `fetch`, minimal dependencies, cross-platform (Windows/macOS/Linux), Node ≥ 20.

## Requirements

- **Node.js ≥ 20 LTS** (newer versions supported).
- An on-prem Azure DevOps Server URL, a collection, and a Personal Access Token (PAT).

## Install

```bash
npm ci
npm run build
```

## Configuration

Configuration comes from environment variables (see [`.env.example`](.env.example)).
Common ones:

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `ADO_SERVER_URL` | yes | — | e.g. `https://devops.corp.local/tfs` |
| `ADO_COLLECTION` | no | `DefaultCollection` | |
| `ADO_PAT` | stdio: yes | — | Raw PAT. **HTTP mode: do not set — sent per request via `X-ADO-PAT`.** |
| `ADO_API_VERSION` | no | `7.1` | Match your on-prem server build |
| `ADO_DOMAINS` | no | all | Comma-separated subset, e.g. `core,work-items,repositories` |
| `ADO_HTTP_HOST` | no | `127.0.0.1` | HTTP bind address |
| `ADO_HTTP_PORT` | no | `3000` | HTTP port |
| `ADO_ALLOWED_ORIGINS` | no | — | Origin allowlist for browser clients |
| `ADO_TLS_CERT` / `ADO_TLS_KEY` | no | — | When both set, HTTP mode serves HTTPS directly |
| `ADO_PAGE_SIZE` / `ADO_MAX_RESULTS` | no | `50` / `200` | Pagination + hard result cap |
| `ADO_TIMEOUT_MS` | no | `30000` | Per-request timeout |
| `ADO_LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |

See [`docs/configuration.md`](docs/configuration.md) for the full list (planned).

## Running

```bash
# stdio (local, default)
node dist/index.js --stdio

# HTTP (hosted)
node dist/index.js --http --port 3000

# Enable only some domains
node dist/index.js --stdio -d core,work-items,repositories
```

CLI flags: `--stdio` | `--http`, `--port <n>`, `--domains`/`-d <list>`, `--version`, `--help`.

### Connecting an MCP client (stdio)

Point your client's MCP config at the built entry point, for example:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js", "--stdio"],
      "env": {
        "ADO_SERVER_URL": "https://devops.corp.local/tfs",
        "ADO_COLLECTION": "DefaultCollection",
        "ADO_PAT": "<your-pat>"
      }
    }
  }
}
```

## Available tools

Tools are grouped by **domain**; enable a subset with `-d` / `ADO_DOMAINS` (default: all).

### `core` ✅
- `core_list_projects` — list team projects
- `core_list_teams` — list teams (project or collection-wide)

### `work-items` ✅
- `wit_query` — run a WIQL query
- `wit_get` — get a work item by id
- `wit_create` — create a work item (JSON-Patch)
- `wit_update` — update a work item (JSON-Patch)
- `wit_add_comment` — add a comment
- `wit_list_types` — list a project's work item types

### `repositories` (Git read) ✅
- `repo_list` — list repositories
- `repo_list_branches` — list branches
- `repo_get_file` — read a file's contents
- `repo_list_items` — list files/folders
- `repo_list_commits` — list commits
- `repo_get_commit` — get a commit

### `repositories` (pull requests) ✅
- `pr_list` — list pull requests (filter by status / target branch)
- `pr_get` — get a pull request by id
- `pr_list_threads` — list a PR's comment threads
- `pr_create` — create a pull request
- `pr_add_comment` — add a comment (new thread)
- `pr_update_status` — set status `active` / `abandoned` / `completed`

### `pipelines` (builds) ✅
- `pipeline_list` — list pipeline definitions
- `pipeline_get` — get a pipeline (optional revision)
- `build_list` — list builds (filter by definition / branch / status / result)
- `build_get` — get a build by id
- `build_queue` — queue a build (optional source branch + template parameters)
- `build_get_logs` — list a build's logs, or fetch one log's content lines

### `work` (boards/iterations) ✅
- `work_list_iterations` — list a team's iterations (sprints)
- `work_list_backlog_levels` — list a team's backlog levels
- `work_get_capacity` — get a team's capacity for an iteration

### Planned
- `wiki`, `test-plans`.

## Security

- The PAT is treated as a secret: never logged, never persisted, never put in errors.
- HTTP mode enforces `Origin`/`Host` allowlists (→ `403`), requires `X-ADO-PAT` (→ `401`
  when missing), caps request body size (→ `413`), and sets `HSTS` / `nosniff` / `X-Frame-Options: DENY`.
- **Hosted mode must use TLS** — set `ADO_TLS_CERT`/`ADO_TLS_KEY`, or run behind a
  TLS-terminating reverse proxy. Binding a non-loopback interface over plaintext would
  send per-user PATs in the clear.

## Development

```bash
npm run dev            # run from source (stdio)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run format         # prettier
npm test               # vitest
npm run test:coverage  # vitest + coverage
```

This repo follows a gated **spec → plan → tasks → implement** workflow and vendors a set
of agent skills under `.cursor/`. See [`AGENTS.md`](AGENTS.md), [`SPEC.md`](SPEC.md), and
[`tasks/`](tasks/) for the spec, plan, and progress checklist.

## Roadmap

Tracked in [`tasks/todo.md`](tasks/todo.md).

- ✅ Foundation, config/logging, REST client, MCP server + domains, stdio transport
- ✅ Streamable HTTP transport (security + per-request PAT)
- ✅ `core`, `work-items`, `repositories` (Git read + pull requests), `pipelines` (builds), `work` (boards/iterations) domains
- ⬜ `wiki`, `test-plans` domains
- ⬜ npm packaging, Dockerfile + hosted docs, cross-platform CI

## License

Internal. See repository settings.
