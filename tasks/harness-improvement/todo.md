# Harness Improvement — Progress Checklist

Live status for the work in `spec.md` / `plan.md`. Updated as tasks land.

## Phase 0 — Config
- [x] Task 0: `ADO_AGENT_LIST_CAP` (default 25) in config + `.env.example` (+ test)

## Phase 1 — Compact output + cap
- [x] Task 1: `asCompactText` / `asTicketList` / `truncateField` in `_shared.ts` (+ tests)
- [x] Task 2: `wit_query` applies `boundLimit` (+ tests)

## Phase 2 — Composed list tool + identity
- [x] Task 3: `workItemsBatch` client method, chunked at 200 (+ tests)
- [x] Task 5: `buildWorkItemQuery` WIQL builder (+ tests)
- [x] Task 6: `resolveIdentity` client method + CONTAINS fallback (+ tests) — LIVE-VERIFY format
- [x] Task 4: `wit_list_my_work_items` tool (+ tests)

## Phase 3 — Resilience
- [x] Task 7: `wit_get` detail size-guard / raw-description truncation (+ tests)
- [x] Task 8: list-path size-guard + "showing N of M" (+ tests)

## Status
- All 8 tasks implemented. Test suite: **190 passing** (was 161; +29 new). typecheck + lint + build clean.
- MCP `tools/list` now exposes `wit_list_my_work_items`.

## Live verification (needs the on-prem server; cannot be done from CI/cloud)
- [ ] `@Me` honored on the on-prem 7.1 build
- [ ] Accepted `[System.AssignedTo]` identifier format (exact-match value) — confirms whether
      CONTAINS-on-canonical (current approach) is right, or strict `=` is viable
- [ ] `/_apis/identities` route/version exists on this build (else `resolveIdentity` always
      falls back to CONTAINS on raw input — still functional)
- [ ] Actual process state values (for the "open" default `NOT IN (...)` set, bilingual env)
- [ ] End-to-end via the agent: "my open tickets" and "tickets assigned to <name>" — no 400
