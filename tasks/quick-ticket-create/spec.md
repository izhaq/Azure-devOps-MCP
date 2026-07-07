# Spec: Weak-LLM-friendly ticket creation

> Confirmed via interview (this session). Small, self-contained feature on top
> of the existing `work-items` domain. Fixes real friction: creating a
> task/bug asks for too much, sometimes returns no link, and title-search
> misfires — so users bail to the web UI.

## Problems (observed) → causes (verified in code)

1. **Over-asked for optional fields.** `wit_create` requires `project` (no
   default) and its `fields` description is a long menu that a weak model reads
   as a checklist to collect.
2. **"Task completed" but no ticket link.** `wit_create` → `formatWorkItemDetail`
   → `cleanAdo`, which **strips `_links` and `url`** — the ticket's web link
   (`_links.html.href`) is deleted before the model sees it. Root of the trust
   problem ("did it even create it?").
3. **Title search gets stuck.** The model used raw `wit_query` with
   `[System.Title] = '…'` (exact). `wit_search` already does `CONTAINS` and is
   the right tool — it just wasn't chosen.
4. **Required fields can block creation** with no guidance on valid values.

## Design (confirmed)

### `wit_create` — reshaped, two speeds

Minimal input: **`type` + `title`**. Everything else optional.

- `project?` → defaults to `ADO_DEFAULT_PROJECT`.
- `assignedTo?` → defaults to **@Me** (the authenticated user, resolved via
  `connectionData`); best-effort — if resolution fails, create unassigned.
- `description?`, `parent?` (a work-item id → adds a Hierarchy-Reverse link),
  and `fields?` (advanced escape hatch: any reference-name → value map).
- `guided?: boolean`:
  - **false (default) = FAST:** create now; auto-fill required-but-missing
    fields (ADO defaults area/iteration to project root; other required fields
    with a picklist get their `defaultValue` or first allowed value); return a
    **compact confirmation** `{ id, type, title, state, assignedTo, webUrl }`.
    If a required field still can't be filled, return a clear error naming it
    and suggesting guided mode.
  - **true = SLOW/guided:** do **not** create. Return the create "form": the
    type's required fields + a curated common set (Area, Iteration, AssignedTo,
    Priority, Parent), each as `{ field, name, required, allowedValues?,
    default }`. The **agent** presents these, accepts Enter→default, then calls
    `wit_create` (fast) with the chosen values. (MCP tools can't prompt mid-call;
    the agent drives the Q&A — the tool just returns the form and fills blanks.)

### `wit_create` / `wit_get` — always return the web link (Fix A)

Extract `webUrl` from `_links.html.href` (fallback: construct
`{server}/{collection}/{project}/_workitems/edit/{id}`) **before** `cleanAdo`
strips `_links`, and surface it in the result.

### `wit_query` — steer to `wit_search` for title lookups (Fix D)

Add to the description: for finding items by title/text, prefer `wit_search`
(substring), not a hand-written `[System.Title] = …`.

## New client methods

- `getAuthenticatedIdentity()` → `GET {collection}/_apis/connectionData`,
  returns the authenticated user's `providerDisplayName` (server's canonical
  spelling — robust for the bilingual env). Cached per client; best-effort.
- `getWorkItemTypeFields(project, type)` →
  `GET {project}/_apis/wit/workitemtypes/{type}/fields?$expand=allowedValues`,
  returns `[{ referenceName, name, alwaysRequired, allowedValues?, defaultValue? }]`.

## Config

No new keys. Reuses `ADO_DEFAULT_PROJECT`.

## Testing (fetchImpl seam, vitest)

- Fast create: routed fetch (connectionData → create); assert the JSON-Patch
  body sets Title, defaults AssignedTo to the resolved @Me, defaults project,
  and that the result includes `webUrl` from `_links.html.href`.
- Guided create: returns the form (required fields + allowedValues + defaults),
  makes **no** create POST.
- Parent link: adds the Hierarchy-Reverse relation op.
- Required-field auto-fill + the "still missing required" error path.
- `wit_get`: result carries `webUrl`.
- Assignee resolution failure → create proceeds unassigned (no throw).

## Boundaries

- **Always:** minimal input (title-only works); return the web link; default
  assignee @Me; compact confirmation; keep existing low-level `fields` escape
  hatch.
- **Ask first:** changing other tools' schemas; new dependency (none).
- **Never:** drop the ticket link from create/get output; block creation on a
  required field without naming it and offering guided mode.

## Success criteria

- [ ] `wit_create(type, title)` creates a ticket assigned to me and returns a
      clickable `webUrl` + id.
- [ ] `guided:true` returns a field form (with allowedValues/defaults) and does
      not create.
- [ ] Required fields are auto-filled in fast mode, or named clearly if not.
- [ ] `wit_get` returns `webUrl`.
- [ ] `wit_query` steers title lookups to `wit_search`.
- [ ] Tests pass at the fetchImpl seam; coverage thresholds met; bundle rebuilt.

## Live-verify (human, on-prem)

- Exact `connectionData` / `workitemtypes/{type}/fields` shapes on the 7.1 build.
- That `providerDisplayName` is accepted as a `System.AssignedTo` create value.
- Which fields your process marks `alwaysRequired` (drives auto-fill/guided).
