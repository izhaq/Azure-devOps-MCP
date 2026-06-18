# Harness Improvement — Progress Checklist

Live status for the work in `spec.md` / `plan.md`. Updated as tasks land.

## Phase 0 — Config
- [ ] Task 0: `ADO_AGENT_LIST_CAP` (default 25) in config + `.env.example`

## Phase 1 — Compact output + cap
- [ ] Task 1: `asCompactText` / `asTicketList` / `truncateField` in `_shared.ts` (+ tests)
- [ ] Task 2: `wit_query` applies `boundLimit` (+ tests)

## Phase 2 — Composed list tool + identity
- [ ] Task 3: `workItemsBatch` client method, chunked (+ tests)
- [ ] Task 5: `buildWorkItemQuery` WIQL builder (+ tests)
- [ ] Task 6: `resolveIdentity` client method + CONTAINS fallback (+ tests) — LIVE-VERIFY format
- [ ] Task 4: `wit_list_my_work_items` tool (+ tests)

## Phase 3 — Resilience
- [ ] Task 7: `wit_get` detail size-guard / truncation (+ tests)
- [ ] Task 8: list-path size-guard + "showing N of M" (+ tests)

## Live verification (needs the on-prem server; cannot be done from CI/cloud)
- [ ] `@Me` honored on the on-prem 7.1 build
- [ ] Accepted `[System.AssignedTo]` identifier format (exact-match value)
- [ ] Actual process state values (for the "open" default set)
- [ ] End-to-end: "my open tickets" and "tickets assigned to <name>" — no 400
