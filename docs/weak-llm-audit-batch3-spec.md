# Weak-LLM Audit — Batch 3 Implementation Spec

## Context

**Prerequisite**: PR #26 (`fix/wiki-project-fallback-and-tree-depth`) must be merged to `main` before starting this branch.

**Branch**: `fix/weak-llm-audit-batch3` from `main` after PR #26 is merged.

Run `npm test && npm run build` before pushing. All existing tests must stay green; update tests that break due to response-shape changes and add new tests where noted.

**Available helpers** in `src/tools/_shared.ts`:
- `cleanAdo(value)` — strips `_links`, bare `url` fields, flattens ADO identity objects
- `asCleanText(data)` — `cleanAdo` + compact JSON + `textResult` wrapper
- `textResult(text)` — wraps plain string in MCP tool result shape
- `asPRList(prs, meta?)` — compact one-line-per-PR formatter
- `asTicketList(items, meta?)` — compact one-line-per-ticket formatter

**Available helpers** in `src/tools/work-items.ts` (internal, not re-exported):
- `formatWorkItemDetail(item)` — strips noise, truncates HTML, 50 KB guard
- `LIST_FIELDS` — minimal field projection for ticket list
- `boundLimit(top, max)` — from `../azure/client.js`
- `buildWorkItemQuery(opts)` — from `../shared/wiql.js`

---

## Files to Change

### 1. `src/tools/pipelines.ts`

#### Fix H1 — `pipeline_get`: slim default response, add `includeConfiguration` flag

**Problem**: Returns the full raw pipeline object. The `configuration` sub-object can include `variables`, `triggers`, and `queue` totalling 10–50 KB. The model only needs `id`, `name`, `folder`, `revision`, and a reference to the YAML path/repository to understand the pipeline.

**Change — add param to `pipeline_get` inputSchema**:
```ts
pipelineVersion: z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Pipeline revision to retrieve; defaults to the latest"),
includeConfiguration: z
  .boolean()
  .optional()
  .describe(
    "Include the full pipeline configuration (variables, triggers, queue). " +
    "Defaults to false — returns only id, name, folder, revision, and the " +
    "configuration type/path/repository reference.",
  ),
```

**Change — update `pipeline_get` description**:

Current:
```ts
description: "Get a single pipeline by id, including its configuration.",
```

Replace with:
```ts
description:
  "Get a single pipeline definition by id. Returns id, name, folder, revision, and the " +
  "configuration type/path/repository by default (safe for weak models). " +
  "Set includeConfiguration=true to include variables, triggers, and queue config.",
```

**Change — update `pipeline_get` handler**:

Current:
```ts
async ({ project, pipelineId, pipelineVersion }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));
  const query: Record<string, QueryValue> = { pipelineVersion };
  const pipeline = await client.get(`/_apis/pipelines/${pipelineId}`, { project, query });
  return asCleanText(pipeline);
},
```

Replace with:
```ts
async ({ project, pipelineId, pipelineVersion, includeConfiguration }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));
  const query: Record<string, QueryValue> = { pipelineVersion };
  const pipeline = await client.get<Record<string, unknown>>(
    `/_apis/pipelines/${pipelineId}`,
    { project, query },
  );
  if (includeConfiguration) return asCleanText(pipeline);
  const config = pipeline["configuration"] as Record<string, unknown> | undefined;
  const repo = config?.["repository"] as Record<string, unknown> | undefined;
  return asCleanText({
    id: pipeline["id"],
    name: pipeline["name"],
    folder: pipeline["folder"],
    revision: pipeline["revision"],
    configuration: config
      ? {
          type: config["type"],
          path: config["path"],
          repository: repo
            ? { id: repo["id"], type: repo["type"], name: repo["name"] }
            : undefined,
        }
      : undefined,
  });
},
```

**Test update needed** — existing `pipeline_get` tests only verify URL params; no existing assertion breaks. Add one new test in `tests/unit/pipelines-tools.test.ts`:

```ts
it("pipeline_get returns slim fields by default and full config when includeConfiguration=true", async () => {
  const fullPipeline = {
    id: 7,
    name: "ci-build",
    folder: "\\",
    revision: 3,
    configuration: {
      type: "yaml",
      path: "/azure-pipelines.yml",
      repository: { id: "repo-guid", type: "azureReposGit", name: "my-repo" },
      variables: { BIG: "lots of data" },
      triggers: [{ type: "continuous" }],
    },
  };
  const { tools } = setup(fullPipeline);

  // Default (slim)
  const slim = parseResult(
    await tools.get("pipeline_get")!({ project: "Proj", pipelineId: 7 }, {}),
  ) as Record<string, unknown>;
  expect(slim["id"]).toBe(7);
  expect(slim["name"]).toBe("ci-build");
  const cfg = slim["configuration"] as Record<string, unknown>;
  expect(cfg["type"]).toBe("yaml");
  expect(cfg["path"]).toBe("/azure-pipelines.yml");
  expect(cfg).not.toHaveProperty("variables");
  expect(cfg).not.toHaveProperty("triggers");

  // With includeConfiguration=true
  const full = parseResult(
    await tools.get("pipeline_get")!({ project: "Proj", pipelineId: 7, includeConfiguration: true }, {}),
  ) as Record<string, unknown>;
  const fullCfg = full["configuration"] as Record<string, unknown>;
  expect(fullCfg).toHaveProperty("variables");
  expect(fullCfg).toHaveProperty("triggers");
});
```

---

#### Fix H3 — `build_queue`: slim response

**Problem**: Returns the full queued-build object via `asCleanText(build)`. The model only needs the build `id` to call `build_get_logs`, plus `buildNumber`/`status`/`queueTime` for confirmation.

**Change — update `build_queue` description**:

Current:
```ts
description:
  "Queue (start) a new build for a pipeline definition. Optionally target a " +
  "source branch and pass YAML template parameters.",
```

Replace with:
```ts
description:
  "Queue (start) a new build for a pipeline definition. Optionally target a " +
  "source branch and pass YAML template parameters. " +
  "Returns {id, buildNumber, status, queueTime, definition} — use build_get_logs " +
  "with that buildId to follow progress.",
```

**Change — update `build_queue` handler**:

Current:
```ts
const build = await client.post("/_apis/build/builds", body, { project });
return asCleanText(build);
```

Replace with:
```ts
const build = await client.post<Record<string, unknown>>("/_apis/build/builds", body, { project });
const def = build["definition"] as Record<string, unknown> | undefined;
return asCleanText({
  id: build["id"],
  buildNumber: build["buildNumber"],
  status: build["status"],
  queueTime: build["queueTime"],
  definition: def ? { id: def["id"], name: def["name"] } : undefined,
});
```

**Test update needed** — existing `build_queue` tests only verify request body; no existing assertion breaks. Add one new test:

```ts
it("build_queue returns a slim confirmation object", async () => {
  const { tools } = setup({
    id: 42,
    buildNumber: "20240101.1",
    status: "notStarted",
    queueTime: "2024-01-01T00:00:00Z",
    definition: { id: 5, name: "ci-build" },
    orchestrationPlan: { planId: "guid" },
    validationResults: [],
  });
  const result = parseResult(
    await tools.get("build_queue")!({ project: "Proj", definitionId: 5 }, {}),
  ) as Record<string, unknown>;
  expect(result["id"]).toBe(42);
  expect(result["buildNumber"]).toBe("20240101.1");
  expect(result["status"]).toBe("notStarted");
  expect(result).not.toHaveProperty("orchestrationPlan");
  expect(result).not.toHaveProperty("validationResults");
  const def = result["definition"] as Record<string, unknown>;
  expect(def["name"]).toBe("ci-build");
});
```

---

### 2. `src/tools/work.ts`

#### Fix H2 — `work_list_iterations`: slim to essential fields

**Problem**: Returns raw ADO iteration objects via `asCleanText(...)`. Each object has many deep fields; after `cleanAdo`, there are still at least 5–8 fields per iteration and the `attributes` sub-object is not flattened. Slimming to `{id, name, path, startDate, finishDate, timeFrame}` reduces token count and makes the output uniform.

**Change — update `work_list_iterations` handler**:

Current (end of handler):
```ts
return asCleanText((result.value ?? []).slice(0, cap));
```

Replace with:
```ts
const slim = (result.value ?? []).slice(0, cap).map((i) => {
  const it = i as Record<string, unknown>;
  const attrs = (it["attributes"] as Record<string, unknown>) ?? {};
  return {
    id: it["id"],
    name: it["name"],
    path: it["path"],
    startDate: (attrs["startDate"] as string | undefined)?.slice(0, 10),
    finishDate: (attrs["finishDate"] as string | undefined)?.slice(0, 10),
    timeFrame: attrs["timeFrame"],
  };
});
return asCleanText(slim);
```

**Test update needed** — existing tests only check URL and result length (not field shape); no existing assertion breaks. Add one new test:

```ts
it("work_list_iterations slims to essential fields", async () => {
  const { tools } = setup({
    value: [
      {
        id: "guid-1",
        name: "Sprint 1",
        path: "Proj\\Sprint 1",
        url: "https://...",
        attributes: {
          startDate: "2024-01-01T00:00:00Z",
          finishDate: "2024-01-14T00:00:00Z",
          timeFrame: "past",
        },
      },
    ],
  });
  const iters = parseResult(
    await tools.get("work_list_iterations")!({ project: "Proj" }, {}),
  ) as Array<Record<string, unknown>>;
  expect(iters[0]).toEqual({
    id: "guid-1",
    name: "Sprint 1",
    path: "Proj\\Sprint 1",
    startDate: "2024-01-01",
    finishDate: "2024-01-14",
    timeFrame: "past",
  });
  expect(iters[0]).not.toHaveProperty("url");
  expect(iters[0]).not.toHaveProperty("attributes");
});
```

---

### 3. `src/tools/work-items.ts`

#### Fix H4 — `wit_add_comment`: slim to confirmation-only response

**Problem**: After stripping `renderedText/reactions/mentions/format`, the response still returns `text`, `createdBy`, `modifiedBy`, `modifiedDate`, `version`, `_links`, and more. The model just posted the comment — it only needs `{id, workItemId, createdDate}` to confirm success.

**Change — update `wit_add_comment` handler**:

Current (end of handler):
```ts
const STRIP_COMMENT_KEYS = new Set(["renderedText", "reactions", "mentions", "format"]);
const comment = (await client.post(
  `/_apis/wit/workItems/${id}/comments`,
  { text },
  { project, apiVersion: toPreviewVersion(deps.config.apiVersion, 3) },
)) as Record<string, unknown>;
const slim: Record<string, unknown> = {};
for (const [k, v] of Object.entries(comment)) {
  if (!STRIP_COMMENT_KEYS.has(k)) slim[k] = v;
}
return asCleanText(slim);
```

Replace with:
```ts
const comment = (await client.post(
  `/_apis/wit/workItems/${id}/comments`,
  { text },
  { project, apiVersion: toPreviewVersion(deps.config.apiVersion, 3) },
)) as Record<string, unknown>;
return asCleanText({
  id: comment["id"],
  workItemId: comment["workItemId"],
  createdDate: comment["createdDate"],
});
```

**Test update needed** — existing test only checks request URL and body; no existing assertion breaks. Add one new test:

```ts
it("wit_add_comment returns only id, workItemId, createdDate", async () => {
  const { tools } = setup({
    id: 55,
    workItemId: 100,
    createdDate: "2024-06-01T10:00:00Z",
    text: "hi",
    createdBy: { displayName: "Alice" },
    renderedText: "<p>hi</p>",
    reactions: [],
    _links: { self: { href: "..." } },
  });
  const result = parseResult(
    await tools.get("wit_add_comment")!({ project: "Proj", id: 100, text: "hi" }, {}),
  ) as Record<string, unknown>;
  expect(result).toEqual({
    id: 55,
    workItemId: 100,
    createdDate: "2024-06-01T10:00:00Z",
  });
  expect(result).not.toHaveProperty("text");
  expect(result).not.toHaveProperty("createdBy");
  expect(result).not.toHaveProperty("renderedText");
});
```

---

#### New Tool N1 — `wit_search`: text search across work items

**Problem**: Weak models can't write WIQL and `wit_list_my_work_items` defaults to "assigned to me" — there's no clear path for "find all tickets about X". Adding `wit_search` gives a direct text-search entry point with no WIQL required.

**Implementation**: Add `wit_search` at the end of `configureWorkItemsTools` in `src/tools/work-items.ts`. It reuses `buildWorkItemQuery`, `LIST_FIELDS`, `asTicketList`, and `boundLimit` already in scope.

**Add to `configureWorkItemsTools`**:
```ts
server.registerTool(
  "wit_search",
  {
    description:
      "Search work items by title text. Returns a compact ticket list (same format as " +
      "wit_list_my_work_items). Use this when looking for tickets about a topic without " +
      "filtering by assignee. Falls back to ADO_DEFAULT_PROJECT when project is omitted.",
    inputSchema: {
      text: z.string().min(1).describe("Text to match in work item titles"),
      project: z
        .string()
        .min(1)
        .optional()
        .describe("Project to scope search; uses ADO_DEFAULT_PROJECT if not given"),
      state: z
        .string()
        .min(1)
        .optional()
        .describe(
          "State filter: 'open' (default, excludes Closed/Done/Resolved), 'all', " +
          "or a comma-separated list e.g. 'Active,New'",
        ),
      top: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of results (default ADO_AGENT_LIST_CAP, bounded by ADO_MAX_RESULTS)"),
    },
  },
  async ({ text, project, state, top }, extra) => {
    const client = deps.clientFor(patFromExtra(extra));
    const cap = boundLimit(top ?? deps.config.agentListCap, deps.config.maxResults);
    const effectiveProject = project ?? deps.config.defaultProject;

    let allStates = false;
    let states: string[] | undefined;
    if (state) {
      const normalized = state.trim().toLowerCase();
      if (normalized === "all") allStates = true;
      else if (normalized !== "open")
        states = state.split(",").map((s) => s.trim()).filter(Boolean);
    }

    const wiql = buildWorkItemQuery({ mine: false, titleContains: text, allStates, states });
    const result = await client.post<{ workItems?: Array<{ id?: number }> }>(
      "/_apis/wit/wiql",
      { query: wiql },
      { project: effectiveProject },
    );
    const refs = (result?.workItems ?? []).filter(
      (r): r is { id: number } => typeof r?.id === "number",
    );
    const total = refs.length;
    const ids = refs.slice(0, cap).map((r) => r.id);
    if (ids.length === 0) return asTicketList([], { total: 0 });

    const items = await client.workItemsBatch<{ id?: number; fields?: Record<string, unknown> }>(
      ids,
      LIST_FIELDS,
    );
    const byId = new Map(items.map((it) => [it.id, it]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((it): it is NonNullable<typeof it> => it !== undefined);
    return asTicketList(ordered, { total });
  },
);
```

**Test update needed** — add `"wit_search"` to the `TOOLS` array in `tests/unit/work-items-tools.test.ts` and add new tests. The test setup already uses a multi-response fake-fetch pattern; `wit_search` fires two fetches (WIQL POST then batch GET), same as `wit_list_my_work_items`. Copy the `wit_list_my_work_items` two-call test pattern.

New tests to add:
```ts
it("wit_search queries work items by title text without assignee filter", async () => {
  const { calls, tools } = setup(
    [
      { workItems: [{ id: 1 }, { id: 2 }] },       // WIQL response
      { value: [                                     // batch GET response
        { id: 1, fields: { "System.Id": 1, "System.Title": "Login bug", "System.State": "Active",
            "System.WorkItemType": "Bug", "System.AssignedTo": null, "System.CreatedBy": "Alice" } },
        { id: 2, fields: { "System.Id": 2, "System.Title": "Login flow refactor", "System.State": "New",
            "System.WorkItemType": "Task", "System.AssignedTo": null, "System.CreatedBy": "Bob" } },
      ] },
    ],
  );
  const result = (await tools.get("wit_search")!({ text: "Login" }, {})) as {
    content: Array<{ text: string }>;
  };
  const text = result.content[0]!.text;
  expect(text).toContain("Login bug");
  expect(text).toContain("Login flow refactor");
  // WIQL call should not contain @Me
  const wiqlBody = calls[0]!.body as { query: string };
  expect(wiqlBody.query).not.toContain("@Me");
  expect(wiqlBody.query).toContain("Login");
});

it("wit_search falls back to ADO_DEFAULT_PROJECT when project is omitted", async () => {
  const cfgWithDefault: ServerConfig = { ...config, defaultProject: "DefaultProj" };
  const { calls, tools } = setup(
    [{ workItems: [] }],
    { config: cfgWithDefault },
  );
  await tools.get("wit_search")!({ text: "something" }, {});
  expect(calls[0]!.url).toContain("/DefaultCollection/DefaultProj/_apis/wit/wiql");
});
```

---

### 4. `src/tools/repositories.ts`

#### Fix M4 — `pr_list`: add `sourceBranch` filter

**Problem**: `pr_list` can filter by `targetBranch` but not `sourceBranch`. "What PRs are open for feature/X?" is a common query that requires knowing the source branch, not the target.

**Change — add param to `pr_list` inputSchema**:

Current:
```ts
targetBranch: z
  .string()
  .min(1)
  .optional()
  .describe("Filter by target branch (short name or full ref)"),
```

Add after `targetBranch`:
```ts
sourceBranch: z
  .string()
  .min(1)
  .optional()
  .describe("Filter by source (feature) branch (short name or full ref)"),
```

**Change — update `pr_list` handler signature and query**:

Current:
```ts
async ({ repositoryId, project, status, targetBranch, top }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));
  const cap = boundLimit(top, deps.config.maxResults);
  const query: Record<string, QueryValue> = {
    "searchCriteria.status": status,
    "searchCriteria.targetRefName": targetBranch ? toRefName(targetBranch) : undefined,
    $top: cap,
  };
```

Replace with:
```ts
async ({ repositoryId, project, status, targetBranch, sourceBranch, top }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));
  const cap = boundLimit(top, deps.config.maxResults);
  const query: Record<string, QueryValue> = {
    "searchCriteria.status": status,
    "searchCriteria.targetRefName": targetBranch ? toRefName(targetBranch) : undefined,
    "searchCriteria.sourceRefName": sourceBranch ? toRefName(sourceBranch) : undefined,
    $top: cap,
  };
```

**Test update needed** — add one new test:
```ts
it("pr_list filters by sourceBranch", async () => {
  const { calls, tools } = setup({ value: [] });
  await tools.get("pr_list")!(
    { repositoryId: "my-repo", project: "Proj", sourceBranch: "feature/x" },
    {},
  );
  expect(calls[0]!.url).toContain("sourceRefName=refs%2Fheads%2Ffeature%2Fx");
});
```

---

### 5. `src/tools/work-items.ts` — description fixes

#### Fix M1 — `wit_get`: document fields/expand mutual exclusivity

**Change — update `wit_get` description**:

Current:
```ts
description: "Get a single work item by id.",
```

Replace with:
```ts
description:
  "Get a single work item by id. " +
  "Pass 'fields' for a specific field projection OR 'expand' for related data — " +
  "they are mutually exclusive (ADO rejects both together).",
```

No test change needed.

---

### 6. `src/tools/core.ts` — description chaining hints

#### Fix M2 — `core_list_projects`: add chaining hint

**Change — update `core_list_projects` description**:

Current:
```ts
description: "List all team projects in the Azure DevOps collection.",
```

Replace with:
```ts
description:
  "List all team projects in the Azure DevOps collection. " +
  "Returns {id, name, description, state}. Use the 'name' as the 'project' " +
  "parameter in all other tools (wit_*, pr_*, repo_*, pipeline_*, wiki_*, work_*).",
```

#### Fix M3 — `core_list_teams`: add chaining hint

**Change — update `core_list_teams` description**:

Current:
```ts
description: "List teams for a project, or all teams in the collection if no project is given.",
```

Replace with:
```ts
description:
  "List teams for a project, or all teams in the collection if no project is given. " +
  "Returns {id, name, description, projectName}. Use the 'name' as the 'team' " +
  "parameter in work_list_iterations, work_list_backlog_levels, and work_get_capacity.",
```

No test changes needed for M2 or M3.

---

## Build and Push

```bash
npm test          # all tests must pass (update any that break from response-shape changes)
npm run build     # must emit dist/index.js with no errors
git add src/tools/pipelines.ts src/tools/work.ts src/tools/work-items.ts \
        src/tools/repositories.ts src/tools/core.ts \
        tests/unit/pipelines-tools.test.ts tests/unit/work-tools.test.ts \
        tests/unit/work-items-tools.test.ts tests/unit/pull-requests-tools.test.ts
git commit -m "fix: weak-llm audit batch 3 — slim pipeline_get, build_queue, iterations, comment; add wit_search and pr_list sourceBranch"
git push
```

---

## Success Criteria

- [ ] `pipeline_get` returns only `{id, name, folder, revision, configuration:{type, path, repository:{id,type,name}}}` by default; full object with `includeConfiguration=true`
- [ ] `build_queue` returns only `{id, buildNumber, status, queueTime, definition:{id,name}}`
- [ ] `work_list_iterations` returns `{id, name, path, startDate, finishDate, timeFrame}` per item (dates as `YYYY-MM-DD`)
- [ ] `wit_add_comment` returns only `{id, workItemId, createdDate}`
- [ ] `wit_search` finds work items by title text without requiring an assignee filter; falls back to ADO_DEFAULT_PROJECT
- [ ] `pr_list` accepts `sourceBranch` and passes `searchCriteria.sourceRefName` to ADO
- [ ] `wit_get` description mentions fields/expand mutual exclusivity
- [ ] `core_list_projects` and `core_list_teams` descriptions mention which parameter to use their results as
- [ ] All existing tests pass; new tests for H1, H3, H2, H4, N1, M4 pass
- [ ] `npm run build` emits `dist/index.js` with no errors

## Open Questions

None — all items have clear before/after code.
