# Spec: Azure DevOps MCP Server (On-Prem)

> Status: **DRAFT — open questions resolved; awaiting final human approval** (Phase 1 / SPECIFY of the spec → plan → tasks → implement workflow).
> Owner: Dev tooling. Last updated: 2026-05-31.

## Objective

Build a **Model Context Protocol (MCP) server** that exposes **Azure DevOps Server (on-premises)** functionality to AI coding agents, so the whole dev team can drive Azure DevOps (work items, repos, PRs, pipelines, boards, wiki, test plans) from any MCP-capable client.

**Why:** The official Microsoft Azure DevOps MCP assumes cloud connectivity. Our environment is **fully offline** — Azure DevOps is hosted on internal servers with no internet egress — so we need a self-hosted server that talks only to the on-prem ADO REST APIs.

**Users:** Internal developers using MCP clients (Tabnine, GitHub Copilot, Cursor, and others — must be **client-agnostic**).

**Success looks like:** A dev configures their server URL + personal PAT, points their MCP client at the server (locally or at the hosted internal instance), and can list/create/update Azure DevOps artifacts through natural-language agent actions, with per-user permissions and no data leaving the corporate network.

### Acceptance criteria (high level)
- Works on **Windows, macOS, and Linux**.
- Runs in a **completely offline** network; the only outbound destination is the configured on-prem ADO server.
- Supports **two transports** from a single codebase: local **stdio** and remote **Streamable HTTP**.
- **Per-user authentication** via PAT; in hosted mode the PAT is supplied per request and never persisted or logged.
- REST **api-version is configurable** (default `7.1`).
- Distributed as both an **internal npm package** and a **Docker image**.

## Tech Stack

| Concern | Choice | Notes |
|--------|--------|-------|
| Language | TypeScript (strict), ESM (`"type": "module"`) | Cross-platform via Node; mirrors official MS MCP |
| Runtime | **Node.js ≥ 20 LTS** — support newer (22, 24+) when available | `engines.node: ">=20"`; CI tests on 20 + current LTS |
| MCP framework | `@modelcontextprotocol/sdk` | Official SDK; supports stdio + Streamable HTTP |
| HTTP client | Native `fetch` (Node ≥ 20) | No extra dep; talks to ADO REST directly (full api-version control for on-prem) |
| CLI parsing | `node:util` `parseArgs` | No dependency; official MCP uses `yargs` — we keep it dep-free |
| Validation | `zod` | Tool input schemas + config validation |
| HTTP server (hosted mode) | SDK Streamable HTTP transport (+ minimal `node:http`) | No heavyweight framework unless needed |
| Tests | `vitest` | Unit + integration |
| Lint/format | ESLint + Prettier | |
| Build | `tsup` (or `tsc`) | Emits Node ESM bundle + `bin` |
| Packaging | npm package (`bin`, `files: ["dist"]`) + Docker image | Internal registry + internal Docker registry |

> Dependency policy: external npm packages may be pulled into the internal registry **only when justified** (see Boundaries → Ask first). Default to the standard library + the few deps above.

## Architecture

```
                       ┌──────────────────────────────┐
   MCP client ──stdio──▶│         MCP Server core      │
   (per dev)            │  - tool registry             │
                        │  - request context (PAT,     │
   MCP client ──HTTP───▶│    collection, api-version)  │──REST──▶ On-prem Azure
   (remote, LAN)        │  - input validation (zod)    │         DevOps Server
                        │  - error mapping             │         (only network dest)
                        └──────────────┬───────────────┘
                                       │
                          ┌────────────┴────────────┐
                          │ Azure DevOps REST client │
                          │  - base URL + collection │
                          │  - api-version           │
                          │  - PAT Basic auth        │
                          │  - pagination / errors   │
                          └─────────────┬────────────┘
                                        │
        ┌────┬──────┬──────────────┬──────────┬──────┬──────┬───────────┐
      core  work  work-items  repositories  pipelines  wiki  test-plans   ← domain modules
```

### Modular structure — follows the official MS Azure DevOps MCP

We mirror the conventions of the well-adopted `microsoft/azure-devops-mcp` (and the reference `modelcontextprotocol/servers`) so the project is familiar to contributors and respects MCP client tool limits:

- **Domain-based tool modules.** Each ADO area lives in `src/tools/<domain>.ts` and exports a `configure<Domain>Tools(server, deps)` function. Tools register themselves with the `McpServer`.
- **Central orchestrator.** `src/tools.ts` registers domains via a `configureIfDomainEnabled(domain, fn)` helper, conditioned on the enabled set.
- **Domain filtering.** `src/shared/domains.ts` defines a `Domain` enum + a `DomainsManager`. A `--domains` / `-d` CLI flag (and `ADO_DOMAINS` env) enables only selected groups; **default loads all domains**. This keeps the toolset manageable and avoids overwhelming the model.
- **Dependency injection.** Tool configurators receive providers (REST client factory + per-request context), not globals — keeps them unit-testable with a mocked client.
- **Supporting modules** like the official: `logger.ts`, `version.ts` (generated from `package.json`), `useragent.ts` (appends MCP client info to the ADO `User-Agent`).
- **Domain names** align with the official where sensible: `core`, `work` (boards/iterations/sprints), `work-items`, `repositories` (incl. pull requests), `pipelines`, `wiki`, `test-plans`.

### Transport & auth model (critical)

| Mode | How it runs | ADO server URL / collection | PAT source |
|------|-------------|------------------------------|-----------|
| **Local (stdio)** | Each dev runs the npm package on their machine; MCP client spawns it | From the dev's local config / env | From the dev's local config / env (never committed) |
| **Hosted (HTTP)** | One Docker instance on an internal server; devs connect over LAN | **Server-configured** (the corporate ADO collection) | **Per request**, via header; **never stored, never logged** |

- Auth is **per-user** in both modes. The PAT is provided **raw**; the server itself builds the ADO `Authorization: Basic base64(":"+PAT)` header (empty username = on-prem PAT convention, mirroring the official MS MCP `pat` mode).
- In hosted mode the server is a stateless pass-through: it reads the caller's PAT from a dedicated request header, uses it for that request only, then discards it. **The PAT is never stored, cached, or logged.**
- **Hosted PAT header: `X-ADO-PAT`** (raw PAT). A custom header is used deliberately so the MCP `Authorization` header stays free for a future gateway/OAuth-2.1 layer — per the MCP spec, `Authorization` is reserved for MCP-level authorization.

### Hosted (HTTP) transport security — required (per MCP spec 2025-11-25)

The Streamable HTTP transport follows the MCP transport security requirements:

- Single MCP endpoint `/mcp` supporting **POST + GET**; `Mcp-Session-Id` for sessions; honor `MCP-Protocol-Version`.
- **MUST validate `Origin` and `Host`** headers against an allowlist → respond **`403 Forbidden`** on mismatch (DNS-rebinding defense). Requests without `Origin` (non-browser clients) are allowed unless configured otherwise.
- **Local/stdio-adjacent HTTP binds to `127.0.0.1`**; the hosted instance binds to an internal interface only.
- **TLS is mandatory for remote access.** Recommended deployment: the Docker container serves plain HTTP on the internal network and a **reverse proxy (e.g. nginx/Traefik on the internal server) terminates TLS** (TLS 1.2 min, 1.3 preferred) and adds **HSTS**. Optionally the container can serve HTTPS directly when cert paths are provided.
- Security response headers on all HTTP responses: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.
- A hosted request **missing a valid `X-ADO-PAT`** is rejected (401).

## Tool Surface (v1 = all areas)

Tools are grouped by ADO area. Each tool validates inputs with `zod` and returns structured JSON. Destructive/creating tools are clearly named.

Organized by **domain** (the registration unit). Each tool validates inputs with `zod` and returns structured JSON. Destructive/creating tools are clearly named.

- **`core`**: `core_list_projects`, `core_list_teams`
- **`work`** (boards/iterations/sprints): `work_list_iterations`, `work_list_backlog`, `work_get_capacity`
- **`work-items`**: `wit_query` (WIQL), `wit_get`, `wit_create`, `wit_update`, `wit_add_comment`, `wit_list_types`
- **`repositories`** (Git, incl. pull requests): `repo_list`, `repo_list_branches`, `repo_get_file`, `repo_list_items`, `repo_list_commits`, `repo_get_commit`, `pr_list`, `pr_get`, `pr_create`, `pr_add_comment`, `pr_update_status`, `pr_list_threads`
- **`pipelines`** (builds): `pipeline_list`, `pipeline_get`, `build_list`, `build_get`, `build_queue`, `build_get_logs`
- **`wiki`**: `wiki_list`, `wiki_get_page`, `wiki_create_or_update_page`
- **`test-plans`**: `testplan_list`, `testplan_list_suites`, `testplan_list_cases`

> Exact tool list is refined in the PLAN phase; this is the v1 commitment. Domains can be selectively enabled via `--domains`/`-d` (default: all).

## Commands

```
Install (offline):   npm ci
Build:               npm run build
Dev (stdio):         npm run dev
Lint:                npm run lint        # add --fix to autofix
Format:              npm run format
Test:                npm test
Test + coverage:     npm run test:coverage
Start (stdio):       node dist/index.js --stdio
Start (http):        node dist/index.js --http --port 3000
Select domains:      node dist/index.js --stdio -d core work-items repositories
Docker build:        docker build -t azure-devops-mcp:latest .
Docker run (http):   docker run -p 3000:3000 -e ADO_SERVER_URL=... -e ADO_API_VERSION=7.1 azure-devops-mcp:latest
```

CLI flags (parsed with `node:util` `parseArgs`): `--stdio` | `--http`, `--port <n>`, `--domains`/`-d <list>`, `--version`, `--help`.

## Project Structure

Mirrors the `microsoft/azure-devops-mcp` layout (domain modules + `tools.ts` orchestrator + `shared/domains.ts`), extended with our dual-transport and REST-client layers:

```
src/
  index.ts                → CLI entry; parseArgs (--stdio|--http, -d domains); starts transport
  server.ts               → builds McpServer (name/version/icons)
  tools.ts                → orchestrator: configureIfDomainEnabled(domain, fn) for each domain
  config.ts               → loads + validates config (env/CLI); zod schema
  context.ts              → per-request context (PAT, collection, api-version, project)
  logger.ts               → structured logging (never logs the PAT)
  version.ts              → packageVersion (generated from package.json at build)
  useragent.ts            → composes ADO User-Agent incl. MCP client info
  shared/
    domains.ts            → Domain enum + DomainsManager (filtering, default = all)
  transports/
    stdio.ts              → stdio transport wiring
    http.ts               → Streamable HTTP transport; /mcp endpoint; Origin/Host checks;
                            per-request X-ADO-PAT extraction; security headers
  azure/
    client.ts             → AzureDevOpsClient factory (base URL, collection, api-version, fetch, pagination)
    auth.ts               → raw PAT → Basic auth header (no logging/persistence)
    errors.ts             → maps ADO REST errors → MCP errors
  tools/
    core.ts  work.ts  work-items.ts  repositories.ts
    pipelines.ts  wiki.ts  test-plans.ts
  types/                  → shared TS types for ADO entities
tests/
  unit/                   → mocked-fetch unit tests (client + each domain)
  integration/            → optional, gated tests against a real ADO server
docs/
  setup-local-stdio.md    → per-dev install & client config (client-agnostic)
  setup-hosted-http.md    → Docker deploy on internal server (+ reverse-proxy TLS)
  configuration.md        → all config options
Dockerfile
SPEC.md  AGENTS.md  README.md
```

## Configuration

| Option | Env var | Local (stdio) | Hosted (HTTP) | Default |
|--------|---------|---------------|---------------|---------|
| ADO server base URL | `ADO_SERVER_URL` | required | required (server-side) | — |
| Collection | `ADO_COLLECTION` | optional | optional | `DefaultCollection` |
| PAT (raw) | `ADO_PAT` | required | **per-request `X-ADO-PAT` header**, not env | — |
| REST api-version | `ADO_API_VERSION` | optional | optional | `7.1` |
| Default project | `ADO_DEFAULT_PROJECT` | optional | optional (or per-request) | — |
| Enabled domains | `ADO_DOMAINS` (or `-d`) | optional | optional | all |
| HTTP port | `ADO_HTTP_PORT` | n/a | optional | `3000` |
| Allowed Origins (allowlist) | `ADO_ALLOWED_ORIGINS` | n/a | optional | — |
| TLS cert / key paths (direct HTTPS) | `ADO_TLS_CERT` / `ADO_TLS_KEY` | n/a | optional | — (proxy terminates TLS) |
| Default page size | `ADO_PAGE_SIZE` | optional | optional | `50` |
| Max results cap | `ADO_MAX_RESULTS` | optional | optional | `200` |
| Request timeout (ms) | `ADO_TIMEOUT_MS` | optional | optional | `30000` |
| Log level | `ADO_LOG_LEVEL` | optional | optional | `info` |

- Hosted-mode per-user PAT header: **`X-ADO-PAT`** (raw PAT).
- The example base URL for on-prem looks like `https://<server>/tfs` with collection `DefaultCollection` (or `https://<server>` if collection is in the URL).

## Code Style

- TypeScript strict mode; ESM with `.js` import specifiers. Named exports. `camelCase` functions/vars, `PascalCase` types, `kebab-case` filenames (matches official MCP).
- Every tool: `zod` input schema → typed handler → structured result. No `any`.
- Secrets (PAT) never logged, never put in error messages, never serialized.
- Domain modules export `configure<Domain>Tools(server, deps)` and register tools via `server.tool(...)`, following `microsoft/azure-devops-mcp`.

Example domain module (target style):

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "../context.js";

export function configureWorkItemTools(server: McpServer, deps: ToolDeps) {
  server.tool(
    "wit_get",
    "Get a single work item by ID. Use when you need fields of a specific work item.",
    {
      id: z.number().int().positive(),
      fields: z.array(z.string()).optional(),
    },
    async ({ id, fields }, extra) => {
      const client = await deps.clientFor(extra); // per-request PAT/context
      const wi = await client.get(`/_apis/wit/workitems/${id}`, {
        fields: fields?.join(","),
      });
      return { content: [{ type: "text", text: JSON.stringify(wi, null, 2) }] };
    },
  );
}
```

## Testing Strategy

- **Framework:** `vitest`. Test pyramid ≈ 80% unit / 15% integration / 5% e2e.
- **Unit:** mock `fetch`; cover the REST client (URL/api-version/auth header building, pagination, error mapping) and each tool's input validation + request shaping. **Assert PAT is never logged.**
- **Integration (gated):** optional suite hitting a real ADO server, enabled only when `ADO_TEST_SERVER_URL` + `ADO_TEST_PAT` are set; skipped by default (offline/CI-safe).
- **Coverage target:** ≥ 80% lines on `src/azure` and `src/tools`.
- TDD per the `test-driven-development` skill: failing test → implement → green.

## Boundaries

- **Always:**
  - Validate every tool input with `zod`.
  - Treat the PAT as a secret — never log, echo, persist, or include it in errors.
  - Keep the only outbound network destination the configured ADO server.
  - Run lint + tests before commits; keep changes in small vertical slices.
- **Ask first:**
  - Adding any new npm dependency (must be justifiable + available/added to internal registry).
  - Adding write/destructive tools beyond the v1 list.
  - Changing the transport/auth model or the per-request PAT mechanism.
  - Introducing any persistence/caching of ADO data or credentials.
- **Never:**
  - Commit secrets, PATs, or real server URLs.
  - Make calls to any external/internet host.
  - Store or cache user PATs server-side in hosted mode.
  - Remove or skip failing tests without approval.

## Success Criteria (testable)

1. `npm ci && npm run build` succeeds offline (deps from internal registry) on Windows, macOS, Linux.
2. `node dist/index.js --stdio` registers all v1 tools and responds to an MCP `tools/list`.
3. `node dist/index.js --http` serves the Streamable HTTP transport; a request with a per-user PAT header performs a real ADO call; a request without one is rejected.
4. The REST client targets `${ADO_SERVER_URL}/<project>/_apis/...?api-version=${ADO_API_VERSION}` with `7.1` default and honors overrides.
5. Unit suite passes with ≥ 80% coverage on `src/azure` + `src/tools`, including a test proving the PAT is never logged.
6. A Docker image builds and runs the HTTP server; documented in `docs/setup-hosted-http.md`.
7. Client-agnostic setup docs exist for at least stdio and HTTP.

## Resolved Decisions

These were open questions, resolved per MCP-spec best practice and how official/peer ADO MCP servers behave:

1. **Hosted PAT header → `X-ADO-PAT`** (raw PAT). Rationale: the MCP `Authorization` header is reserved for MCP-level OAuth/gateway authorization; a custom header keeps that layer free and is unambiguous. Server converts to ADO `Authorization: Basic base64(":"+PAT)`, matching the official MS MCP `pat` mode. *(Source: MCP transports spec 2025-11-25; microsoft/azure-devops-mcp PAT support.)*
2. **Hosted TLS/authz → TLS terminated by an internal reverse proxy** (recommended) with container on internal HTTP; optional direct HTTPS via `ADO_TLS_CERT`/`ADO_TLS_KEY`. Mandatory `Origin`/`Host` validation (403), `127.0.0.1` binding for local, HSTS + security headers. *(Source: MCP transports spec security warning; MCP Security Checklist 2026.)*
3. **api-version → configurable, default `7.1`.**
4. **Pagination → default page size `50`, hard cap `200`** (`ADO_PAGE_SIZE` / `ADO_MAX_RESULTS`), continuation via the relevant ADO mechanism (`$top`/`$skip` or `continuationToken`) per endpoint. WIQL results capped at `ADO_MAX_RESULTS`.
5. **v1 write scope → included** (create/update work items, create PRs + comments + status, create/update wiki pages, queue builds).
6. **Distribution names (placeholders — rename to your conventions):**
   - npm package: `@corp/azure-devops-mcp` (replace `@corp` with the real internal scope)
   - Docker image: `azure-devops-mcp:<version>`, pushed to `<internal-registry>/azure-devops-mcp`

## Remaining Open Questions

- **npm scope + Docker registry path** — confirm the real internal package scope and Docker registry path to replace the placeholders above.
- **Reverse proxy** — confirm there is an internal reverse proxy available for TLS termination in front of the hosted container (vs. needing the container to serve HTTPS directly).
```
