# Batch 3 Task List

Branch: `fix/weak-llm-audit-batch3` (from `main` after PR #26 merged)
Spec: `docs/weak-llm-audit-batch3-spec.md`
Plan: `tasks/weak-llm-audit-batch3-plan.md`

## Phase 1 — Response Slimming

- [ ] T1: `src/tools/pipelines.ts` — `pipeline_get`
  - Add `includeConfiguration: z.boolean().optional()` param
  - Update description
  - Slim handler: return `{id,name,folder,revision,configuration:{type,path,repository:{id,type,name}}}` by default; full object when `includeConfiguration=true`
  - Acceptance: `slim["configuration"]` does NOT have `variables` or `triggers`; `includeConfiguration=true` DOES have them
  - Verify: new test in `tests/unit/pipelines-tools.test.ts` passes

- [ ] T2: `src/tools/pipelines.ts` — `build_queue`
  - Update description to mention slim return shape
  - Slim handler: extract `{id, buildNumber, status, queueTime, definition:{id,name}}`
  - Acceptance: result does NOT have `orchestrationPlan` or `validationResults`
  - Verify: new test in `tests/unit/pipelines-tools.test.ts` passes

- [ ] T3: `src/tools/work.ts` — `work_list_iterations`
  - Slim handler: map each iteration to `{id, name, path, startDate, finishDate, timeFrame}`; flatten `attributes` sub-object; truncate dates to `YYYY-MM-DD`
  - Acceptance: result item has NO `url`, NO `attributes`; `startDate` is `"2024-01-01"` not `"2024-01-01T00:00:00Z"`
  - Verify: new test in `tests/unit/work-tools.test.ts` passes

- [ ] T4: `src/tools/work-items.ts` — `wit_add_comment`
  - Remove `STRIP_COMMENT_KEYS` allowlist loop
  - Replace with `asCleanText({ id, workItemId, createdDate })`
  - Acceptance: result has exactly 3 keys: `id`, `workItemId`, `createdDate`
  - Verify: new test in `tests/unit/work-items-tools.test.ts` passes

### Checkpoint 1

- [ ] `npm test` — all tests green
- [ ] `npm run build` — clean

## Phase 2 — New Tool + Param

- [ ] T5: `src/tools/work-items.ts` — add `wit_search` tool
  - Add to end of `configureWorkItemsTools`
  - Reuses `buildWorkItemQuery`, `LIST_FIELDS`, `asTicketList`, `boundLimit` already in scope
  - `mine: false`, `allStates: false` (open only by default), `titleContains: text`
  - Falls back to `deps.config.defaultProject`
  - Add `"wit_search"` to the `TOOLS` array in `tests/unit/work-items-tools.test.ts`
  - Acceptance: WIQL body does NOT contain `@Me`; result contains matching titles; project fallback works
  - Verify: 2 new tests in `tests/unit/work-items-tools.test.ts` pass

- [ ] T6: `src/tools/repositories.ts` — `pr_list` sourceBranch param
  - Add `sourceBranch: z.string().min(1).optional()` to inputSchema
  - Add `"searchCriteria.sourceRefName": sourceBranch ? toRefName(sourceBranch) : undefined` to query
  - Acceptance: URL contains `sourceRefName=refs%2Fheads%2Ffeature%2Fx`
  - Verify: 1 new test in `tests/unit/pull-requests-tools.test.ts` passes

### Checkpoint 2

- [ ] `npm test` — all tests green

## Phase 3 — Description Fixes

- [ ] T7a: `src/tools/work-items.ts` — `wit_get` description
  - Add: "Pass 'fields' for a specific field projection OR 'expand' for related data — they are mutually exclusive (ADO rejects both together)."
  - Verify: `npm test` still green (no test change needed)

- [ ] T7b: `src/tools/core.ts` — `core_list_projects` description
  - Add: "Returns {id, name, description, state}. Use the 'name' as the 'project' parameter in all other tools."
  - Verify: `npm test` still green

- [ ] T7c: `src/tools/core.ts` — `core_list_teams` description
  - Add: "Returns {id, name, description, projectName}. Use the 'name' as the 'team' parameter in work_list_iterations, work_list_backlog_levels, and work_get_capacity."
  - Verify: `npm test` still green

### Checkpoint 3 — Final

- [ ] `npm test` — all tests green
- [ ] `npm run build` — clean
- [ ] Commit: `fix: weak-llm audit batch 3 — slim pipeline_get/build_queue/iterations/comment; add wit_search and pr_list sourceBranch`
- [ ] Push and open PR against `main`
