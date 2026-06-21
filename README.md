# Azure DevOps MCP (on-prem)

[![CI](https://github.com/izhaq/Azure-devOps-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/izhaq/Azure-devOps-MCP/actions/workflows/ci.yml)

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes an
**on-premises Azure DevOps Server** to AI agents (Cursor, Copilot, Tabnine, Claude
Code, and any other MCP client) over the official Azure DevOps REST APIs.

Built for **fully offline / air-gapped** environments: the only outbound network
destination is your configured on-prem Azure DevOps Server. No internet, no telemetry.

---

## Deployment guides

| Guide | Who it is for |
|---|---|
| [Online guide](docs/online-guide.md) | The person on the **connected machine** who packages the server for transfer |
| [Offline guide](docs/offline-guide.md) | Every **developer on the air-gapped machine** who installs and uses it |

---

## Features

- **Two transports from one codebase**
  - **stdio** — each developer runs it locally; the MCP client spawns it as a child process.
  - **Streamable HTTP** — one instance hosted on an internal server; developers connect over the LAN.
- **Per-user PAT auth.** Personal Access Token via Basic auth (empty username). In HTTP
  mode the PAT is supplied per request via the `X-ADO-PAT` header and is **never stored or logged**.
- **Configurable REST `api-version`** (default `7.1`) for on-prem server builds.
- **Domain-based tools** you can selectively enable.
- **Offline-first.** No external dependencies at runtime — `dist/index.js` is fully self-contained.

## Requirements

- **Node.js ≥ 20 LTS** on the developer's machine.
- An on-prem Azure DevOps Server URL, a collection name, and a Personal Access Token (PAT).

---

## Available tools

Tools are grouped by **domain**; enable a subset with `-d` / `ADO_DOMAINS` (default: all).

### `core`
- `core_list_projects` — list team projects
- `core_list_teams` — list teams (project or collection-wide)

### `work-items`
- `wit_list_my_work_items` — list work items assigned to you (or a named teammate) in a compact one-line format
- `wit_query` — run a WIQL query
- `wit_get` — get a work item by id
- `wit_create` — create a work item
- `wit_update` — update a work item
- `wit_add_comment` — add a comment
- `wit_list_types` — list a project's work item types

### `repositories` (Git read)
- `repo_list` — list repositories
- `repo_list_branches` — list branches
- `repo_get_file` — read a file's contents
- `repo_list_items` — list files/folders
- `repo_list_commits` — list commits
- `repo_get_commit` — get a commit

### `repositories` (pull requests)
- `pr_list` — list pull requests
- `pr_get` — get a pull request by id
- `pr_list_threads` — list a PR's comment threads
- `pr_create` — create a pull request
- `pr_add_comment` — add a comment
- `pr_update_status` — set status `active` / `abandoned` / `completed`

### `pipelines`
- `pipeline_list` — list pipeline definitions
- `pipeline_get` — get a pipeline
- `build_list` — list builds
- `build_get` — get a build by id
- `build_queue` — queue a build
- `build_get_logs` — get build logs

### `work` (boards/iterations)
- `work_list_iterations` — list a team's iterations (sprints)
- `work_list_backlog_levels` — list backlog levels
- `work_get_capacity` — get team capacity for an iteration

### `wiki`
- `wiki_list` — list a project's wikis
- `wiki_get_page` — get a page by path
- `wiki_create_or_update_page` — create or edit a page

### `test-plans`
- `testplan_list` — list test plans
- `testplan_list_suites` — list test suites
- `testplan_list_cases` — list test cases in a suite

---

## Configuration

Configuration comes from environment variables. The setup script
(`scripts/setup-env.ps1`) handles this interactively on first install.

For the full reference see [`docs/configuration.md`](docs/configuration.md).

Common variables:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ADO_SERVER_URL` | yes | — | e.g. `http://devdev:3040/tfs` |
| `ADO_COLLECTION` | no | `DefaultCollection` | |
| `ADO_PAT` | stdio: yes | — | **HTTP mode: send per request via `X-ADO-PAT` header instead** |
| `ADO_API_VERSION` | no | `7.1` | Match your on-prem server build |
| `ADO_DOMAINS` | no | all | Comma-separated, e.g. `core,work-items,repositories` |

---

## Security

- The PAT is treated as a secret: never logged, never persisted, never put in errors.
- HTTP mode enforces `Origin`/`Host` allowlists, requires `X-ADO-PAT` (→ `401` when missing),
  caps request body size, and sets `HSTS` / `nosniff` / `X-Frame-Options: DENY`.
- Hosted mode must use TLS — PATs travel on every request.

---

## Development

```bash
npm ci
npm run build          # compiles to dist/index.js
npm run dev            # run from source (stdio)
npm run typecheck
npm run lint
npm test
npm run test:coverage
```
