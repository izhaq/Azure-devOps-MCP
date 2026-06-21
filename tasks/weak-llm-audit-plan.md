# Implementation Plan: Weak-LLM Audit Fixes

> Source spec: `docs/weak-llm-audit-implementation-spec.md`
> Branch: `fix/bundle-undici` (or a new branch off it)
> Workflow: HIGH → MEDIUM → LOW. Build + test after every phase.

## Overview

Fix 17 findings (H1–H7, M1–M2, M4, M7–M9, M12, L4–L5, L9; L10 is auto-fixed by H1) that make the MCP tool responses hard for a small/weak LLM to use. Most changes are isolated per-tool edits: tighter descriptions, output slimming, size guards, name→GUID resolution, and one new tool. The shared formatters in `src/tools/_shared.ts` already exist and must NOT be re-implemented.

## Architecture Decisions

- **Keep changes additive and local.** No changes to the REST client, transport, or auth model. Each finding touches one tool (or one shared error function).
- **Single-content-block responses.** Weak MCP clients choke on multi-block results; merge any "cap" notes into the text (H1/L10).
- **Reuse existing helpers** from `_shared.ts`: `cleanAdo`, `asCleanText`, `asTicketList`, `textResult`, `truncateField`, and `LIST_FIELDS`/`MAX_INLINE_RESULT_BYTES` from `work-items.ts` (re-declare the 50 000-byte constant locally in `repositories.ts`, matching the spec).
- **Graceful degradation for uncertain on-prem endpoints** (L5 reviewer-id, L9 `/profiles/me`): never let a best-effort resolution failure break the tool.
- **`repositories.ts` is the hot file** (8 of 17 findings). Edit it in a deliberate order to avoid churn; add the shared imports (`cleanAdo`, `truncateField`, `textResult`, `MAX_INLINE_RESULT_BYTES`) once.

## Test Harness Prerequisite (important)

The current `recordingFetch` helper (in each `tests/unit/*-tools.test.ts`) returns **one static body for every call**. These findings make **two sequential REST calls** inside one handler and need different responses per call:

- H1 `wit_query` flat path: WIQL POST → `workItemsBatch` POST
- H2 `work_get_capacity` by name: list iterations GET → capacities GET
- H3 `pr_update_status` complete: `pr_get` GET → status PATCH
- L5 `pr_create` with reviewers: identity GET(s) → PR POST
- L9 `pr_list_mine`: profile GET → pullrequests GET

**Decision:** Add a small queued-response variant (e.g. `recordingFetchSeq([body1, body2, …])`) to the affected test files, returning each body in order and repeating the last one. This is Task 0 and unblocks the logic tasks above.

## Task List

### Phase 0: Test harness

- [ ] **Task 0 — Queued-response test fetch helper.**
  - Add `recordingFetchSeq(bodies: unknown[], status?)` (returns bodies in call order, repeating the last) alongside the existing `recordingFetch` in `tests/unit/work-tools.test.ts` and `tests/unit/pull-requests-tools.test.ts` (and `work-items-tools.test.ts` if H1 lives there).
  - **Acceptance:** a test can assert two calls with two different bodies.
  - **Verification:** `npm test` still green (helper unused by existing tests).
  - **Dependencies:** None. **Scope:** S (2–3 test files).

### Phase 1: HIGH findings

- [ ] **Task 1 — H1 `wit_query` returns field data for flat queries; single block.** (`src/tools/work-items.ts`)
  - Detect flat query (`result.workItems` is an array): extract ids, `client.workItemsBatch(ids, LIST_FIELDS)`, return `asTicketList(ordered, { total })`. Merge cap into `meta.total`.
  - Hierarchical query (`workItemRelations`): return single `textResult` of cleaned JSON + inline cap note.
  - Update the description per spec (point to `wit_list_my_work_items`).
  - **Acceptance:** flat query returns ticket-list text (one line per item); no second content block; hierarchical query returns one block.
  - **Verification:** `npm test -- work-items`; build + typecheck + lint.
  - **Dependencies:** Task 0. **Scope:** S. **Also closes L10.**

- [ ] **Task 2 — H2 `work_get_capacity` accepts iteration name.** (`src/tools/work.ts`)
  - Change `iterationId` to `z.string().min(1)`; update description. In handler: GUID regex test; if not a GUID, list iterations and match by name (case-insensitive); throw descriptive error if no match. Use `effectiveProject = project ?? deps.config.defaultProject`.
  - **Acceptance:** GUID input still makes one call; a name makes two calls (list + capacities); unknown name throws the spec'd message.
  - **Verification:** `npm test -- work-tools`; existing GUID tests still pass; build + lint.
  - **Dependencies:** Task 0. **Scope:** S.

- [ ] **Task 3 — H3 `pr_update_status` auto-fetches `lastMergeSourceCommitId`.** (`src/tools/repositories.ts`)
  - Remove the up-front throw. When `status === "completed"` and no commit id, `pr_get` to read `lastMergeSourceCommit.commitId`; throw only if still missing. Update the param description.
  - **Acceptance:** completing without a commit id makes a GET then a PATCH with `lastMergeSourceCommit`; existing "completing with id" test still passes (one PATCH).
  - **Verification:** `npm test -- pull-requests`. ⚠️ The existing test "rejects completing without a source commit id (no REST call made)" must be **updated** (behavior intentionally changes to auto-fetch).
  - **Dependencies:** Task 0. **Scope:** S.

- [ ] **Task 4 — H4 test-plan description hints.** (`src/tools/test-plans.ts`)
  - Update the 3 tool descriptions with the "Step N of 3" chain text. No logic.
  - **Acceptance:** descriptions contain the chain hints. **Verification:** build + `npm test -- test-plans`. **Scope:** XS.

- [ ] **Task 5 — H5 `wit_create`/`wit_update` field reference examples.** (`src/tools/work-items.ts`)
  - Expand the `fields` `.describe()` strings with the common ADO reference names. No logic.
  - **Acceptance:** both descriptions list `System.*` / `Microsoft.VSTS.*` examples. **Verification:** build + `npm test -- work-items`. **Scope:** XS.

- [ ] **Task 6 — H6 `build_get_logs` two-step description.** (`src/tools/pipelines.ts`)
  - Update description only. **Acceptance:** description spells out (1) list, (2) read-by-logId. **Verification:** build + `npm test -- pipelines`. **Scope:** XS.

- [ ] **Task 7 — H7 `pr_list_threads` strip noise + size guard.** (`src/tools/repositories.ts`)
  - Strip `threadContext`, `pullRequestThreadContext`, `isDeleted`, `properties` per thread and `usersLiked` per comment; run `cleanAdo`; if payload > `MAX_INLINE_RESULT_BYTES` return a summary `textResult`.
  - Add imports (`cleanAdo`, `textResult`) and a local `MAX_INLINE_RESULT_BYTES = 50_000` to `repositories.ts` (shared with M8).
  - **Acceptance:** stripped keys absent from output; oversize payload returns the summary string.
  - **Verification:** `npm test -- pull-requests`; build + lint. **Scope:** S.

### Checkpoint: HIGH complete
- [ ] `npm run build && npm run typecheck && npm run lint && npm test` all green.

### Phase 2: MEDIUM findings (mostly `repositories.ts`)

- [ ] **Task 8 — M1 `repo_list_branches` strip `refs/heads/`.** (`src/tools/repositories.ts`)
  - Map each ref's `name` to the short name before `asCleanText`.
  - **Acceptance:** `main` instead of `refs/heads/main`. **Verification:** `npm test -- repositories`. **Scope:** S.

- [ ] **Task 9 — M2 `repo_list_items` truncation note.** (`src/tools/repositories.ts`)
  - When `allItems.length > cap`, return `textResult(JSON + "[Truncated: showing N of M …]")`.
  - **Acceptance:** truncation note present only when over cap. **Verification:** `npm test -- repositories`. **Scope:** S.

- [ ] **Task 10 — M7 `repo_get_commit` `includeChanges` param.** (`src/tools/repositories.ts`)
  - Add boolean `includeChanges`; when true add `changeCount=100` to the query.
  - **Acceptance:** query carries `changeCount=100` only when true. **Verification:** `npm test -- repositories`. **Scope:** S.

- [ ] **Task 11 — M8 `pr_get` size guard + description truncation.** (`src/tools/repositories.ts`)
  - Truncate `description` via `truncateField(..., 2000)`; if cleaned payload > `MAX_INLINE_RESULT_BYTES`, return key fields only with `__truncated: true`.
  - Add `truncateField` import (reuse the local constant from Task 7).
  - **Acceptance:** normal PR returns full object; oversized returns the slim key-field set. **Verification:** `npm test -- pull-requests`. **Scope:** S. **Dependency:** Task 7 (shared constant/import).

- [ ] **Task 12 — M9 `core_list_projects` slim to 4 fields.** (`src/tools/core.ts`)
  - Map to `{ id, name, description, state }`.
  - **Acceptance:** output objects have only those 4 keys. **Verification:** `npm test -- core`. ⚠️ Check/update `core-tools.test.ts` if it asserts full passthrough. **Scope:** S.

- [ ] **Task 13 — M4 `wiki_create_or_update_page` description + optional 412 hint.** (`src/tools/wiki.ts`)
  - Strengthen tool + `eTag` descriptions per spec. (Optional) catch a 412 and return the "call wiki_get_page first" hint.
  - **Acceptance:** description states eTag is required to edit. **Verification:** `npm test -- wiki`. **Scope:** XS–S.

- [ ] **Task 14 — M12 error-code remediation hints.** (`src/azure/errors.ts`)
  - Add the `ADO_ERROR_HINTS` table; append a hint when the message matches a known TF/VS code.
  - **Acceptance:** `TF401495`-style message gets `— Hint: …` appended; unknown codes unchanged.
  - **Verification:** add cases to `tests/unit/azure-client.test.ts` (where `AdoApiError` is already tested); `npm test`. **Scope:** S.

### Checkpoint: MEDIUM complete
- [ ] Full build + typecheck + lint + test green.

### Phase 3: LOW findings

- [ ] **Task 15 — L4 sprint/iteration description clarity.** (`src/tools/work.ts`)
  - Update `work_get_current_sprint` and `work_list_iterations` descriptions. No logic.
  - **Acceptance:** each description points to the other appropriately. **Verification:** `npm test -- work-tools`. **Scope:** XS.

- [ ] **Task 16 — L5 `pr_create` optional `reviewers`.** (`src/tools/repositories.ts`)
  - Add optional `reviewers: string[]`; resolve each via the Identities API; push `{ id }` into the PR body; unresolved names are skipped (non-fatal).
  - **Acceptance:** with reviewers, body includes `reviewers:[{id}]`; resolution failure does not throw; without the param, body unchanged.
  - **Verification:** `npm test -- pull-requests` (use queued fetch). ⚠️ **Risk:** the reviewer identity `id` field shape is unverified on on-prem — keep resolution best-effort and test only the request-shaping, not live behavior. **Scope:** S. **Dependency:** Task 0.

- [ ] **Task 17 — L9 new `pr_list_mine` tool.** (`src/tools/repositories.ts`)
  - Register a project/collection-level PR list; best-effort `/_apis/profile/profiles/me` for `creatorId`; if it fails, list all active PRs. Bound by cap.
  - **Acceptance:** registered tool; works with and without a resolvable profile; capped output.
  - **Verification:** add to the registered-tools list assertion in `pull-requests-tools.test.ts`; `npm test -- pull-requests`. ⚠️ **Risk:** `/profiles/me` may not exist on all on-prem builds — degrade gracefully (no creator filter). **Scope:** S–M. **Dependency:** Task 0.

- [ ] **Task 18 — L10.** No action — closed by Task 1 (H1). Verify no second content block remains in `wit_query`.

### Checkpoint: Complete
- [ ] `npm run build && npm run typecheck && npm run lint && npm test` — all green (target 206+ tests).
- [ ] Manual: spot-check 2–3 tool descriptions render the new guidance.
- [ ] Ready for review.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Test harness only returns one body per call | High (blocks H1/H2/H3/L5/L9 tests) | Task 0 adds a queued-response helper first |
| H3 changes behavior the existing test asserts ("no REST call made") | Med | Explicitly update that test to expect auto-fetch |
| L5 reviewer `id` field shape unverified on on-prem | Med | Best-effort resolution; skip unresolved; test request-shaping only |
| L9 `/profiles/me` may 404 on on-prem | Med | Fall back to unfiltered active PRs; document the limitation |
| M9/M12 may break existing passthrough assertions | Low | Check & update `core-tools.test.ts` and `azure-client.test.ts` |
| `repositories.ts` touched by 8 tasks | Low | Add shared imports/constant once (Task 7); order edits |

## Open Questions

- Confirm H1 `wit_query` tests live in `work-items-tools.test.ts` (extend it) vs a new file.
- Confirm the L5/L9 best-effort on-prem behavior is acceptable to ship without a live ADO check (spec already flags both as best-effort).
