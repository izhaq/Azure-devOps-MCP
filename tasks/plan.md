# Implementation Plan: Azure DevOps MCP Server (On-Prem)

> Derived from `SPEC.md`. Status: **DRAFT — awaiting human approval** (Phase 2 / PLAN of spec → plan → tasks → implement).
> No code is written during planning.

## Overview

Build a cross-platform, offline-friendly MCP server that exposes on-prem Azure DevOps Server via the REST APIs, with **dual transport** (stdio + Streamable HTTP), **per-user PAT** auth, and **domain-based tool modules** mirroring `microsoft/azure-devops-mcp`. We build a working **walking skeleton** first (stdio + `core` domain hitting a real ADO server), then add the HTTP transport, then fan out the remaining domains, then package (npm + Docker) and document.

## Architecture Decisions (from spec)

- **TypeScript ESM, Node ≥ 20** (newer supported); native `fetch`; `node:util parseArgs`; `zod`; `vitest`.
- **REST-direct client** (not `azure-devops-node-api`) for full on-prem `api-version` control + minimal offline deps.
- **Domain modules** (`src/tools/<domain>.ts` → `configure<Domain>Tools(server, deps)`) + `tools.ts` orchestrator (`configureIfDomainEnabled`) + `shared/domains.ts` (`Domain` enum + `DomainsManager`), `--domains`/`-d` filter (default all).
- **Per-user PAT**: local from env; hosted from per-request `X-ADO-PAT` header (never stored/logged) → server builds ADO `Authorization: Basic base64(":"+PAT)`.
- **HTTP security** per MCP spec: single `/mcp` (POST+GET), `Origin`/`Host` allowlist → 403, localhost/internal binding, TLS via reverse proxy (recommended), HSTS + `nosniff` + `DENY`, 401 when PAT header missing.

## Dependency Graph

```
Scaffolding/tooling (T1)
   │
   ├── config + logger + version (T2)
   │        │
   │        └── Azure REST client + auth + errors (T3)
   │                 │
   │                 └── request context / ToolDeps (T4)
   │                          │
   │   server + domains + orchestrator + CLI + stdio (T5)
   │                          │
   │                          └── core domain  →  WALKING SKELETON (T6)
   │                                   │
   │                 ┌─────────────────┼─────────────── HTTP transport + security (T7)
   │                 │                 │
   │   domains (parallel after T6): work-items (T8), repos (T9), pull-requests (T10),
   │   pipelines (T11), work/boards (T12), wiki (T13), test-plans (T14)
   │                 │
   └── packaging (npm T15, Docker T16), docs (T17), CI matrix (T18)
```

Build foundation bottom-up; each task leaves the system green.

## Task List

### Phase 1 — Foundation

#### Task 1: Project scaffolding & tooling
**Description:** Initialize the TypeScript/ESM project with build, lint, format, and test tooling so every later task can build and test.
**Acceptance criteria:**
- [ ] `package.json` with `"type": "module"`, `engines.node: ">=20"`, `bin.mcp-server-azuredevops: dist/index.js`, `files: ["dist"]`, scripts (build/dev/lint/format/test/test:coverage).
- [ ] `tsconfig.json` strict + ESM; build (`tsup` or `tsc`) emits `dist/`.
- [ ] ESLint + Prettier + `vitest` configured; `.gitignore`, `.env.example`.
**Verification:**
- [ ] `npm ci` succeeds; `npm run build` emits `dist/`; `npm run lint` and `npm test` run (no tests yet) with exit 0.
**Dependencies:** None
**Files:** `package.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`, `vitest.config.ts`, `.gitignore`, `.env.example`
**Scope:** M

#### Task 2: Config, logging, version
**Description:** Centralized configuration (env + CLI), a logger that redacts secrets, and a generated version module.
**Acceptance criteria:**
- [ ] `config.ts` zod schema for all options in spec (server URL, collection, api-version, project, domains, port, origins, TLS paths, page size/cap, timeout, log level) with defaults; invalid config throws a clear error.
- [ ] `logger.ts` never emits the PAT (redaction enforced and unit-tested).
- [ ] `version.ts` exposes `packageVersion` (generated from `package.json` at build).
**Verification:**
- [ ] Unit tests: valid/invalid config; logger redaction; defaults applied.
**Dependencies:** T1
**Files:** `src/config.ts`, `src/logger.ts`, `src/version.ts`, `tests/unit/config.test.ts`, `tests/unit/logger.test.ts`
**Scope:** M

### Checkpoint: Foundation (after T1–T2)
- [ ] Build, lint, tests pass clean
- [ ] Config validation + secret redaction proven by tests

### Phase 2 — Walking Skeleton (stdio + core)

#### Task 3: Azure DevOps REST client + auth + errors
**Description:** The REST wrapper: URL building (`{base}/{collection}/{project}/_apis/...?api-version=`), PAT→Basic header, `fetch` with timeout, pagination, query params, and ADO error mapping.
**Acceptance criteria:**
- [ ] `auth.ts` builds `Authorization: Basic base64(":"+PAT)` from a raw PAT; PAT never logged.
- [ ] `client.ts` builds correct URLs honoring collection/project/`api-version` (default `7.1`); applies timeout; supports `$top`/`$skip`/continuation; enforces `ADO_MAX_RESULTS`.
- [ ] `errors.ts` maps ADO REST error payloads/status to clear MCP errors.
**Verification:**
- [ ] Unit tests (mocked `fetch`): URL/api-version/auth header correctness, pagination, error mapping, **PAT-never-logged** assertion.
**Dependencies:** T2
**Files:** `src/azure/auth.ts`, `src/azure/client.ts`, `src/azure/errors.ts`, `tests/unit/azure-client.test.ts`
**Scope:** M

#### Task 4: Request context & tool dependencies
**Description:** A `RequestContext` (pat, collection, apiVersion, project) and `ToolDeps.clientFor(extra)` that produces a client per request — config-sourced in stdio, header-sourced in HTTP.
**Acceptance criteria:**
- [ ] `clientFor` returns a configured client; stdio path uses env config.
- [ ] Abstraction allows HTTP to inject per-request PAT (T7) without changing tools.
**Verification:**
- [ ] Unit test: context resolves a client with expected base URL/auth.
**Dependencies:** T3
**Files:** `src/context.ts`, `tests/unit/context.test.ts`
**Scope:** S

#### Task 5: MCP server, domains, orchestrator, CLI, stdio transport
**Description:** Assemble the server skeleton: `McpServer`, `Domain` enum + `DomainsManager` (parse/filter, default all), `tools.ts` orchestrator, `index.ts` CLI (`parseArgs`), and the stdio transport.
**Acceptance criteria:**
- [ ] `index.ts` parses `--stdio|--http`, `--port`, `--domains`/`-d`, `--version`, `--help`.
- [ ] `DomainsManager` enables all by default; `-d core` restricts to selected.
- [ ] `node dist/index.js --stdio` starts and answers `tools/list`.
**Verification:**
- [ ] Unit tests: domain parsing/filtering; CLI arg parsing.
- [ ] Manual: stdio server lists tools (empty/core placeholder).
**Dependencies:** T4
**Files:** `src/server.ts`, `src/shared/domains.ts`, `src/tools.ts`, `src/index.ts`, `src/transports/stdio.ts`
**Scope:** M

#### Task 6: `core` domain — complete vertical slice
**Description:** First real tools end-to-end: `core_list_projects`, `core_list_teams`, wired through the orchestrator.
**Acceptance criteria:**
- [ ] Tools registered under the `core` domain with zod schemas.
- [ ] Over stdio, `core_list_projects` returns real projects from a target ADO server.
**Verification:**
- [ ] Unit tests with mocked client.
- [ ] Manual: real `core_list_projects` call succeeds against the on-prem server.
**Dependencies:** T5
**Files:** `src/tools/core.ts`, `src/tools.ts` (wiring), `tests/unit/core-tools.test.ts`
**Scope:** S

### Checkpoint: Walking Skeleton (after T3–T6) — HIGH-RISK GATE
- [ ] All tests pass, build clean
- [ ] **stdio server makes a real authenticated ADO call** (validates auth header + api-version + connectivity early)
- [ ] Review with human before proceeding

### Phase 3 — HTTP Transport

#### Task 7: Streamable HTTP transport + security + per-request PAT
**Description:** Add the hosted transport with the MCP-spec security model and per-request PAT plumbing.
**Acceptance criteria:**
- [ ] Single `/mcp` endpoint (POST+GET), `Mcp-Session-Id`, honors `MCP-Protocol-Version`.
- [ ] `Origin`/`Host` validated against allowlist → 403; security headers (HSTS, `nosniff`, `DENY`) on all responses.
- [ ] `X-ADO-PAT` extracted per request → context; missing PAT → 401.
- [ ] Binds to internal interface; `--http --port` works.
**Verification:**
- [ ] Tests: 403 on bad Origin, 401 on missing PAT, happy path `tools/list` + a `core` call.
- [ ] Manual: both transports serve `core` tools.
**Dependencies:** T6
**Files:** `src/transports/http.ts`, `src/index.ts` (wire), `tests/unit/http-transport.test.ts`
**Scope:** M

### Checkpoint: Dual Transport (after T7)
- [ ] Both stdio and HTTP serve `core` tools
- [ ] Security behaviors (403/401) verified by tests

### Phase 4 — Domain Expansion (T8–T14 parallelizable after T6)

#### Task 8: `work-items` domain
**Acceptance:** `wit_query` (WIQL), `wit_get`, `wit_create`, `wit_update`, `wit_add_comment`, `wit_list_types` with zod schemas + unit tests.
**Verify:** unit tests (mocked client) for each tool; manual create/update round-trip.
**Dependencies:** T6 · **Files:** `src/tools/work-items.ts`, test · **Scope:** M

#### Task 9: `repositories` domain — Git (read)
**Acceptance:** `repo_list`, `repo_list_branches`, `repo_get_file`, `repo_list_items`, `repo_list_commits`, `repo_get_commit`.
**Verify:** unit tests; manual file/commit fetch.
**Dependencies:** T6 · **Files:** `src/tools/repositories.ts`, test · **Scope:** M

#### Task 10: Pull requests (within `repositories`)
**Acceptance:** `pr_list`, `pr_get`, `pr_create`, `pr_add_comment`, `pr_update_status`, `pr_list_threads`.
**Verify:** unit tests; manual PR list + comment.
**Dependencies:** T9 · **Files:** `src/tools/repositories.ts` (extend), test · **Scope:** M

#### Task 11: `pipelines` domain
**Acceptance:** `pipeline_list`, `pipeline_get`, `build_list`, `build_get`, `build_queue`, `build_get_logs`.
**Verify:** unit tests; manual list + queue.
**Dependencies:** T6 · **Files:** `src/tools/pipelines.ts`, test · **Scope:** M

#### Task 12: `work` domain (boards/iterations)
**Acceptance:** `work_list_iterations`, `work_list_backlog`, `work_get_capacity`.
**Verify:** unit tests; manual iteration list.
**Dependencies:** T6 · **Files:** `src/tools/work.ts`, test · **Scope:** S

#### Task 13: `wiki` domain
**Acceptance:** `wiki_list`, `wiki_get_page`, `wiki_create_or_update_page`.
**Verify:** unit tests; manual page read/update.
**Dependencies:** T6 · **Files:** `src/tools/wiki.ts`, test · **Scope:** S

#### Task 14: `test-plans` domain
**Acceptance:** `testplan_list`, `testplan_list_suites`, `testplan_list_cases`.
**Verify:** unit tests; manual suite list.
**Dependencies:** T6 · **Files:** `src/tools/test-plans.ts`, test · **Scope:** S

### Checkpoint: All Domains (after T8–T14)
- [ ] All v1 tools registered and listed
- [ ] Coverage ≥ 80% on `src/azure` + `src/tools`
- [ ] Domain filtering (`-d`) verified

### Phase 5 — Packaging, Docs, CI

#### Task 15: npm packaging
**Acceptance:** `bin`/`files`/prepublish correct; `npm pack` yields a clean installable artifact; internal-registry install notes.
**Verify:** `npm pack` + install the tarball in a temp dir and run `--stdio`.
**Dependencies:** T7, all domains · **Files:** `package.json`, `.npmignore` · **Scope:** S

#### Task 16: Dockerfile + hosted deploy
**Acceptance:** Multi-stage Dockerfile runs `--http`; `docs/setup-hosted-http.md` with reverse-proxy TLS example + env config.
**Verify:** `docker build` + `docker run` serves `/mcp`; 403/401 checks hold behind it.
**Dependencies:** T7 · **Files:** `Dockerfile`, `.dockerignore`, `docs/setup-hosted-http.md` · **Scope:** M

#### Task 17: Documentation
**Acceptance:** `docs/configuration.md` (all options), `docs/setup-local-stdio.md` (client-agnostic `mcp.json` examples for Tabnine/Copilot/Cursor/etc.), updated `README.md`.
**Verify:** docs reviewed; sample configs match real flags/env.
**Dependencies:** T6 (can start), finalize after T16 · **Files:** `docs/*.md`, `README.md` · **Scope:** M

#### Task 18: Cross-platform CI
**Acceptance:** CI matrix Windows/macOS/Linux × Node 20 + current LTS; gates lint + build + test + coverage.
**Verify:** CI green on all matrix legs.
**Dependencies:** T1 (extend later) · **Files:** `.github/workflows/ci.yml` (or internal CI) · **Scope:** M

### Checkpoint: Complete
- [ ] All acceptance criteria met; success criteria in `SPEC.md` satisfied
- [ ] Cross-platform CI green; npm + Docker artifacts produced
- [ ] Ready for review

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Per-request PAT plumbing through MCP SDK HTTP transport (header access in tool handler) | High | Spike in T7; if the SDK doesn't surface request headers to handlers, bind PAT to the session at initialize or wrap the HTTP handler to inject context. Validate before fanning out domains. |
| On-prem `api-version` mismatch vs target server | High | `api-version` configurable; validate with a real call at the T3–T6 checkpoint (fail fast). |
| PAT/auth header format wrong for on-prem | High | Unit-tested in T3; real call at Walking-Skeleton checkpoint. |
| Offline: dep not mirrored in internal npm registry | Med | Keep deps minimal (sdk, zod + dev tools); confirm availability during T1. |
| MCP SDK API drift between versions | Med | Pin the SDK version; isolate SDK usage in `server.ts`/transports. |
| Large result sets flood agent context | Med | Enforce `ADO_PAGE_SIZE`/`ADO_MAX_RESULTS` in the client (T3) + per-tool defaults. |

## Parallelization

- **Sequential (foundation/contract):** T1 → T2 → T3 → T4 → T5 → T6, then T7.
- **Parallel after T6:** domains T8, T9(+T10), T11, T12, T13, T14 — independent files sharing the client + registration contract.
- **Parallel-ish:** T17 docs can start after T6; T18 CI after T1.

## Open Questions (carried from spec / surfaced in planning)

- **SDK per-request header access** for `X-ADO-PAT` (drives T7 design) — needs a short spike.
- Internal **npm scope** + **Docker registry path** (placeholders for now).
- Availability of an **internal reverse proxy** for TLS termination.
