# Weak-LLM Audit — Batch 2 Implementation Spec

## Context

Branch: `fix/weak-llm-audit` (open as PR #23 against `main`).

All changes must be committed to that branch and pushed. Run `npm test && npm run build` before pushing. All 231 existing tests must stay green; update tests that break due to the new slimming (they must test the new shape, not the old one).

The codebase already has the following shared helpers in `src/tools/_shared.ts`:
- `cleanAdo(value)` — strips `_links`, bare `url` fields, flattens ADO identity objects to display-name strings, strips `refs/heads/` prefix from `*RefName` fields
- `asCleanText(data)` — `cleanAdo` + compact JSON
- `textResult(text)` — wraps plain string in MCP tool result shape
- `truncateField(value, max)` — truncates strings
- `asPRList(prs, meta?)` — compact one-line-per-PR formatter
- `asTicketList(items, meta?)` — compact one-line-per-ticket formatter

And in `src/tools/work-items.ts`:
- `formatWorkItemDetail(item)` — strips top-level noise, truncates all HTML fields, applies `cleanAdo`, 50 KB size guard. Already used by `wit_get`.

---

## Files to Change

### 1. `src/tools/work-items.ts`

#### Fix A — `wit_list_types`: slim to `{name, referenceName, description, color}`

Current (end of `wit_list_types` handler):
```ts
return asCleanText(result.value ?? []);
```

Replace with:
```ts
const slim = (result.value ?? []).map((t) => {
  const type = t as Record<string, unknown>;
  return {
    name: type["name"],
    referenceName: type["referenceName"],
    description: type["description"],
    color: type["color"],
  };
});
return asCleanText(slim);
```

**Test update needed** — `wit_list_types lists work item types for a project` currently expects `types.map((t) => t.name)` to equal `["Bug", "Task"]`. After slimming the mock input `{ value: [{ name: "Bug" }, { name: "Task" }] }`, the slim produces `[{name:"Bug"}, {name:"Task"}]` so `t.name` still works. **No test change needed.**

---

#### Fix B — `wit_create` and `wit_update`: use `formatWorkItemDetail` instead of `asCleanText`

Current `wit_create` end:
```ts
const created = await client.post(...);
return asCleanText(created);
```

Replace with:
```ts
const created = await client.post(
  `/_apis/wit/workitems/$${encodeURIComponent(type)}`,
  fieldsToPatch(fields),
  { project },
  JSON_PATCH,
);
return formatWorkItemDetail(created);
```

Current `wit_update` end:
```ts
const updated = await client.patch(...);
return asCleanText(updated);
```

Replace with:
```ts
const updated = await client.patch(
  `/_apis/wit/workitems/${id}`,
  fieldsToPatch(fields),
  {},
  JSON_PATCH,
);
return formatWorkItemDetail(updated);
```

**Test update needed** — `wit_create POSTs a JSON-Patch document...` and `wit_update PATCHes...` tests only check `calls[0]` (URL, method, body). They do NOT parse the response. Mock response is `{ id: 100 }` which has no `fields` key, so `formatWorkItemDetail` falls through the `"fields" in item` guard and calls `cleanAdo({ id: 100 })` → `{"id":100}`. **No test change needed.**

---

#### Fix C — `wit_add_comment`: strip `renderedText`, `reactions`, `mentions`, `format`

Current `wit_add_comment` end:
```ts
const comment = await client.post(...);
return asCleanText(comment);
```

Replace with:
```ts
const STRIP_COMMENT_KEYS = new Set(["renderedText", "reactions", "mentions", "format"]);
const comment = await client.post(
  `/_apis/wit/workItems/${id}/comments`,
  { text },
  { project, apiVersion: toPreviewVersion(deps.config.apiVersion, 3) },
) as Record<string, unknown>;
const slim: Record<string, unknown> = {};
for (const [k, v] of Object.entries(comment)) {
  if (!STRIP_COMMENT_KEYS.has(k)) slim[k] = v;
}
return asCleanText(slim);
```

**Test update needed** — `wit_add_comment POSTs...` test only checks `calls[0]` (URL, method, body). Mock response is `{ id: 1, text: "hi" }` — no stripped keys present, so slim passes through unchanged. **No test change needed.**

---

### 2. `src/tools/pipelines.ts`

#### Fix D — `pipeline_list`: slim to `{id, name, folder, revision}`

Current end of `pipeline_list` handler:
```ts
return asCleanText((result.value ?? []).slice(0, cap));
```

Replace with:
```ts
const slim = (result.value ?? []).slice(0, cap).map((p) => {
  const pipeline = p as Record<string, unknown>;
  return {
    id: pipeline["id"],
    name: pipeline["name"],
    folder: pipeline["folder"],
    revision: pipeline["revision"],
  };
});
return asCleanText(slim);
```

**Test update needed** — `pipeline_list bounds results to maxResults`: mock input is `[{id:1},{id:2},{id:3}]`. After slim: `[{id:1},{id:2}]` (cap=2). `parseResult` returns array of length 2. **No test change needed.**

---

#### Fix E — `build_list`: slim to `{id, buildNumber, status, result, startTime, finishTime, sourceBranch, definition:{id,name}, requestedBy}`

Current end of `build_list` handler:
```ts
return asCleanText((result.value ?? []).slice(0, cap));
```

Replace with:
```ts
const slim = (result.value ?? []).slice(0, cap).map((b) => {
  const build = b as Record<string, unknown>;
  const def = build["definition"] as Record<string, unknown> | undefined;
  return {
    id: build["id"],
    buildNumber: build["buildNumber"],
    status: build["status"],
    result: build["result"],
    startTime: build["startTime"],
    finishTime: build["finishTime"],
    sourceBranch: build["sourceBranch"],
    definition: def ? { id: def["id"], name: def["name"] } : undefined,
    requestedBy: build["requestedBy"],
  };
});
return asCleanText(slim);
```

Note: `requestedBy` is an identity object; `cleanAdo` (called inside `asCleanText`) will flatten it to a display-name string.

**Test update needed** — `build_list bounds results to maxResults`: mock input is `[{id:1},{id:2}]`, cap=1. After slim: `[{id:1}]`. `parseResult` returns array of length 1. **No test change needed.**

---

#### Fix F — `build_get`: strip `orchestrationPlan`, `validationResults`, `properties`, `triggerInfo`, and the nested `project` field

Current `build_get` handler:
```ts
async ({ project, buildId }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));
  const build = await client.get(`/_apis/build/builds/${buildId}`, { project });
  return asCleanText(build);
},
```

Replace with:
```ts
async ({ project, buildId }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));
  const build = await client.get<Record<string, unknown>>(`/_apis/build/builds/${buildId}`, { project });
  const STRIP_BUILD_KEYS = new Set(["orchestrationPlan", "validationResults", "properties", "triggerInfo", "project"]);
  const slim: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(build)) {
    if (!STRIP_BUILD_KEYS.has(k)) slim[k] = v;
  }
  return asCleanText(slim);
},
```

**Test update needed** — `build_get fetches a single build by id`: only checks `calls[0].url`. **No test change needed.**

---

### 3. `src/tools/test-plans.ts`

#### Fix G — `testplan_list`: slim to `{id, name, state, startDate, endDate, rootSuiteId}`

Current end of `testplan_list` handler:
```ts
return asCleanText(plans);
```

Replace with:
```ts
const slim = plans.map((p) => {
  const plan = p as Record<string, unknown>;
  return {
    id: plan["id"],
    name: plan["name"],
    state: plan["state"],
    startDate: plan["startDate"],
    endDate: plan["endDate"],
    rootSuiteId: plan["rootSuiteId"],
  };
});
return asCleanText(slim);
```

**Test updates needed:**

- `testplan_list queries the project-scoped testplan endpoint`: mock `[{id:1}]` → slimmed `[{id:1}]` (undefined fields omitted by JSON.stringify). `expect(plans).toEqual([{id:1}])` — **still passes** (undefined fields are dropped).

- `testplan_list follows the continuation token across pages`: mock produces `[{id:1},{id:2},{id:3}]` → slimmed `[{id:1},{id:2},{id:3}]`. `expect(plans).toEqual([{id:1},{id:2},{id:3}])` — **still passes**.

- No test changes needed for this tool.

---

#### Fix H — `testplan_list_suites`: slim to `{id, name, suiteType, parentSuite:{id}}`

Current end of `testplan_list_suites` handler:
```ts
return asCleanText(suites);
```

Replace with:
```ts
const slim = suites.map((s) => {
  const suite = s as Record<string, unknown>;
  const parent = suite["parentSuite"] as Record<string, unknown> | undefined;
  return {
    id: suite["id"],
    name: suite["name"],
    suiteType: suite["suiteType"],
    parentSuite: parent ? { id: parent["id"] } : undefined,
  };
});
return asCleanText(slim);
```

**Test updates needed:**

- `testplan_list_suites queries the plan's suites endpoint`: mock `[{id:10}]` → slimmed `[{id:10}]`. `expect(suites).toEqual([{id:10}])` — **still passes**.

- No test changes needed.

---

#### Fix I — `testplan_list_cases`: slim to `{workItem:{id,name}, order, pointAssignments:[{id,tester,configurationName}]}`

Current end of `testplan_list_cases` handler:
```ts
return asCleanText(cases);
```

Replace with:
```ts
const slim = cases.map((c) => {
  const tc = c as Record<string, unknown>;
  const wi = tc["workItem"] as Record<string, unknown> | undefined;
  const points = (tc["pointAssignments"] as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    workItem: wi ? { id: wi["id"], name: wi["name"] } : undefined,
    order: tc["order"],
    pointAssignments: points.map((pt) => ({
      id: pt["id"],
      tester: pt["tester"],
      configurationName: pt["configurationName"],
    })),
  };
});
return asCleanText(slim);
```

Note: `tester` is an identity object; `cleanAdo` (inside `asCleanText`) will flatten it to a display-name string.

**Test update REQUIRED** — `testplan_list_cases queries the suite's test case endpoint`:

Current test:
```ts
const cases = parseResult(
  await tools.get("testplan_list_cases")!({ project: "Proj", planId: 5, suiteId: 9 }, {}),
) as unknown[];
expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/testplan/plans/5/suites/9/testcase");
expect(cases).toEqual([{ workItem: { id: 42 } }]);
```

Mock input: `{ value: [{ workItem: { id: 42 } }] }`

After slim: `[{ workItem: { id: 42 }, pointAssignments: [] }]`

The `toEqual([{ workItem: { id: 42 } }])` will FAIL because `pointAssignments: []` is present.

Update the test expectation to:
```ts
expect(cases).toEqual([{ workItem: { id: 42 }, pointAssignments: [] }]);
```

---

### 4. `src/tools/repositories.ts`

#### Fix J — `repo_list_commits`: slim to `{commitId, comment, author:{name,date}, changeCounts}`

Current end of `repo_list_commits` handler:
```ts
return asCleanText((result.value ?? []).slice(0, cap));
```

Replace with:
```ts
const slim = (result.value ?? []).slice(0, cap).map((c) => {
  const commit = c as Record<string, unknown>;
  const author = commit["author"] as Record<string, unknown> | undefined;
  return {
    commitId: commit["commitId"],
    comment: commit["comment"],
    author: author ? { name: author["name"], date: author["date"] } : undefined,
    changeCounts: commit["changeCounts"],
  };
});
return asCleanText(slim);
```

**Test updates needed:**

- `repo_list_commits returns at most maxResults when top is omitted`: mock is `[{id:1},...5 items]`. After slim: `[{},{}]` (undefined fields omitted). `expect(commits).toHaveLength(2)` — **still passes**.

- `repo_list_commits maps filters onto searchCriteria params`: only checks URL. **No test change needed.**

---

#### Fix K — `repo_get_commit`: strip `treeId`, `committer`, `push`

Current `repo_get_commit` handler end:
```ts
const commit = await client.get(
  `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/commits/${encodeURIComponent(commitId)}`,
  { project, query },
);
return asCleanText(commit);
```

Replace with:
```ts
const STRIP_COMMIT_KEYS = new Set(["treeId", "committer", "push"]);
const commit = await client.get<Record<string, unknown>>(
  `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/commits/${encodeURIComponent(commitId)}`,
  { project, query },
);
const slim: Record<string, unknown> = {};
for (const [k, v] of Object.entries(commit)) {
  if (!STRIP_COMMIT_KEYS.has(k)) slim[k] = v;
}
return asCleanText(slim);
```

**Test updates needed** — both `repo_get_commit` tests only check URL. **No test change needed.**

---

#### Fix L — `repo_list_branches`: slim to `{name, objectId}` (keep existing `refs/heads/` prefix stripping)

Current handler:
```ts
const withShortName = refs.map((ref) => {
  if (ref && typeof ref === "object" && typeof ref.name === "string") {
    const name = ref.name;
    return {
      ...ref,
      name: name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name,
    };
  }
  return ref;
});
return asCleanText(withShortName);
```

Replace with:
```ts
const slim = refs.map((ref) => {
  const r = ref as Record<string, unknown>;
  const rawName = (r["name"] as string) ?? "";
  return {
    name: rawName.startsWith("refs/heads/") ? rawName.slice("refs/heads/".length) : rawName,
    objectId: r["objectId"],
  };
});
return asCleanText(slim);
```

**Test updates needed** — `repo_list_branches lists heads refs and strips the refs/heads/ prefix`:
- checks `branches[0]["name"] === "main"` ✓ (still works)
- checks `branches[0]["objectId"] === "abc"` ✓ (still works)
- Comment says "Other fields are preserved" but that comment is about the pre-existing behavior. **Update the comment** to say "Slimmed to name and objectId only."

No assertion changes needed.

---

#### Fix M — `repo_list_items`: slim to `{path, gitItemPath, isFolder}`

Current handler (two code paths — truncated and normal):
```ts
if (allItems.length > cap) {
  return textResult(
    JSON.stringify(cleanAdo(sliced)) +
      `\n\n[Truncated: showing ${cap} of ${allItems.length} items. Use scopePath to narrow the listing.]`,
  );
}
return asCleanText(sliced);
```

Replace with:
```ts
function slimItems(items: unknown[]): Array<{ path: unknown; gitItemPath: unknown; isFolder: unknown }> {
  return items.map((item) => {
    const it = item as Record<string, unknown>;
    return { path: it["path"], gitItemPath: it["gitItemPath"], isFolder: it["isFolder"] };
  });
}
```

Wait — don't add a named helper at module scope for this; inline the map instead:

```ts
const slimmed = sliced.map((item) => {
  const it = item as Record<string, unknown>;
  return { path: it["path"], gitItemPath: it["gitItemPath"], isFolder: it["isFolder"] };
});
if (allItems.length > cap) {
  return textResult(
    JSON.stringify(cleanAdo(slimmed)) +
      `\n\n[Truncated: showing ${cap} of ${allItems.length} items. Use scopePath to narrow the listing.]`,
  );
}
return asCleanText(slimmed);
```

The slimming must happen before the `> cap` check so both code paths use slimmed items.

**Test updates needed:**

- `repo_list_items returns at most maxResults and notes truncation`: mock `[{id:1},...5 items]`, cap=2. After slim: `[{},{} ]` (undefined fields omitted). The test does:
  ```ts
  expect(text).toContain("[Truncated: showing 2 of 5 items.");
  const items = JSON.parse(text.split("\n\n[Truncated")[0]!) as unknown[];
  expect(items).toHaveLength(2);
  ```
  Both checks still pass. ✓

- `repo_list_items omits the truncation note when under the cap`: mock `[{path:"/a"}]` → slimmed `[{path:"/a"}]`. `parseList` returns length 1. ✓

---

#### Fix N — `pr_add_comment`: return `{id, status, commentCount: 1}`

Current `pr_add_comment` end:
```ts
const thread = await client.post(...);
return asCleanText(thread);
```

Replace with:
```ts
const thread = await client.post(
  `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}/threads`,
  { comments: [{ parentCommentId: 0, content, commentType: "text" }] },
  { project },
) as Record<string, unknown>;
return asCleanText({
  id: thread["id"],
  status: thread["status"],
  commentCount: 1,
});
```

**Test updates needed** — `pr_add_comment POSTs a new thread with the comment text`: only checks `call.method`, `call.url`, `call.body`. Does NOT parse the response. **No test change needed.**

---

#### Fix O — `pr_create` and `pr_update_status`: slim response to `{pullRequestId, title, status, sourceRefName, targetRefName}`

Current `pr_create` end:
```ts
const pr = await client.post(...);
return asCleanText(pr);
```

Replace with:
```ts
const pr = await client.post(
  `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests`,
  body,
  { project },
) as Record<string, unknown>;
return asCleanText({
  pullRequestId: pr["pullRequestId"],
  title: pr["title"],
  status: pr["status"],
  sourceRefName: pr["sourceRefName"],
  targetRefName: pr["targetRefName"],
});
```

Current `pr_update_status` end:
```ts
const pr = await client.patch(...);
return asCleanText(pr);
```

Replace with:
```ts
const pr = await client.patch(
  `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}`,
  body,
  { project },
) as Record<string, unknown>;
return asCleanText({
  pullRequestId: pr["pullRequestId"],
  title: pr["title"],
  status: pr["status"],
  sourceRefName: pr["sourceRefName"],
  targetRefName: pr["targetRefName"],
});
```

**Test updates needed** — all `pr_create` and `pr_update_status` tests only check the outgoing `calls` (method, url, body), not the response. **No test change needed.**

---

### 5. `src/tools/work.ts`

#### Fix P — `work_list_backlog_levels`: slim to `{id, name, rank, workItemTypes:[string], defaultWorkItemType:string}`

Current end of `work_list_backlog_levels` handler:
```ts
return asCleanText((result.value ?? []).slice(0, cap));
```

Replace with:
```ts
const slim = (result.value ?? []).slice(0, cap).map((l) => {
  const level = l as Record<string, unknown>;
  const types = (level["workItemTypes"] as Array<Record<string, unknown>> | undefined) ?? [];
  const defType = level["defaultWorkItemType"] as Record<string, unknown> | undefined;
  return {
    id: level["id"],
    name: level["name"],
    rank: level["rank"],
    workItemTypes: types.map((t) => (t["name"] as string) ?? String(t)),
    defaultWorkItemType: defType ? ((defType["name"] as string) ?? undefined) : undefined,
  };
});
return asCleanText(slim);
```

**Test updates needed:**

- `work_list_backlog_levels targets the team-scoped backlogs endpoint`: mock `[{id:"Microsoft.EpicCategory"}]`. After slim: `[{id:"Microsoft.EpicCategory", workItemTypes:[], defaultWorkItemType:undefined}]` → JSON: `[{"id":"Microsoft.EpicCategory","workItemTypes":[]}]`. Test checks `levels.toHaveLength(1)` ✓ and URL ✓. **No test change needed.**

- `work_list_backlog_levels bounds results to a caller-supplied top`: length 2 check ✓.

---

#### Fix Q — `work_get_capacity`: strip `displayAttributes` from each team member's activities

The ADO capacity response shape is:
```json
{
  "teamMembers": [
    {
      "teamMember": { "displayName": "..." },
      "activities": [
        { "capacityPerDay": 6, "displayAttributes": { ... }, "name": "..." }
      ],
      "daysOff": []
    }
  ],
  "totalCapacityPerDay": 6,
  "totalDaysOff": 0
}
```

Current `work_get_capacity` end:
```ts
const capacity = await client.get(
  workPath(team, `teamsettings/iterations/${encodeURIComponent(resolvedId)}/capacities`),
  { project: effectiveProject },
);
return asCleanText(capacity);
```

Replace with:
```ts
const raw = await client.get<Record<string, unknown>>(
  workPath(team, `teamsettings/iterations/${encodeURIComponent(resolvedId)}/capacities`),
  { project: effectiveProject },
);
// Strip displayAttributes (UI-only display hints) from each team member's activity list.
let result: unknown = raw;
if (raw && Array.isArray(raw["teamMembers"])) {
  result = {
    ...raw,
    teamMembers: (raw["teamMembers"] as Array<Record<string, unknown>>).map((member) => ({
      ...member,
      activities: ((member["activities"] as Array<Record<string, unknown>>) ?? []).map(
        ({ displayAttributes: _d, ...rest }) => rest,
      ),
    })),
  };
}
return asCleanText(result);
```

**Test updates needed** — `work_get_capacity targets the iteration capacities endpoint and returns the full object`:

Current mock:
```ts
const capacity = {
  teamMembers: [{ teamMember: { displayName: "Dev" }, activities: [{ capacityPerDay: 6 }] }],
  totalCapacityPerDay: 6,
  totalDaysOff: 0,
};
```

No `displayAttributes` in mock, so stripping is a no-op. Expected result unchanged:
```ts
expect(result).toEqual({
  teamMembers: [{ teamMember: "Dev", activities: [{ capacityPerDay: 6 }] }],
  totalCapacityPerDay: 6,
  totalDaysOff: 0,
});
```
**No test change needed.**

---

### 6. `src/tools/core.ts`

#### Fix R — `core_list_teams`: slim to `{id, name, description, projectName}`

Current `core_list_teams` handler (both branches):
```ts
if (project) {
  const teams = await client.getAll(`/_apis/projects/${encodeURIComponent(project)}/teams`);
  return asCleanText(teams);
}
const teams = await client.getAll("/_apis/teams", {
  apiVersion: toPreviewVersion(deps.config.apiVersion, 3),
});
return asCleanText(teams);
```

Replace with:
```ts
function slimTeam(t: unknown): { id: unknown; name: unknown; description: unknown; projectName: unknown } {
  const team = t as Record<string, unknown>;
  return {
    id: team["id"],
    name: team["name"],
    description: team["description"],
    projectName: team["projectName"],
  };
}

if (project) {
  const teams = await client.getAll(`/_apis/projects/${encodeURIComponent(project)}/teams`);
  return asCleanText(teams.map(slimTeam));
}
const teams = await client.getAll("/_apis/teams", {
  apiVersion: toPreviewVersion(deps.config.apiVersion, 3),
});
return asCleanText(teams.map(slimTeam));
```

Don't add `slimTeam` as a module-level function; define it inline as an arrow function local to the handler or inline the map directly to avoid polluting module scope:

```ts
if (project) {
  const teams = await client.getAll(`/_apis/projects/${encodeURIComponent(project)}/teams`);
  return asCleanText(
    teams.map((t) => {
      const team = t as Record<string, unknown>;
      return { id: team["id"], name: team["name"], description: team["description"], projectName: team["projectName"] };
    }),
  );
}
const teams = await client.getAll("/_apis/teams", {
  apiVersion: toPreviewVersion(deps.config.apiVersion, 3),
});
return asCleanText(
  teams.map((t) => {
    const team = t as Record<string, unknown>;
    return { id: team["id"], name: team["name"], description: team["description"], projectName: team["projectName"] };
  }),
);
```

**Test updates needed** — all `core_list_teams` tests only check URL. The mock response is `{ value: [{ name: "P1" }] }` → after slim: `[{name:"P1"}]`. Tests do not parse the response body. **No test change needed.**

---

## Summary of Test Files to Update

Only one test assertion needs changing:

**`tests/unit/test-plans-tools.test.ts`** — line ~191:

```ts
// BEFORE:
expect(cases).toEqual([{ workItem: { id: 42 } }]);

// AFTER:
expect(cases).toEqual([{ workItem: { id: 42 }, pointAssignments: [] }]);
```

All other tests pass through without assertion changes (either they only check URL/method/body of the outgoing HTTP call, or the undefined-field omission in JSON.stringify makes them compatible with the new shape).

---

## Build and Test

After all changes:
```
npm test       # must be green (231+ tests)
npm run build  # must produce dist/index.js without errors
```

Then:
```
git add src/tools/work-items.ts src/tools/pipelines.ts src/tools/test-plans.ts \
        src/tools/repositories.ts src/tools/work.ts src/tools/core.ts \
        tests/unit/test-plans-tools.test.ts dist/index.js
git commit -m "fix: slim response payloads across all remaining list/detail tools (batch 2)"
git push origin fix/weak-llm-audit
```
