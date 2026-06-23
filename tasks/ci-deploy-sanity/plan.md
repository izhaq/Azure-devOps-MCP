# Implementation Plan: Agent-driven Deploy + Sanity

> Phase 2 (PLAN) of spec → plan → tasks → implement. **Not yet approved.**
> Spec: `tasks/ci-deploy-sanity/spec.md` (SPECIFY gate passed; decisions locked).

## Approach

Add a new **`deploy` domain** (`src/tools/deploy.ts`) with four task-level tools
that compose the existing Build primitives. A separate domain (not folded into
`pipelines`) so teams that shouldn't deploy can disable it via `ADO_DOMAINS`.
The tools call the REST API directly through `AzureDevOpsClient` (same pattern
as `pipelines.ts`); the only genuinely new logic is (a) dependency-free parsing
of the env list from pipeline YAML and (b) finding the failed leaf step in the
build timeline. Everything else is config + glue.

## Components & dependencies

| # | Component | Files | Depends on |
|---|-----------|-------|------------|
| A | Config keys | `src/config.ts`, `.env.example`, `tests/unit/config.test.ts` | — |
| B | `deploy` domain enum + gating | `src/shared/domains.ts`, `src/tools.ts` | — |
| C | Env-YAML value parser (pure) | `src/shared/pipeline-params.ts`, `tests/unit/pipeline-params.test.ts` | — |
| D | `list_deploy_envs` | `src/tools/deploy.ts`, tests | A, B, C, `pipeline_get`+`repo_get_file` |
| E | `deploy_feature_branch` + `run_sanity` | `src/tools/deploy.ts`, tests | A, B, D (env validation) |
| F | `pipeline_run_status` (timeline + log tail) | `src/tools/deploy.ts`, tests | A, B |
| G | Docs + bundle | `README.md`, `docs/configuration.md`, `dist/index.js` | D–F |

A, B, C are mutually independent and can land first/in parallel. D needs C
(parser) and the env validation helper that E reuses. F is independent of D/E
(only needs config + client). G is last.

## Implementation order

1. **A — Config** (`ADO_DEPLOY_PIPELINE_ID`, `ADO_SANITY_PIPELINE_ID`,
   `ADO_DEPLOY_ENV_PARAM` default `"env"`, `ADO_DEPLOY_ENVS` optional list,
   `ADO_DEPLOY_PROJECT` optional). Add to `ServerConfig` + `.env.example` + a
   `config.test.ts` case. Validation: numeric pipeline ids, optional list parse.
2. **C — Parser** `parseParameterValues(yaml: string, paramName: string): string[]`.
   Handles the two YAML forms the dropdown uses: inline `values: [a, b]` and
   block `values:\n  - a\n  - b`, scoped to the matching `- name: <paramName>`
   entry. Returns `[]` when not found (→ caller falls back to config). Pure,
   heavily unit-tested with real-shaped fixtures.
3. **B — Domain** add `Domain.DEPLOY` + default-domains entry + `whenEnabled`
   wiring for `configureDeployTools`.
4. **D — `list_deploy_envs`** resolution: `ADO_DEPLOY_ENVS` if set
   (`source:"config"`) → else `pipeline_get(deployId)` →
   `configuration.path`+`configuration.repository` → `repo_get_file` (default
   branch) → `parseParameterValues` (`source:"pipeline-yaml"`) → else
   `source:"none"` + "set ADO_DEPLOY_ENVS" message. Extract a shared
   `resolveEnvs(client, deps)` used by E for validation.
5. **E — triggers** `deploy_feature_branch` (require `confirm:true`; validate
   `env` via `resolveEnvs`; `POST /_apis/build/builds` with `{definition:{id},
   sourceBranch: toRefName(branch), templateParameters:{[param]:env}}`) and
   `run_sanity` (validate `env`; queue sanity definition, env-only). Both return
   `{ runId, buildNumber, status, env, branch?, webUrl }`.
6. **F — `pipeline_run_status`** `build_get` → map `status`/`result` to
   `running|succeeded|failed`. On failed: `GET /_apis/build/builds/{id}/timeline`
   → last `type:"Task"` record with `result:"failed"` and a `log.id` →
   `build_get_logs`-style fetch of the tail (last ~100 lines), byte-capped via
   the shared guard. Return `{ status, result, webUrl, failedStep?, logTail? }`.
7. **G — Docs + bundle** README tool table + `docs/configuration.md` entries;
   `npm run build`; commit `dist/index.js`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Dependency-free YAML parse misses exotic formatting | `ADO_DEPLOY_ENVS` config override is the reliable source; parser returns `[]` → clean fallback + message; fixtures cover inline & block forms |
| YAML lives on a non-default branch / `repo_get_file` needs a ref | Read from repo default branch (omit ref); document that `ADO_DEPLOY_ENVS` covers any discovery miss |
| Build **timeline** record shape varies (Task vs Job vs Stage; missing `log.id`) | Prefer last failed `Task` with `log.id`; fall back to any failed record with a log; if none, return overall `result` + a "see web build" message with `webUrl` |
| Weak LLM forgets `confirm:true` | Tool rejects without it and returns a one-line instruction naming the flag; description states it deploys to a shared env |
| Duplicated queue-body shape vs `pipelines.ts` `build_queue` | Acceptable (each tool calls the client directly); if it grows, extract a `queueBuild()` client helper later — not now |
| `templateParameters` rejected if the pipeline lacks a runtime `env` param | Surface the ADO error verbatim; `ADO_DEPLOY_ENV_PARAM` lets the operator match the real param name |
| **Live-only unknowns** (real definition ids, exact env param name, timeline/log behaviour on-prem) | Captured in a live-verify checklist in `todo.md`; cannot be exercised from CI/cloud |

## Verification checkpoints

- After **A/B/C**: `npm run typecheck && npm run lint && npm test` green; parser
  unit tests cover inline/block/not-found.
- After **D/E/F**: `deploy-tools.test.ts` at the `fetchImpl` seam asserts —
  env resolution (config + routed YAML + none); queue bodies (definition id,
  `sourceBranch`, `templateParameters`); `confirm` rejection; env-validation
  rejection with the valid list; status mapping; failed-path timeline→log-tail.
  MCP `tools/list` shows the four tools under the `deploy` domain.
- After **G**: `npm run test:coverage` meets thresholds; `dist/index.js` rebuilt
  and contains the new tools.
- **Live (human, on-prem)** — `todo.md`: real deploy to a test env, sanity run,
  and a deliberately failing run to confirm the curated log tail.

## Parallelization

- Parallel first wave: **A**, **B**, **C** (independent).
- Then **D** (needs C); **F** can proceed alongside D (independent).
- **E** after D (reuses `resolveEnvs`). **G** last.

## Task breakdown (preview — full TASKS phase is the next gate)

1. Config keys + tests (A)
2. `Domain.DEPLOY` + registration (B)
3. `parseParameterValues` + tests (C)
4. `list_deploy_envs` + `resolveEnvs` helper + tests (D)
5. `deploy_feature_branch` + `run_sanity` + tests (E)
6. `pipeline_run_status` + tests (F)
7. Docs + bundle rebuild (G)
8. Live-verify checklist in `todo.md`
