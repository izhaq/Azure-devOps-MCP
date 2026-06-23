# Spec: Agent-driven Deploy + Sanity for Feature Branches

> Phase 1 (SPECIFY) of spec → plan → tasks → implement. **Not yet approved.**
> Intent source: `docs/intent/ci-deploy-sanity.md` (confirmed via interview).
> Grounded in the existing `pipelines` domain (`src/tools/pipelines.ts`).

## Assumptions I'm making

1. The deploy and sanity pipelines are **classic Build definitions** reachable via
   the existing Build API (`/_apis/build/builds`), so `build_queue` —
   which already supports `definitionId` + `sourceBranch` + `templateParameters`
   — is the trigger primitive. (Not the newer `/_apis/pipelines/{id}/runs` API.)
2. The env is a **YAML runtime template parameter** (default name `env`) passed
   in `templateParameters`, exactly what the web dropdown sets.
3. Build status comes from `build_get` (`status` + `result`); the **failing step**
   is found via the build **timeline** (`/_apis/build/builds/{id}/timeline`),
   whose records carry `result` and a `log.id`.
4. Env discovery reads the deploy pipeline's YAML via `pipeline_get` →
   `configuration.path` + `configuration.repository`, then the existing
   `repo_get_file`, then parses the named parameter's `values:` list.
5. Org-specifics (pipeline IDs, env param name, optional static env list) are
   **config**; tools are added to **this** server (new `deploy` domain).
6. The weak agent **offers** envs and the **human chooses**; the AI never
   auto-selects. Deploys target **shared** team envs.
→ Correct me now or I'll proceed with these.

## Objective

Let a developer drive, through the weak agent, today's manual ADO-web-UI steps:
deploy a feature branch onto a chosen shared env, then run a sanity check on
that env — and inspect the result. Four task-level tools compose the existing
pipeline primitives so the model never authors pipeline calls, never polls in a
loop, and never receives a full log dump.

**User:** a dev using Tabnine CLI (weak LLM, weak harness, air-gapped).
**Success:** see Success Criteria.

## Tech Stack

Unchanged: TypeScript/Node ≥ 20, `@modelcontextprotocol/sdk`, `zod`, built-in
`fetch` (`node-https-fetch`). REST against on-prem ADO Server, api-version 7.1,
PAT via Basic. New tools reuse `AzureDevOpsClient`, `_shared` formatters
(`asCleanText`, `textResult`, byte-guard), and `clientFor(patFromExtra(extra))`.
**No new runtime dependency is planned** (see Open Question 1 re: YAML parsing).

## Commands

```
Build:  npm run build         # tsup → dist/index.js (committed; rebuild after changes)
Test:   npm test              # vitest run
Cover:  npm run test:coverage # thresholds: 80% lines/stmts/funcs, 70% branches
Lint:   npm run lint          # eslint .
Types:  npm run typecheck     # tsc --noEmit
```

## Project Structure

```
src/tools/deploy.ts        → NEW domain: the four tools below
src/tools/pipelines.ts     → existing build_queue / build_get / build_get_logs (reused)
src/shared/                → reuse; add env-YAML parsing helper here if needed
src/config.ts              → NEW config keys (below)
src/tools.ts (or registry) → register configureDeployTools
tests/unit/deploy-tools.test.ts → tests at the fetchImpl seam
docs/intent/ci-deploy-sanity.md → confirmed intent
```

## Tools (proposed)

1. **`list_deploy_envs({ project? })`** — returns `{ envs: string[], source }`
   where `source ∈ "config" | "pipeline-yaml" | "none"`. Resolution order:
   configured `ADO_DEPLOY_ENVS` if set → else read deploy pipeline YAML and parse
   the `<envParam>` `values:` → else `none` with a message telling the user to
   set `ADO_DEPLOY_ENVS`. For the agent to *offer*; cheap, read-only.

2. **`deploy_feature_branch({ branch, env, project? })`** — validate `env`
   against `list_deploy_envs`; on miss, reject with the valid list (shared-env
   safety). Then `build_queue(ADO_DEPLOY_PIPELINE_ID, sourceBranch=branch,
   templateParameters={ [envParam]: env })`. Returns a run handle:
   `{ runId, buildNumber, status, env, branch, webUrl }`.

3. **`run_sanity({ env, project? })`** — validate `env`; then
   `build_queue(ADO_SANITY_PIPELINE_ID, templateParameters={ [envParam]: env })`.
   Returns the same run-handle shape.

4. **`pipeline_run_status({ runId, project? })`** — `build_get` → map to
   `running | succeeded | failed`. On `failed`: fetch timeline, pick the failed
   record(s), fetch that log's **tail** via `build_get_logs` (startLine/endLine),
   return `{ status: "failed", failedStep, logTail }` byte-bounded. On success/
   running, return status + handle only (no logs).

## Config keys (new)

| Key | Required | Meaning |
|---|---|---|
| `ADO_DEPLOY_PIPELINE_ID` | for deploy | Build definition id of the deploy pipeline |
| `ADO_SANITY_PIPELINE_ID` | for sanity | Build definition id of the sanity pipeline |
| `ADO_DEPLOY_ENV_PARAM` | no (default `env`) | Template-parameter name carrying the env |
| `ADO_DEPLOY_ENVS` | no | Comma list of valid envs; overrides YAML discovery |
| `ADO_DEPLOY_PROJECT` | no | Project for deploy/sanity; falls back to `ADO_DEFAULT_PROJECT` |

A tool whose required config is unset returns a clear "not configured: set X"
message rather than failing obscurely.

## Code Style

Match `pipelines.ts`: `server.registerTool(name, { description, inputSchema }, handler)`,
inline zod, `asCleanText`/`textResult`, JSDoc citing the MS Learn endpoint. Example:

```ts
server.registerTool(
  "deploy_feature_branch",
  { description: "Deploy a feature branch onto a shared env by running the deploy pipeline …",
    inputSchema: {
      branch: z.string().min(1).describe("Feature branch to deploy (short name or full ref)"),
      env: z.string().min(1).describe("Target env; must be one returned by list_deploy_envs"),
      project: z.string().min(1).optional().describe("Project; falls back to ADO_DEPLOY_PROJECT/ADO_DEFAULT_PROJECT"),
    } },
  async ({ branch, env, project }, extra) => { /* validate env → build_queue → handle */ },
);
```

## Testing Strategy

vitest at the `fetchImpl` seam (see `tests/unit/pipelines-tools.test.ts` and the
URL-routed `routedSetup` pattern). Cover:
- `list_deploy_envs`: config path; YAML-discovery path (routed `repo_get_file`);
  fallback to `none` when neither resolves.
- `deploy_feature_branch` / `run_sanity`: correct `build_queue` body
  (definitionId, sourceBranch, templateParameters); env-validation rejection.
- `pipeline_run_status`: running/succeeded paths return no logs; failed path
  reads the timeline, picks the failed step, returns a byte-bounded log tail.
Keep coverage above the configured thresholds; rebuild the committed bundle.

## Boundaries

- **Always:** validate `env` against the offered list before queuing; keep the
  weak-LLM rules (compact output, byte-bounded logs, one call per action);
  reuse existing primitives and `_shared` helpers; clear "not configured" errors.
- **Ask first:** adding a runtime dependency (e.g. a YAML parser — Open Q1);
  using the newer Pipelines run API instead of `build_queue`; any change to an
  existing tool's input schema.
- **Never:** let the AI auto-pick an env; deploy to an env not in the resolved
  list; dump full pipeline logs into the model; block the call waiting for a run
  to finish.

## Success Criteria

- [ ] `list_deploy_envs` returns the real env list from config, and (when config
      is unset) from the deploy pipeline's YAML — with a clear `source`.
- [ ] `deploy_feature_branch` queues the deploy pipeline with the right branch +
      `env` parameter and returns a run handle in one call; an env not in the
      list is rejected with the valid options.
- [ ] `run_sanity` queues the sanity pipeline against `env` and returns a handle.
- [ ] `pipeline_run_status` reports running/succeeded/failed; on failure it
      returns only the failing step's log tail, byte-bounded (no full dump).
- [ ] No babysitting: triggers return immediately; status is a separate call.
- [ ] Unit tests pass at the `fetchImpl` seam; coverage thresholds met; bundle
      rebuilt and committed.
- [ ] Existing tools unchanged.

## Open Questions (to close before/within PLAN)

1. **YAML discovery robustness / dependency.** Parsing the `env` parameter's
   `values:` from pipeline YAML. Options: (a) dependency-free targeted extraction
   of the named parameter's `values:` block (brittle on exotic YAML, zero deps —
   **recommended** for the air-gapped bundle, with config as the reliable
   override); (b) add a small bundled YAML parser (needs dependency approval);
   (c) config-only, discovery dropped. Which?
2. **Run-handle shape / web URL.** Include `webUrl`
   (`{server}/{collection}/{project}/_build/results?buildId={id}`) so the human
   can click through? Assumed yes.
3. **Failure-log curation rule.** Which record when several fail (first vs last),
   and tail size — propose **last failed leaf step, last ~100 lines, capped at
   the existing inline byte budget**. OK?
4. **Shared-env safety.** Is strict env-validation enough, or should
   `deploy_feature_branch` require an explicit `confirm: true` (or rely on the
   harness's tool-approval prompt) given it overwrites a shared env?
5. **Does `run_sanity` need `branch`?** Assumed **env-only** (it tests whatever
   is deployed there). Confirm.
6. **Trigger API.** Use existing `build_queue` (Build API) vs the newer Pipelines
   run API? Assumed `build_queue` (already supports branch + templateParameters).
7. **Naming / domain.** New `deploy` domain with tools `list_deploy_envs`,
   `deploy_feature_branch`, `run_sanity`, `pipeline_run_status`. Names OK, or
   prefix all with `deploy_` / fold into `pipelines`?
