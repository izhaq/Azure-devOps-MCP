# Spec: Azure DevOps MCP — Harness Improvement

> Phase 1 output (Specify). **Grounded in the actual repo** (`github.com/izhaq/Azure-devOps-MCP`),
> and reconciled against the source on 2026-06-18. Earlier draft assumptions that proved wrong
> (test runner, `undici`) are corrected inline. Open questions resolved via review interview.

## Guiding Mindset

The local model (Tabnine CLI, air-gapped) is **old and has a small context window**. We are
**not** fixing the model — we improve the **harness** (the tool layer) so a weak model can
still succeed. Two principles govern every decision:

1. **Tool output is part of the prompt.** Every returned token competes with the model's
   working memory. Return only what's needed for the model's *next* decision.
2. **Push hard, error-prone decisions down into the tool, not up to the model.** The harness
   does the WIQL authoring, multi-call composition, curation, identity resolution, and
   error-recovery *for* the model. The correct path should be the *only* path it can take.

Implementer's test: "Would this still work if the model were as dumb and forgetful as
possible?" If not, move more responsibility into the tool.

## Root-Cause Summary (why the current design hurts a weak model)

The existing tools are **thin, low-level REST mirrors** of the Azure DevOps API (deliberately —
they mirror `microsoft/azure-devops-mcp`). That design is fine for a strong model but leaves the
two hardest jobs to the weakest layer: **authoring WIQL** and **composing multiple calls**. Both
observed defects trace directly to that.

### Defect 1 — context overflow → HTTP 400

**Confirmed (review interview): the 400 comes from the Tabnine model/LLM endpoint rejecting an
oversized prompt — not from Azure DevOps.** So the fix lever is token reduction. Largest levers,
in order of impact:

- **Returning every field — including `System.Description` HTML — on each record.** This is the
  dominant cost (often 5–10× a projected record), *bigger* than indentation. `wit_get`
  (`src/tools/work-items.ts`) returns the *entire* work item with no projection default and no
  truncation.
- **No `workitemsbatch` tool exists.** To enrich a list with titles/states the model must call
  `wit_get` N times and pile N full objects into context. This is the likely trigger for the 400
  on "list all open tickets."
- **Pretty-printed JSON everywhere.** `src/tools/_shared.ts` → `asText()` returns
  `JSON.stringify(data, null, 2)`. Indentation + repeated keys add ~30–50% on top. Cheapest,
  lowest-risk fix, but secondary to projection.
- `wit_query` does **not** apply `boundLimit` (it forwards `$top` only if the model supplies it),
  unlike every other list tool.

### Defect 2 — identity / strict-equality matching failure

- `wit_query` takes **raw WIQL authored by the model**. The fragile
  `[System.AssignedTo] = '…'` comparison — which fails against the bilingual (Hebrew+English)
  identity string — is written by the weak model itself.
- There is **no `@Me`, no identity resolution, and no `CONTAINS` default** anywhere.
- Generalizes: any strict `=` on a human-entered / identity field (title/name, tags, area path)
  is equally fragile.

### Already-present patterns we will reuse (don't reinvent)

- **Result capping:** `boundLimit()` in `src/azure/client.ts` + `ADO_MAX_RESULTS`.
- **Size-guard:** `repo_get_file` (`MAX_INLINE_FILE_BYTES`) and `wiki_get_page`
  (`MAX_INLINE_PAGE_BYTES`) already do "payload too big → drop content, return a short message."
- **fields vs `$expand` exclusivity:** already enforced in `wit_get`.

## Objective

Add a **task-level layer** on top of the existing REST tools so a small-context, older model can
list and inspect tickets — including "my tickets" **and tickets assigned to a named teammate** —
reliably, without 400s and without identity-matching failures. **Add, do not replace** the
existing low-level tools.

- **User:** the engineer driving the Tabnine agent in the air-gapped environment.
- **Success:** "list my open tickets" returns only the caller's tickets regardless of bilingual
  identity strings; "list tickets assigned to <name>" resolves the name server-side; listing
  tickets never 400s; output stays compact.

## Tech Stack (confirmed against source)

- **TypeScript / Node ≥ 20** (Dockerfile floor Node 22).
- **`@modelcontextprotocol/sdk`** (`McpServer`, stdio + Streamable HTTP transports).
- **zod** for env + tool input validation.
- **Native `fetch`** (`AzureDevOpsClient` uses the global `fetch`, injectable as `fetchImpl`).
  There is **no `undici` dependency** — the only runtime deps are `@modelcontextprotocol/sdk`
  and `zod`. (An earlier draft listed `undici`; that was incorrect.)
- REST against on-prem Azure DevOps Server, `api-version` 7.1 (configurable), PAT via HTTP Basic.

### Deployment note (air-gapped transfer)

`tsup` does **not** bundle dependencies into `dist/index.js` (verified: running `dist/` without
`node_modules` fails with `Cannot find package 'zod'`). For the air-gapped copy you must either:
- ship `dist/` **plus the production `node_modules`**, or
- add `noExternal` to `tsup.config.ts` so the deps bundle into the single file (recommended —
  simplifies the transfer to one artifact).

## Commands (confirmed)

```
Install (build machine): npm ci
Build:                    npm run build      # → dist/index.js
Run (stdio):             node dist/index.js --stdio
Version / help:          node dist/index.js --version | --help
Test:                    npm test            # vitest run  (161 tests today)
```

## Code Style (from the actual source)

Tools are registered with `server.registerTool(name, { description, inputSchema }, handler)`;
input schemas are inline zod; every handler resolves a client via
`deps.clientFor(patFromExtra(extra))` and wraps output via a `_shared.ts` formatter. Match this
exactly — do not introduce new patterns. Conventions: snake_case tool names; camelCase functions;
bounding via `boundLimit(top, deps.config.maxResults)`; heavy JSDoc citing the MS Learn endpoint;
size-guards via `MAX_INLINE_*_BYTES` constants that drop/truncate content and return a marker.

## Testing Strategy

Runner is **vitest** (`fetchImpl` injectable seam). Test at that seam:

- **WIQL builder (new helper)** — `mine:true` → `@Me`; resolved name → exact `=`; unresolved
  name → `CONTAINS` (not `=`); free-text → `CONTAINS`; correct field projection set.
- **Identity resolution (new client method)** — fake `fetch` asserts the search request shape and
  the CONTAINS fallback when resolution returns nothing.
- **Compact formatters (new in `_shared.ts`)** — fixed input → one compact line per ticket; detail
  path truncates an oversized field with a marker.
- **`workItemsBatch` client method (new)** — fake `fetch` asserts the `{ids, fields}` body, that
  projection excludes `System.Description`, and that >200 ids are chunked.
- **Manual (live, on-prem)** — confirm correct "my tickets", correct "by name", and no 400.

## Boundaries

- **Always:** keep tool output token-shaped (compact, not `JSON.stringify(…, null, 2)`); apply
  field projection on work-item fetches; reuse `boundLimit` and the `MAX_INLINE_*` size-guard
  pattern; match existing `registerTool` / `clientFor` conventions; add tools beside the REST ones.
- **Ask first:** changing any existing tool's public **input** schema; adding a runtime dependency;
  changing auth or transport code.
- **Never:** return `System.Description` HTML untruncated in a list path; emit pretty-printed JSON
  to the model on the list/detail paths; use strict `=` on identity/free-text WIQL; let an
  oversized payload reach the model unguarded; remove or rewrite the low-level REST tools.

## Success Criteria

- [ ] "List my open tickets" returns **only** the caller's tickets, regardless of bilingual
      identity strings, with the model never typing a username (`@Me` server-side).
- [ ] "List tickets assigned to <name>" resolves the display name server-side (exact match when
      resolved, `CONTAINS` fallback otherwise) — the model never hand-writes the identity string.
- [ ] Listing open tickets does **not** trigger a 400 — one composed call, compact output.
- [ ] List output excludes descriptions/relations; the detail path truncates oversized fields.
- [ ] Free-text searches (e.g. by title) default to substring matching.
- [ ] Oversized result sets yield an actionable "refine your query" message.
- [ ] New WIQL-builder, formatter, identity-resolution, and `workItemsBatch` unit tests pass via
      the `fetchImpl` seam.
- [ ] Existing REST tools are unchanged (input schemas) and still pass.

## Resolved Decisions (from review interview, 2026-06-18)

1. **Test runner** — `vitest` (`npm test`). Open question closed.
2. **Source of the 400** — the Tabnine LLM endpoint (prompt too long). Strategy = reduce tokens.
3. **Identity scope** — name→identity resolution for arbitrary teammates is **in scope for v1**
   (not just `@Me`).
4. **Description HTML** — **truncate raw** (no HTML→markdown conversion, no new dependency). A
   trivial tag-strip is permitted as denoising but is not required.
5. **Agent-facing list cap** — default **25**, exposed as `ADO_AGENT_LIST_CAP` so it can be tuned
   in the air gap **without a rebuild**, still hard-bounded by `ADO_MAX_RESULTS`.

## Open Risks (verify live, fail-fast)

- **On-prem `@Me` support** on the 7.1 build — verify with a live query early.
- **On-prem `[System.AssignedTo]` identifier format** — equality usually needs the exact
  `Display Name <unique@name>` or unique name, *not* an arbitrary display substring. If identity
  resolution returns the wrong field, the bilingual bug reappears one layer down. Verify the
  accepted value with one live query before relying on exact match; `CONTAINS` is the safety net.
- **Localized/custom state names** (bilingual env) — the default "open" state set assumes common
  English completed states. Allow an explicit `state` override; verify the process's actual state
  values live.

## Out of Scope

- DB connection / text-to-SQL (separate Database MCP).
- The RAG / organizational knowledge-layer track.
