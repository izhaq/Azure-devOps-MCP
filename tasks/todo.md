# TODO: Azure DevOps MCP Server

Execution checklist derived from `tasks/plan.md`. Mark `- [x]` as completed. Respect dependency order; stop at checkpoints for review.

**Progress: T1–T13 done** (foundation, stdio + Streamable HTTP transports, `core` + `work-items` + `repositories` read + pull requests + `pipelines` + `work` + `wiki`). **Next: T14 (test-plans).** Checkpoints B & C (real on-prem call) still pending human verification.

## Phase 1 — Foundation
- [x] **T1** Project scaffolding & tooling (package.json/tsconfig/eslint/prettier/vitest/build) — *M, deps: none*
- [x] **T2** Config + logger (PAT redaction) + version — *M, deps: T1*
- [x] **Checkpoint A:** build/lint/tests clean; config validation + redaction proven

## Phase 2 — Walking Skeleton (stdio + core)
- [x] **T3** Azure REST client + auth (Basic PAT) + errors (+ mocked-fetch tests, PAT-never-logged) — *M, deps: T2*
- [x] **T4** Request context + `ToolDeps.clientFor` — *S, deps: T3*
- [x] **T5** MCP server + `shared/domains.ts` + `tools.ts` orchestrator + `index.ts` CLI + stdio transport — *M, deps: T4*
- [x] **T6** `core` domain (`core_list_projects`, `core_list_teams`) wired end-to-end — *S, deps: T5*
- [ ] **Checkpoint B (HIGH-RISK GATE):** real authenticated ADO call over stdio; human review

## Phase 3 — HTTP Transport
- [x] **T7** Streamable HTTP `/mcp` + Origin/Host→403 + security headers + `X-ADO-PAT`→context + 401 — *M, deps: T6*
- [ ] **Checkpoint C:** both transports serve `core`; 403/401 verified (unit/e2e tests green; manual hosted-mode smoke pending)

## Phase 4 — Domain Expansion (parallelizable after T6)
- [x] **T8** `work-items` (query/get/create/update/comment/types) — *M, deps: T6*
- [x] **T9** `repositories` Git read (list/branches/file/items/commits/commit) — *M, deps: T6*
- [x] **T10** Pull requests (list/get/create/comment/status/threads) — *M, deps: T9*
- [x] **T11** `pipelines` (pipelines + builds + queue + logs) — *M, deps: T6*
- [x] **T12** `work` boards/iterations (iterations/backlog/capacity) — *S, deps: T6*
- [x] **T13** `wiki` (list/get-page/create-or-update-page) — *S, deps: T6*
- [ ] **T14** `test-plans` (plans/suites/cases) — *S, deps: T6*
- [ ] **Checkpoint D:** all tools listed; coverage ≥80% on azure+tools; `-d` filtering works

## Phase 5 — Packaging, Docs, CI
- [ ] **T15** npm packaging (bin/files/prepublish; `npm pack` install test) — *S, deps: T7 + domains*
- [ ] **T16** Dockerfile + `docs/setup-hosted-http.md` (reverse-proxy TLS) — *M, deps: T7*
- [ ] **T17** Docs: `configuration.md`, `setup-local-stdio.md` (client-agnostic), README — *M, deps: T6*
- [ ] **T18** Cross-platform CI matrix (win/mac/linux × Node 20 + LTS) — *M, deps: T1*
- [ ] **Checkpoint E:** success criteria met; CI green; npm + Docker artifacts; ready for review

## Blockers / Notes
- Spike needed in **T7**: how the MCP SDK exposes per-request headers (`X-ADO-PAT`) to tool handlers.
- Placeholders to confirm: internal npm scope, Docker registry path, reverse proxy availability.
