# Implementation Plan: Weak-LLM Audit Batch 3

## Overview

8 changes across 5 source files: slim 3 overweight responses (`pipeline_get`, `build_queue`, `work_list_iterations`), tighten 1 more (`wit_add_comment`), add 1 new tool (`wit_search`), add 1 new param (`pr_list` sourceBranch), and fix 3 descriptions (`wit_get`, `core_list_projects`, `core_list_teams`). All changes are independent — no shared state, no migration, no dependency order between items.

Spec: `docs/weak-llm-audit-batch3-spec.md`

## Architecture Decisions

- **wit_search reuses `buildWorkItemQuery` with `mine: false`** — avoids duplicating WIQL construction, keeps parity with `wit_list_my_work_items`
- **pipeline_get defaults to slim** — `includeConfiguration` opt-in pattern matches wiki's `showSubSections` precedent; safe default protects weak models from large config payloads
- **No new test file** — all new tests go into the existing per-domain test files

## Dependency Graph

All tasks are independent. No task depends on another.

```
T1 (pipeline_get slim)      ──┐
T2 (build_queue slim)       ──┤
T3 (work_list_iterations)   ──┤─→ Build passes → PR
T4 (wit_add_comment slim)   ──┤
T5 (wit_search new tool)    ──┤
T6 (pr_list sourceBranch)   ──┤
T7 (description fixes ×3)   ──┘
```

## Tasks

### Phase 1: Response Slimming (HIGH priority)

- [ ] T1: `pipeline_get` — slim default + `includeConfiguration` flag
- [ ] T2: `build_queue` — slim to `{id, buildNumber, status, queueTime, definition}`
- [ ] T3: `work_list_iterations` — slim to `{id, name, path, startDate, finishDate, timeFrame}`
- [ ] T4: `wit_add_comment` — slim to `{id, workItemId, createdDate}`

### Checkpoint: Phase 1

- [ ] `npm test` passes (existing + new tests for T1–T4)
- [ ] `npm run build` emits `dist/index.js` cleanly

### Phase 2: New Tool + Param (HIGH / MEDIUM)

- [ ] T5: `wit_search` — new tool, full two-call implementation + tests
- [ ] T6: `pr_list` — add `sourceBranch` param + test

### Checkpoint: Phase 2

- [ ] `npm test` passes (all tests including T5–T6)

### Phase 3: Description Fixes (MEDIUM / cosmetic)

- [ ] T7a: `wit_get` description — note fields/expand mutual exclusivity
- [ ] T7b: `core_list_projects` description — add chaining hint
- [ ] T7c: `core_list_teams` description — add chaining hint

### Checkpoint: Complete

- [ ] All tests pass
- [ ] Build clean
- [ ] Commit and push `fix/weak-llm-audit-batch3`

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `wit_search` two-call fake-fetch setup differs from single-call tools | Med | Copy the multi-response setup pattern from existing `wit_list_my_work_items` tests |
| `pipeline_get` — real ADO might not return `configuration` for all pipeline types | Low | Guard with `config?.["type"]` optional chaining (already in spec) |
| `work_list_iterations` date slice — `startDate` may be null/undefined | Low | `?.slice(0, 10)` handles undefined; spec already uses optional chaining |
