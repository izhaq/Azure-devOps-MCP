# Implementation Plan: Azure DevOps MCP — Harness Improvement

> Phase 2–3 output (Plan + Tasks). **Grounded in the actual repo.** Task file paths and function
> names are real. Reconciled with the review interview (2026-06-18): test runner is vitest;
> name→identity resolution is in-scope v1; description HTML is truncated raw; the list cap is an
> env var. Live progress is tracked in `tasks/harness-improvement/todo.md`.

## Overview

Add a task-level layer over the existing low-level REST tools so a small-context, older model can
list and inspect tickets reliably. Work proceeds as vertical slices, lowest-risk/highest-value
first (formatter swap + cap fix), then the composed list tool with server-side identity handling,
then the size-guards. **Existing REST tools' input schemas are not modified**; `wit_query` gains a
cap and `wit_get` routes through a size-guarded formatter (output-only change).

## Architecture Decisions

- **Add, don't replace.** New task-level tool `wit_list_my_work_items` sits beside `wit_query` /
  `wit_get`. The REST tools remain for power use.
- **Compose server-side.** The new tool runs WIQL → ids → `workItemsBatch` projection in one tool
  call, so the model never does N× `wit_get` or hand-writes WIQL.
- **Projection at the batch.** WIQL returns only ids; the heavy payload comes from the batch fetch,
  so projection (`System.Id, System.Title, System.State, System.AssignedTo, System.WorkItemType`)
  is applied there. `workItemsBatch` cannot combine `fields` with `$expand=relations` — the thin
  list never needs relations, so this is fine.
- **Compact output by default.** New `asCompactText` / `asTicketList` for list/detail paths;
  `asText` stays for create/update/etc.
- **Identity handled in the harness.** `mine` → WIQL `@Me`. A named `assignedTo` is **resolved via
  the Identity API** to a canonical value (exact `=`); if resolution yields nothing, fall back to
  `CONTAINS` so the tool never errors. Free-text fields default to `CONTAINS`.
- **Tunable cap.** `ADO_AGENT_LIST_CAP` (default 25) bounds the new list tool, itself bounded by
  `maxResults`. Tunable without rebuild for the air gap.
- **Reuse existing safety patterns.** `boundLimit` for caps; the `MAX_INLINE_*` size-guard.

## Task List

### Phase 1: Compact Output + cap (foundation, server-wide token win)

#### Task 1: Add compact formatters to `src/tools/_shared.ts`
`asCompactText(data)` (compact JSON, no pretty-print), `asTicketList(items, meta)` (one line per
ticket: id, type, title, state, assignee + a "showing N of M" line), and a `truncateField` helper.
Keep `asText`.
- [ ] Compact output has no pretty-print indentation.
- [ ] `asTicketList` renders one line per ticket and a count line.
**Files:** `src/tools/_shared.ts`, `tests/*`  •  **Scope:** S

#### Task 2: Fix `wit_query` to apply `boundLimit`
Cap via `boundLimit(top, deps.config.maxResults)` like every other list tool.
- [ ] Bounds to `min(top ?? maxResults, maxResults)` with and without `top`.
**Files:** `src/tools/work-items.ts`, `tests/*`  •  **Scope:** XS

### Phase 2: Composed list tool + identity (the headline feature)

#### Task 3: Add `workItemsBatch` to `AzureDevOpsClient`
`POST /_apis/wit/workitemsbatch` taking `{ ids, fields }`, returning projected items; chunk ids at
ADO's 200-id limit.
- [ ] Sends `{ids, fields}`; `fields` excludes `System.Description`; chunks >200 ids.
**Files:** `src/azure/client.ts`, `tests/*`  •  **Scope:** M

#### Task 5: WIQL builder helper (`src/shared/wiql.ts`)
`buildWorkItemQuery({ mine, assignedTo, states, allStates, titleContains })`. `@Me` when `mine`;
exact `=` for a resolved `assignedTo`, `CONTAINS` when unresolved; `CONTAINS` for `titleContains`;
states default to an "open" `NOT IN (...)` set, overridable; quotes escaped. Never strict `=` on
unresolved human-entered fields.
- [ ] Unit tests across field types and the resolved/unresolved branch.
**Files:** `src/shared/wiql.ts`, `tests/*`  •  **Scope:** S

#### Task 6: Name→identity resolution (now REQUIRED for v1)
`resolveIdentity(name)` on the client (Identity API search). Returns canonical value or
`undefined`. The tool uses it to pick exact-vs-CONTAINS. Best-effort: any failure → `undefined` →
CONTAINS fallback (tool never throws on resolution).
- [ ] Unit test asserts the search request shape and the no-match fallback.
- [ ] **Live fail-fast:** verify the accepted on-prem `AssignedTo` identifier format.
**Files:** `src/azure/client.ts`, `src/tools/work-items.ts`, `tests/*`  •  **Scope:** M

#### Task 4: Add `wit_list_my_work_items` (consumes 1, 3, 5, 6)
Params: `mine?`, `assignedTo?`, `state?` (default "open"; "all"; or explicit), `titleContains?`,
`project?`, `top?`. Resolve identity if `assignedTo` given → build WIQL → run wiql endpoint →
collect ids → `workItemsBatch` projection → `asTicketList` with "showing N of M".
- [ ] One tool call returns a compact list; no per-item `wit_get`.
- [ ] `mine` → `@Me`; default cap = `ADO_AGENT_LIST_CAP`, bounded by `maxResults`.
**Files:** `src/tools/work-items.ts`, `tests/*`  •  **Scope:** M

### Phase 3: Resilience (size-guards)

#### Task 7: Size-guard `wit_get` detail output
Route `wit_get` through `asCompactText`; **truncate raw** `System.Description` (and any long
field) with a marker; if the serialized item still exceeds `MAX_INLINE_*`, drop content and return
a short message. No HTML→markdown conversion (per decision); a trivial tag-strip is optional.
- [ ] Long fields truncated with marker; oversized detail returns a message, not a dump.
**Files:** `src/tools/work-items.ts`, `src/tools/_shared.ts`, `tests/*`  •  **Scope:** M

#### Task 8: List-path size-guard + explicit continuation
The list tool always states its cap ("showing N of M — refine or paginate"); if even the thin list
would exceed budget, return a short "narrow your filter" message.
- [ ] Continuation line always present; oversize thin list → instructive message.
**Files:** `src/tools/work-items.ts`, `tests/*`  •  **Scope:** S

### Config / docs

#### Task 0: `ADO_AGENT_LIST_CAP`
Add to `src/config.ts` (default 25) and `ServerConfig`; document in `.env.example`.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `@Me` not honored on on-prem 7.1 | Med | Verify early with a live query (fail-fast) |
| On-prem `AssignedTo` identifier format differs from resolved value | Med | Verify live; `CONTAINS` fallback keeps the tool working |
| Localized/custom state names (bilingual env) | Med | `state` override; verify process states live |
| `workItemsBatch` 200-id limit / shape differs on-prem | Low | Chunk ids; assert shape in Task 3 test |
| Changing `wit_get` output breaks consumers | Low | Output-only change; input schema unchanged; existing tests don't parse its body |

## Parallelization

- **Parallel:** Task 1, Task 3, Task 5, Task 6 are mutually independent.
- **Sequential:** Task 4 needs 1, 3, 5, 6; Tasks 7–8 need 1 (and 8 needs 4).
- **Coordinate:** `ADO_AGENT_LIST_CAP` (Task 0) is shared by Tasks 4 and 8 — set once.
