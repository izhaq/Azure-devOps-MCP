# Weak-LLM Audit — Implementation Spec

**Branch:** `fix/bundle-undici` (or a new branch off it)  
**Goal:** Fix all HIGH, MEDIUM, and LOW findings from the audit of MCP tool responses for use with small/weak LLMs (e.g. Tabnine CLI in an air-gapped environment). Work through findings in order: HIGH → MEDIUM → LOW. Build and run tests after every group.

---

## Repository Layout (relevant files)

```
src/
  tools/
    _shared.ts          ← shared formatters: cleanAdo(), asCleanText(), asTicketList(), textResult(), truncateField()
    work-items.ts       ← wit_query, wit_list_my_work_items, wit_get, wit_create, wit_update, wit_add_comment, wit_list_types
    work.ts             ← work_get_current_sprint, work_list_iterations, work_list_backlog_levels, work_get_capacity
    repositories.ts     ← repo_list, repo_list_branches, repo_get_file, repo_list_items, repo_list_commits, repo_get_commit
                          + pr_list, pr_get, pr_list_threads, pr_create, pr_add_comment, pr_update_status
    pipelines.ts        ← pipeline_list, pipeline_get, build_list, build_get, build_queue, build_get_logs
    wiki.ts             ← wiki_list, wiki_get_page, wiki_create_or_update_page
    test-plans.ts       ← testplan_list, testplan_list_suites, testplan_list_cases
    core.ts             ← core_list_projects, core_list_teams
  azure/
    errors.ts           ← AdoApiError, adoErrorFromResponse()
    client.ts           ← AzureDevOpsClient (get, post, patch, getAll, workItemsBatch, resolveIdentity)
  shared/
    wiql.ts             ← buildWorkItemQuery(), WorkItemQueryOptions
tests/
  unit/
    work-tools.test.ts  ← tests for work.ts tools
    (other test files mirror each domain)
```

## Key Shared Utilities (already implemented — do NOT re-implement)

```typescript
// src/tools/_shared.ts

// Recursively cleans ADO API response:
// - Strips _links at every level
// - Strips bare `url` string fields (not webUrl/remoteUrl/sshUrl)
// - Flattens identity objects (those with displayName) to just the name string
// - Exception: PR reviewer objects with non-zero `vote` become "Name (approved)" etc.
export function cleanAdo(value: unknown): unknown

// Apply cleanAdo then emit compact (no-indent) JSON. Use on all read paths.
export function asCleanText(data: unknown): ToolResult

// Wrap a string in MCP tool result shape
export function textResult(text: string): ToolResult

// Truncate a string to max chars with a marker
export function truncateField<T>(value: T, max: number): T | string

// Render projected work items as one-line-per-ticket summary
export function asTicketList(items: ProjectedWorkItem[], meta?: { total?: number }): ToolResult

// LIST_FIELDS constant in work-items.ts (5 fields for compact ticket listing)
const LIST_FIELDS = ["System.Id","System.Title","System.State","System.AssignedTo","System.WorkItemType"]

// MAX_INLINE_RESULT_BYTES = 50_000 (used in wit_get and wit_list_my_work_items)
```

---

## HIGH Priority Findings

### H1 — `wit_query`: Return actual field data for flat queries; smarter description; merge cap warning

**File:** `src/tools/work-items.ts`  
**Tool:** `wit_query`

**Problem:** The tool returns only work item references (`{ id, url }` array). A weak model cannot answer questions from those IDs alone — it has no title, state, or assignee. The current response is a multi-content-block response (main result + a separate cap-warning text block), which confuses some MCP clients.

**Fix:**

1. After the WIQL POST, check if `result.workItems` exists and has items (this indicates a flat query returning IDs).
2. If yes: extract the IDs, fetch fields via `client.workItemsBatch(ids, LIST_FIELDS)`, and return using `asTicketList()` — same format as `wit_list_my_work_items`.
3. Merge the cap warning into the `asTicketList` output (the `meta.total` mechanism already handles "showing N of M" messages; use that instead of a second content block).
4. If `result.workItems` is absent but `result.workItemRelations` exists (hierarchical/tree query), fall back to returning the raw cleaned result with a single-block cap note embedded in the text (no second content block).
5. Update the description to clarify: "For common use cases like listing your tickets, prefer `wit_list_my_work_items` which handles identity, iteration, and state filters without writing WIQL."

**Current code (lines 88–128 of `src/tools/work-items.ts`):**
```typescript
server.registerTool(
  "wit_query",
  {
    description:
      "Run a WIQL (Work Item Query Language) query and return matching work item references.",
    inputSchema: {
      query: z.string().min(1).describe("WIQL query text, e.g. SELECT [System.Id] FROM workitems"),
      project: z.string().optional().describe("Project name or ID to scope the query; omit for collection scope"),
      top: z.number().int().positive().optional().describe("Maximum number of results"),
    },
  },
  async ({ query, project, top }, extra) => {
    const client = deps.clientFor(patFromExtra(extra));
    const cap = boundLimit(top, deps.config.maxResults);
    const result = await client.post<{ workItems?: unknown[] }>(
      "/_apis/wit/wiql",
      { query },
      { project, query: { $top: cap } },
    );
    const out = asCleanText(result);
    // BUG: pushes a second content block — confuses some MCP clients (L10)
    if ((result?.workItems?.length ?? 0) >= cap) {
      out.content.push({
        type: "text",
        text: `Note: results are capped at ${cap} ...`,
      });
    }
    return out;
  },
);
```

**New implementation:**
```typescript
server.registerTool(
  "wit_query",
  {
    description:
      "Run a WIQL (Work Item Query Language) query. For flat queries (SELECT … FROM WorkItems), " +
      "fetches the matched items' fields and returns them as a compact ticket list — same format " +
      "as wit_list_my_work_items. For hierarchical queries (FROM WorkItemLinks), returns the raw " +
      "relation graph. Prefer wit_list_my_work_items for everyday filtering (my tickets, current " +
      "sprint, state) — it handles identity resolution and iteration without requiring WIQL.",
    inputSchema: {
      query: z.string().min(1).describe(
        "WIQL query text, e.g. 'SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me'"
      ),
      project: z.string().optional().describe(
        "Project name or ID to scope the query; omit for collection scope"
      ),
      top: z.number().int().positive().optional().describe("Maximum number of results"),
    },
  },
  async ({ query, project, top }, extra) => {
    const client = deps.clientFor(patFromExtra(extra));
    const cap = boundLimit(top, deps.config.maxResults);
    const result = await client.post<{
      workItems?: Array<{ id?: number }>;
      workItemRelations?: unknown[];
    }>(
      "/_apis/wit/wiql",
      { query },
      { project, query: { $top: cap } },
    );

    // Flat query: workItems array present → fetch fields and return as ticket list
    if (Array.isArray(result?.workItems)) {
      const refs = (result.workItems).filter(
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
    }

    // Hierarchical / tree query: return cleaned result as a single text block
    // (no second content block — embed the cap note in the text if needed)
    const relations = result?.workItemRelations ?? [];
    const cleaned = cleanAdo(result);
    const note =
      relations.length >= cap
        ? `\n\nNote: results capped at ${cap}. Add a tighter WHERE clause or raise "top".`
        : "";
    return textResult(JSON.stringify(cleaned) + note);
  },
);
```

**Also fixes:** L10 (two-content-block response merged into one).

---

### H2 — `work_get_capacity`: Accept iteration name, not just GUID

**File:** `src/tools/work.ts`  
**Tool:** `work_get_capacity`

**Problem:** The `iterationId` parameter is `z.string().uuid()` — it rejects anything that isn't a GUID. A weak model almost never knows the GUID; it knows the sprint name (e.g. "Sprint 48"). The tool should accept both a GUID and a name, resolving a name to a GUID internally.

**Current code (lines 128–146 of `src/tools/work.ts`):**
```typescript
server.registerTool(
  "work_get_capacity",
  {
    description: "Get a team's capacity (per-member capacity and days off) for an iteration.",
    inputSchema: {
      project: z.string().min(1).describe("Project name or ID"),
      iterationId: z.string().uuid().describe("Iteration id (GUID)"),
      team: z.string().min(1).optional().describe("Team name or ID; defaults to the project's default team"),
    },
  },
  async ({ project, iterationId, team }, extra) => {
    const client = deps.clientFor(patFromExtra(extra));
    const capacity = await client.get(
      workPath(team, `teamsettings/iterations/${encodeURIComponent(iterationId)}/capacities`),
      { project },
    );
    return asCleanText(capacity);
  },
);
```

**Fix:**

1. Change `iterationId` to `z.string().min(1)` (remove `.uuid()` constraint).
2. Update description to say "Iteration GUID or iteration name (e.g. 'Sprint 48'); a name is resolved to its GUID automatically via work_list_iterations."
3. In the handler: check if the value looks like a GUID (regex `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`). If not, call `work_list_iterations` to find the matching iteration by name and extract its `id` (GUID).
4. If no matching iteration is found by name, throw a descriptive error: `"No iteration named '${iterationId}' found in project '${effectiveProject}'. Use work_list_iterations to see available iterations."`

**New handler logic:**
```typescript
async ({ project, iterationId, team }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));
  const effectiveProject = project ?? deps.config.defaultProject;

  // Resolve iteration name → GUID if not already a GUID
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let resolvedId = iterationId;
  if (!GUID_RE.test(iterationId)) {
    const iters = await client.get<{ value?: Array<{ id?: string; name?: string }> }>(
      workPath(team, "teamsettings/iterations"),
      { project: effectiveProject },
    );
    const match = (iters.value ?? []).find(
      (it) => it.name?.toLowerCase() === iterationId.toLowerCase(),
    );
    if (!match?.id) {
      throw new Error(
        `No iteration named '${iterationId}' found in project '${effectiveProject ?? "(unknown)"}'. ` +
        `Use work_list_iterations to see available iterations and their ids.`,
      );
    }
    resolvedId = match.id;
  }

  const capacity = await client.get(
    workPath(team, `teamsettings/iterations/${encodeURIComponent(resolvedId)}/capacities`),
    { project: effectiveProject },
  );
  return asCleanText(capacity);
},
```

**Test update required:** The existing test at `tests/unit/work-tools.test.ts` line 151 passes a GUID directly — it should still pass. Add a new test that passes a name string and verifies two fetch calls are made (one to list iterations, one to get capacity). The `recordingFetch` helper would need to return different bodies on successive calls, or use separate setups. Alternatively, just update the schema test to confirm the uuid constraint is gone.

---

### H3 — `pr_update_status` (complete): Auto-fetch `lastMergeSourceCommitId`

**File:** `src/tools/repositories.ts`  
**Tool:** `pr_update_status`

**Problem:** When `status === "completed"` and no `lastMergeSourceCommitId` is provided, the tool currently throws an error asking the model to supply it. A weak model doesn't know this value and can't figure it out without another tool call. The fix: auto-fetch it from `pr_get`.

**Current handler (lines 425–443 of `src/tools/repositories.ts`):**
```typescript
async ({ repositoryId, pullRequestId, status, lastMergeSourceCommitId, project }, extra) => {
  if (status === "completed" && !lastMergeSourceCommitId) {
    throw new Error(
      "Completing a pull request requires 'lastMergeSourceCommitId' (the current source branch tip commit id).",
    );
  }
  const client = deps.clientFor(patFromExtra(extra));
  const body: Record<string, unknown> = { status };
  if (lastMergeSourceCommitId) {
    body["lastMergeSourceCommit"] = { commitId: lastMergeSourceCommitId };
  }
  ...
}
```

**Fix:**
Replace the throw with an auto-fetch:
```typescript
async ({ repositoryId, pullRequestId, status, lastMergeSourceCommitId, project }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));

  // Auto-fetch the tip commit id when completing — the model never knows it
  let commitId = lastMergeSourceCommitId;
  if (status === "completed" && !commitId) {
    const pr = await client.get<{ lastMergeSourceCommit?: { commitId?: string } }>(
      `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}`,
      { project },
    );
    commitId = pr?.lastMergeSourceCommit?.commitId;
    if (!commitId) {
      throw new Error(
        `Could not auto-fetch lastMergeSourceCommitId for PR ${pullRequestId}. ` +
        `The PR may not have a source commit yet (e.g. no commits pushed).`,
      );
    }
  }

  const body: Record<string, unknown> = { status };
  if (commitId) {
    body["lastMergeSourceCommit"] = { commitId };
  }
  const pr = await client.patch(
    `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}`,
    body,
    { project },
  );
  return asCleanText(pr);
},
```

Also update the `lastMergeSourceCommitId` description to: "Current source branch tip commit id; if omitted when completing, it is auto-fetched from the PR — you usually don't need to supply this."

---

### H4 — Test-plan tools: Add prerequisite chain hints to descriptions

**File:** `src/tools/test-plans.ts`  
**Tools:** `testplan_list`, `testplan_list_suites`, `testplan_list_cases`

**Problem:** A weak model doesn't know the three-step chain: you need a plan ID to list suites, and a suite ID to list cases. There's no hint in the descriptions.

**Fix:** Update descriptions only (no logic changes):

```typescript
// testplan_list
description:
  "List test plans in a project. Returns plan ids and names. " +
  "To list the suites inside a plan, pass the plan id to testplan_list_suites. " +
  "Step 1 of 3: testplan_list → testplan_list_suites → testplan_list_cases.",

// testplan_list_suites
description:
  "List test suites in a test plan. Returns suite ids and names. " +
  "To list test cases inside a suite, pass the suite id to testplan_list_cases. " +
  "Step 2 of 3: testplan_list → testplan_list_suites → testplan_list_cases. " +
  "Pass asTreeView=true to see the parent/child hierarchy.",

// testplan_list_cases
description:
  "List test cases in a test suite of a plan. " +
  "Requires both planId (from testplan_list) and suiteId (from testplan_list_suites). " +
  "Step 3 of 3: testplan_list → testplan_list_suites → testplan_list_cases.",
```

---

### H5 — `wit_create` / `wit_update`: Add common ADO field reference names to descriptions

**File:** `src/tools/work-items.ts`  
**Tools:** `wit_create`, `wit_update`

**Problem:** The `fields` parameter says "keyed by reference name" but gives no examples beyond `System.Title`. A weak model invents field names like "title" or "assignedTo" which break silently.

**Fix:** Update the `fields` parameter `.describe()` strings to include the 10 most common field reference names.

```typescript
// For wit_create, fields describe:
.describe(
  'Field map keyed by ADO field reference names. Common fields: ' +
  '"System.Title" (required), "System.Description", "System.AssignedTo" (display name), ' +
  '"System.AreaPath", "System.IterationPath", "System.Tags", ' +
  '"Microsoft.VSTS.Common.Priority" (1-4), "Microsoft.VSTS.Common.Severity", ' +
  '"Microsoft.VSTS.TCM.ReproSteps" (for Bugs), "System.State". ' +
  'Example: {"System.Title": "Fix login bug", "System.AssignedTo": "Alice Smith"}'
)

// For wit_update, fields describe:
.describe(
  'Field map keyed by ADO field reference names. Common fields: ' +
  '"System.State" (e.g. "Active", "Resolved", "Closed"), "System.AssignedTo" (display name), ' +
  '"System.Title", "System.Description", "System.Tags", "System.AreaPath", ' +
  '"System.IterationPath", "Microsoft.VSTS.Common.Priority" (1-4), ' +
  '"Microsoft.VSTS.Common.ResolvedReason", "System.Reason". ' +
  'Example: {"System.State": "Active", "System.AssignedTo": "Bob Jones"}'
)
```

---

### H6 — `build_get_logs`: Improve description with step-by-step workflow

**File:** `src/tools/pipelines.ts`  
**Tool:** `build_get_logs`

**Problem:** The current description says "Without logId, returns the list of log files" — which is cryptic. A weak model doesn't understand it must call the tool twice (once to list, once to read).

**Fix:** Update description only (no logic changes):

```typescript
description:
  "Get build logs. Two-step workflow: " +
  "(1) Call WITHOUT logId to get the list of log files for the build — each has an id and a name like 'Initialize job' or 'Run tests'. " +
  "(2) Call WITH the logId you want to read its full content as lines. " +
  "Use startLine/endLine to page through large logs. " +
  "Tip: look for the step where the build failed (non-zero exit code) and fetch that log.",
```

---

### H7 — `pr_list_threads`: Add size guard and strip noisy fields

**File:** `src/tools/repositories.ts`  
**Tool:** `pr_list_threads`

**Problem:** Thread objects include many noisy fields: `threadContext` (file position context), `pullRequestThreadContext` (nested iteration refs), `isDeleted` (always false on list), and the full `properties` bag. On a PR with many comments this can overflow a weak model's context.

**Fix:**

1. After fetching `result.value`, filter each thread through a cleaning function that:
   - Strips `threadContext`, `pullRequestThreadContext`, `isDeleted`, `properties` from each thread
   - Strips `usersLiked` from each comment inside `comments[]`
   - `cleanAdo` already handles `_links`, `url`, and identity flattening — run it after the custom strip
2. Add a size guard: if the final JSON exceeds `MAX_INLINE_RESULT_BYTES` (50 000 bytes), return a summary instead.

**New handler:**
```typescript
async ({ repositoryId, pullRequestId, project }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));
  const cap = boundLimit(undefined, deps.config.maxResults);
  const result = await client.get<{ value?: Array<Record<string, unknown>> }>(
    `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}/threads`,
    { project },
  );

  // Strip per-thread noise that is never useful to the model
  const STRIP_THREAD_KEYS = new Set(["threadContext", "pullRequestThreadContext", "isDeleted", "properties"]);
  const STRIP_COMMENT_KEYS = new Set(["usersLiked"]);

  const threads = (result.value ?? []).slice(0, cap).map((thread) => {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(thread)) {
      if (STRIP_THREAD_KEYS.has(k)) continue;
      if (k === "comments" && Array.isArray(v)) {
        cleaned[k] = v.map((c: Record<string, unknown>) => {
          const cc: Record<string, unknown> = {};
          for (const [ck, cv] of Object.entries(c)) {
            if (STRIP_COMMENT_KEYS.has(ck)) continue;
            cc[ck] = cv;
          }
          return cc;
        });
      } else {
        cleaned[k] = v;
      }
    }
    return cleaned;
  });

  const payload = JSON.stringify(cleanAdo(threads));
  if (Buffer.byteLength(payload, "utf8") > MAX_INLINE_RESULT_BYTES) {
    return textResult(
      `PR #${pullRequestId} has ${threads.length} threads but the payload is too large to return inline. ` +
      `The PR may have many long comments. Try fetching individual thread ids via pr_get.`,
    );
  }
  return textResult(payload);
},
```

Note: `MAX_INLINE_RESULT_BYTES` (50_000) and `cleanAdo` must be imported. `cleanAdo` is already imported in `repositories.ts` via `_shared.ts`. Add `MAX_INLINE_RESULT_BYTES` as a constant in the PR tools section (or import from a shared constant — keep it local to be safe).

---

## MEDIUM Priority Findings

### M1 — `repo_list_branches`: Strip `refs/heads/` prefix

**File:** `src/tools/repositories.ts`  
**Tool:** `repo_list_branches`

**Problem:** ADO returns branch names like `refs/heads/main`. A model asked "what branch is main on?" has to parse the prefix mentally. It often gets confused.

**Fix:** After fetching, map each ref object: if the object has a `name` property starting with `refs/heads/`, emit a new `shortName` field (or replace `name`) with the prefix stripped.

```typescript
const refs = await client.getAll(...);
// Add shortName to each ref for easier model consumption
const withShortName = refs.map((ref) => {
  if (ref && typeof ref === "object" && "name" in ref && typeof (ref as Record<string,unknown>).name === "string") {
    const name = (ref as Record<string, unknown>).name as string;
    return {
      ...(ref as Record<string, unknown>),
      name: name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name,
    };
  }
  return ref;
});
return asCleanText(withShortName);
```

---

### M2 — `repo_list_items`: Append truncation note when result hits cap

**File:** `src/tools/repositories.ts`  
**Tool:** `repo_list_items`

**Problem:** When the `recursionLevel: full` result is sliced to `maxResults`, the model gets a partial list with no indication that it was truncated.

**Fix:** After slicing, if the original length exceeded the cap, append a note to the returned JSON.

```typescript
const allItems = result.value ?? [];
const cap = boundLimit(undefined, deps.config.maxResults);
const sliced = allItems.slice(0, cap);
if (allItems.length > cap) {
  return textResult(
    JSON.stringify(cleanAdo(sliced)) +
    `\n\n[Truncated: showing ${cap} of ${allItems.length} items. Use scopePath to narrow the listing.]`
  );
}
return asCleanText(sliced);
```

---

### M4 — `wiki_create_or_update_page`: Improve eTag description; add auto-fetch option

**File:** `src/tools/wiki.ts`  
**Tool:** `wiki_create_or_update_page`

**Problem:** The description says "pass the eTag returned by wiki_get_page" but doesn't explain what happens if you don't (ADO returns a 412). A weak model doesn't understand it must call `wiki_get_page` first when editing.

**Fix:**

1. Update the description to say: "IMPORTANT: To edit an existing page you MUST call wiki_get_page first to get the eTag, then pass it here. Without eTag, ADO will reject edits to existing pages with a 412 error. Omit eTag only when creating a brand-new page."
2. Update the `eTag` param description: "Version token from wiki_get_page — REQUIRED to edit an existing page, forbidden when creating a new one."
3. (Optional enhancement) If `eTag` is omitted and the page already exists (ADO returns 412), catch it and return a helpful message: "Page already exists. Call wiki_get_page to get the eTag, then retry with eTag set."

```typescript
// Description change:
description:
  "Create or edit a wiki page at a path. " +
  "IMPORTANT: To EDIT an existing page, you must first call wiki_get_page to retrieve its eTag, " +
  "then pass that eTag here — Azure DevOps requires it for optimistic concurrency. " +
  "To CREATE a new page, omit eTag entirely. " +
  "Returns the saved page and its new eTag (save it if you plan to edit again).",

// eTag param:
eTag: z.string().min(1).optional().describe(
  "Page version from wiki_get_page — REQUIRED when editing an existing page, omit when creating new"
),
```

---

### M7 — `repo_get_commit`: Add `changeCount` / `includeChanges` parameter

**File:** `src/tools/repositories.ts`  
**Tool:** `repo_get_commit`

**Problem:** `repo_get_commit` returns commit metadata but not the list of changed files. A model asked "what files changed in commit abc123?" must make a separate call it doesn't know about.

**Fix:** Add an `includeChanges` boolean parameter. When true, add `changeCount=100` to the query string (ADO returns the `changes` array in the commit object when `changeCount > 0`).

```typescript
inputSchema: {
  repositoryId: z.string().min(1).describe("Repository id or name"),
  commitId: z.string().min(1).describe("Commit SHA"),
  project: z.string().min(1).optional().describe("Project name or ID"),
  includeChanges: z.boolean().optional().describe(
    "Include the list of changed files in the response (adds a 'changes' array to each commit)"
  ),
},

async ({ repositoryId, commitId, project, includeChanges }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));
  const query: Record<string, QueryValue> = {};
  if (includeChanges) query["changeCount"] = 100;
  const commit = await client.get(
    `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/commits/${encodeURIComponent(commitId)}`,
    { project, query },
  );
  return asCleanText(commit);
},
```

---

### M8 — `pr_get`: Add size guard

**File:** `src/tools/repositories.ts`  
**Tool:** `pr_get`

**Problem:** A PR with a very long description or many reviewer objects can return a large payload. No size guard exists.

**Fix:** Wrap the return in a size-guard: if the cleaned payload exceeds `MAX_INLINE_RESULT_BYTES` (50 000 bytes), truncate the `description` field (like `wit_get` does with `System.Description`) and try again. If still too large, return metadata only.

```typescript
async ({ repositoryId, pullRequestId, project }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));
  const pr = await client.get<Record<string, unknown>>(
    `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}`,
    { project },
  );
  // Truncate long description to keep payload manageable for small models
  if (pr && typeof pr === "object" && typeof pr["description"] === "string") {
    (pr as Record<string, unknown>)["description"] = truncateField(pr["description"] as string, 2000);
  }
  const cleaned = cleanAdo(pr);
  const payload = JSON.stringify(cleaned);
  if (Buffer.byteLength(payload, "utf8") > MAX_INLINE_RESULT_BYTES) {
    // Return only key fields
    const safe: Record<string, unknown> = {};
    for (const key of ["pullRequestId","title","status","createdBy","creationDate","sourceRefName","targetRefName","mergeStatus","isDraft","reviewers"]) {
      if (pr && key in (pr as object)) safe[key] = cleanAdo((pr as Record<string,unknown>)[key]);
    }
    safe["__truncated"] = true;
    return textResult(JSON.stringify(safe));
  }
  return textResult(payload);
},
```

`MAX_INLINE_RESULT_BYTES`, `cleanAdo`, `truncateField` need to be imported/available. `cleanAdo` and `truncateField` are already exported from `_shared.ts`. Add a local `MAX_INLINE_RESULT_BYTES = 50_000` constant at the top of `repositories.ts` (or import it if it's ever promoted to a shared constant).

---

### M9 — `core_list_projects`: Slim output to essential fields only

**File:** `src/tools/core.ts`  
**Tool:** `core_list_projects`

**Problem:** ADO project objects contain many fields (`capabilities`, `defaultTeam`, `visibility`, `lastUpdateTime`, etc.) that add tokens without informing a model that just needs project names.

**Fix:** After fetching, map to keep only `id`, `name`, `description`, `state`.

```typescript
async ({ top }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));
  const projects = await client.getAll("/_apis/projects", {}, top);
  const slim = (projects as Array<Record<string, unknown>>).map((p) => ({
    id: p["id"],
    name: p["name"],
    description: p["description"],
    state: p["state"],
  }));
  return asCleanText(slim);
},
```

---

### M12 — `adoErrorFromResponse`: Map common TF/VS error codes to readable remediation hints

**File:** `src/azure/errors.ts`  
**Function:** `adoErrorFromResponse()`

**Problem:** ADO error bodies include codes like `TF401495`, `TF400499`, `TF200016`, `VS402335` which pass through as-is in the error message. A weak model sees "TF401495" and has no idea what to do.

**Fix:** After extracting the `message` string, scan it for known TF/VS error codes and append a human-readable hint.

```typescript
/** Map of known TF/VS error code prefixes to remediation hints. */
const ADO_ERROR_HINTS: Array<[RegExp, string]> = [
  [/TF401495/, "The iteration path does not exist in this project. Use work_list_iterations to find valid iteration paths."],
  [/TF400499/, "The team or project was not found. Check the project name and team name with core_list_projects and core_list_teams."],
  [/TF200016/, "The work item type does not exist in this project. Use wit_list_types to see available types."],
  [/VS402335|TF401349/, "Access denied. Your PAT may lack the required scope, or you do not have permission for this operation."],
  [/TF401232/, "The repository was not found. Use repo_list to see available repositories."],
  [/TF401019/, "The branch was not found. Use repo_list_branches to see available branches."],
  [/TF400898/, "Completing this pull request failed because of a policy violation (e.g. required reviewers, linked work items)."],
  [/TF401003|TF401004/, "Authentication failed. Check that your PAT is valid and has not expired."],
  [/TF26027/, "The field reference name is not valid for this work item type. Use wit_list_types or see the ADO field reference name list."],
];

export function adoErrorFromResponse(status: number, bodyText: string): AdoApiError {
  let message = bodyText?.trim() || `HTTP ${status}`;
  let details: unknown = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as { message?: string };
    if (parsed && typeof parsed.message === "string" && parsed.message.length > 0) {
      message = parsed.message;
    }
    details = parsed;
  } catch {
    // body was not JSON — keep the raw text
  }

  // Append a remediation hint when the message contains a known error code
  for (const [pattern, hint] of ADO_ERROR_HINTS) {
    if (pattern.test(message)) {
      message = `${message} — Hint: ${hint}`;
      break;
    }
  }

  return new AdoApiError(status, `Azure DevOps API error ${status}: ${message}`, details);
}
```

---

## LOW Priority Findings

### L4 — Clarify `work_get_current_sprint` vs `work_list_iterations` descriptions

**File:** `src/tools/work.ts`  
**Tools:** `work_get_current_sprint`, `work_list_iterations`

**Problem:** Both tools can return sprint info. `work_get_current_sprint` is the fast path (one sprint, plain text), but `work_list_iterations` is the one that currently also works with `timeframe: current`. The distinction is not obvious.

**Fix:** Description changes only.

```typescript
// work_get_current_sprint
description:
  "Get the name and dates of the CURRENT (active) sprint for a project. Returns a single line. " +
  "Use this to answer 'what sprint are we in?' or 'what is the current sprint?'. " +
  "Falls back to ADO_DEFAULT_PROJECT when no project is given. " +
  "To see ALL sprints (past and future), use work_list_iterations instead.",

// work_list_iterations
description:
  "List a team's iterations (sprints). By default lists ALL iterations (past and future). " +
  "Pass timeframe='current' to return only the active sprint (same as work_get_current_sprint but returns the raw object). " +
  "To just know the current sprint name and dates, prefer work_get_current_sprint — it returns a single clean line.",
```

---

### L5 — `pr_create`: Add optional `reviewers` parameter with name resolution

**File:** `src/tools/repositories.ts`  
**Tool:** `pr_create`

**Problem:** `pr_create` has no `reviewers` parameter. A model asked to "create a PR and add Alice as reviewer" must make a separate `pr_update` call — which doesn't exist — or fail.

**Fix:** Add an optional `reviewers` array of display names. Resolve each name via `client.resolveIdentity()`, then look up the identity's `id` (GUID) using the Identities API (the `uniqueName`/`descriptor` field). ADO's PR create body accepts `reviewers: [{ id: "<identity-id>" }]`.

**Note:** The identity resolution path in `client.resolveIdentity()` returns the canonical display name but not the identity GUID. You need the GUID for the PR body. Check if the raw identity response from `/_apis/identities?searchFilter=General&filterValue=name` returns an `id` field — it does (it's the `subjectDescriptor` or `localId`). Use the `localId` field from the Identities API response as the reviewer `id`.

```typescript
inputSchema: {
  // ... existing fields ...
  reviewers: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Display names of reviewers to add (e.g. ['Alice Smith', 'Bob Jones']). " +
      "Names are resolved to identity GUIDs automatically."
    ),
},

async ({ repositoryId, sourceBranch, targetBranch, title, description, project, reviewers }, extra) => {
  const client = deps.clientFor(patFromExtra(extra));

  // Resolve reviewer names to identity ids (best-effort; unresolved names are skipped)
  const resolvedReviewers: Array<{ id: string }> = [];
  if (reviewers && reviewers.length > 0) {
    for (const name of reviewers) {
      try {
        const result = await client.get<{ value?: Array<Record<string, unknown>> }>(
          "/_apis/identities",
          { query: { searchFilter: "General", filterValue: name } },
        );
        const id = result?.value?.[0]?.["id"] as string | undefined;
        if (id) resolvedReviewers.push({ id });
      } catch {
        // Resolution failure is non-fatal — skip the reviewer
      }
    }
  }

  const body: Record<string, unknown> = {
    sourceRefName: toRefName(sourceBranch),
    targetRefName: toRefName(targetBranch),
    title,
    description,
  };
  if (resolvedReviewers.length > 0) body["reviewers"] = resolvedReviewers;

  const pr = await client.post(
    `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests`,
    body,
    { project },
  );
  return asCleanText(pr);
},
```

---

### L9 — Add `pr_list_mine` (cross-repo PR listing for the current user)

**File:** `src/tools/repositories.ts`  
**New tool:** `pr_list_mine`

**Problem:** `pr_list` requires a `repositoryId`. A model asked "show me my open PRs" doesn't know which repo to query. ADO has a project-level endpoint for this.

**ADO endpoint:**
```
GET {project}/_apis/git/pullrequests?searchCriteria.creatorId={identity-id}&searchCriteria.status=active
```
But `creatorId` requires a GUID. Alternative: `searchCriteria.reviewerId` is also GUID-based.

Better approach: Use the **mine** flag shortcut — ADO supports `searchCriteria.creatorId=@Me` in WIQL, but not on the PR endpoint. Instead, resolve the current user's identity via `/_apis/profile/profiles/me` or use `searchCriteria.creatorId` after resolving `@me`.

Actually the simplest approach: ADO's `GET /_apis/git/pullrequests` (without repo scope) accepts `searchCriteria.creatorId`. But we need the user's id. Use:
```
GET /_apis/profile/profiles/me?api-version=7.1
```
This returns `{ id, displayName, emailAddress, ... }` — use the `id` as `creatorId`.

```typescript
server.registerTool(
  "pr_list_mine",
  {
    description:
      "List YOUR open pull requests across all repositories in a project (or the whole collection). " +
      "Use this to answer 'what PRs do I have open?' without needing to know the repository. " +
      "Falls back to ADO_DEFAULT_PROJECT when no project is given.",
    inputSchema: {
      project: z.string().min(1).optional().describe(
        "Project name or ID; uses ADO_DEFAULT_PROJECT if not given; omit for collection-wide"
      ),
      status: z.enum(PR_STATUS).optional().describe(
        "Filter by PR status: active (default), abandoned, completed, or all"
      ),
      top: z.number().int().positive().max(deps.config.maxResults).optional().describe(
        "Maximum number of pull requests"
      ),
    },
  },
  async ({ project, status, top }, extra) => {
    const client = deps.clientFor(patFromExtra(extra));
    const effectiveProject = project ?? deps.config.defaultProject;
    const cap = boundLimit(top, deps.config.maxResults);

    // Resolve current user identity id
    let creatorId: string | undefined;
    try {
      const profile = await client.get<{ id?: string }>("/_apis/profile/profiles/me", {});
      creatorId = profile?.id;
    } catch {
      // best-effort; if the profile endpoint fails (on-prem), fall through without creatorId
    }

    const query: Record<string, QueryValue> = {
      "searchCriteria.status": status ?? "active",
      $top: cap,
    };
    if (creatorId) query["searchCriteria.creatorId"] = creatorId;

    const result = await client.get<{ value?: unknown[] }>(
      "/_apis/git/pullrequests",
      { project: effectiveProject, query },
    );
    return asCleanText((result.value ?? []).slice(0, cap));
  },
);
```

**Note:** `/_apis/profile/profiles/me` may not work on all ADO Server (on-prem) builds. The tool should still work (without the creator filter) if the profile call fails — it will just return all active PRs in the project. Include a note in the description if needed.

---

### L10 — Already fixed as part of H1

The two-content-block response in `wit_query` is eliminated when H1 is implemented. No separate action needed.

---

## Build & Test Instructions

```bash
# After implementing all changes:
npm run build        # must succeed with no TypeScript errors
npm test             # all tests must pass (target: 206+ tests)
```

Key test files to check/update:
- `tests/unit/work-tools.test.ts` — H2 adds a name-resolution test; update if `work_get_capacity` schema changes
- `tests/unit/work-items-tools.test.ts` — H1 changes `wit_query` behavior; verify flat-query path returns ticket list format
- `tests/unit/repositories-tools.test.ts` — H3 (pr_update_status auto-fetch), H7 (pr_list_threads size guard), M8 (pr_get size guard), L5 (pr_create reviewers), L9 (pr_list_mine)
- `tests/unit/errors.test.ts` (or wherever AdoApiError is tested) — M12 hints

If a test file doesn't exist for a domain, create a minimal one using the same pattern as `work-tools.test.ts` (recordingFetch + fakeServer).

---

## Summary Table

| ID | File | Tool / Function | Change Type |
|----|------|-----------------|-------------|
| H1 | work-items.ts | `wit_query` | Logic: fetch fields for flat queries; single-block output |
| H2 | work.ts | `work_get_capacity` | Logic: accept name, resolve to GUID |
| H3 | repositories.ts | `pr_update_status` | Logic: auto-fetch commitId when completing |
| H4 | test-plans.ts | all 3 testplan tools | Description only |
| H5 | work-items.ts | `wit_create`, `wit_update` | Description only (fields param) |
| H6 | pipelines.ts | `build_get_logs` | Description only |
| H7 | repositories.ts | `pr_list_threads` | Logic: strip noisy fields + size guard |
| M1 | repositories.ts | `repo_list_branches` | Logic: strip refs/heads/ prefix |
| M2 | repositories.ts | `repo_list_items` | Logic: truncation note |
| M4 | wiki.ts | `wiki_create_or_update_page` | Description + optional 412 hint |
| M7 | repositories.ts | `repo_get_commit` | Logic: add `includeChanges` param |
| M8 | repositories.ts | `pr_get` | Logic: size guard + description truncation |
| M9 | core.ts | `core_list_projects` | Logic: slim to 4 fields |
| M12 | errors.ts | `adoErrorFromResponse` | Logic: TF/VS code → hint map |
| L4 | work.ts | `work_get_current_sprint`, `work_list_iterations` | Description only |
| L5 | repositories.ts | `pr_create` | Logic: add `reviewers` param |
| L9 | repositories.ts | new `pr_list_mine` | New tool |
| L10 | — | — | Fixed by H1 |
