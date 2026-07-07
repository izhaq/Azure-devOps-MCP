import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";
import { boundLimit } from "../azure/client.js";
import { toPreviewVersion } from "../shared/api-version.js";
import { buildWorkItemQuery } from "../shared/wiql.js";
import { asCleanText, asTicketList, cleanAdo, truncateField, textResult } from "./_shared.js";

/** Compact projection for the task-level list path — excludes the heavy HTML description. */
const LIST_FIELDS = [
  "System.Id",
  "System.Title",
  "System.State",
  "System.AssignedTo",
  "System.WorkItemType",
  "System.CreatedBy",
];

/** Truncate `System.Description` (raw HTML) in the detail path; see Defect 1. */
const MAX_DESCRIPTION_CHARS = 2000;
/**
 * Inline payload budget for the compact paths. If a serialized work item or a
 * rendered list exceeds this, return a short marker instead of the content.
 * Measured in UTF-8 bytes (via `Buffer.byteLength`) to match the size-guard
 * convention in `repositories.ts` / `wiki.ts` and to count multibyte
 * (e.g. Hebrew) content correctly.
 */
const MAX_INLINE_RESULT_BYTES = 50_000;

/** Top-level work item fields that are pure ADO internals — never useful to the model. */
const STRIP_WIT_TOP_LEVEL = new Set(["rev", "commentVersionRef"]);

/**
 * Format a single work item for the detail path:
 * - Strip top-level noise fields (rev, commentVersionRef).
 * - Truncate ALL HTML-containing fields in `fields` (not just System.Description —
 *   ReproSteps, SystemInfo, History, etc. are equally verbose raw HTML).
 * - Apply cleanAdo (strips _links, flattens identities).
 * - Size-guard at 50 KB; return an actionable message if exceeded.
 */
function formatWorkItemDetail(item: unknown): ReturnType<typeof textResult> {
  let shaped: unknown = item;
  if (item && typeof item === "object" && "fields" in item) {
    const raw = item as Record<string, unknown>;

    // Strip top-level noise, keep everything else
    const top: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!STRIP_WIT_TOP_LEVEL.has(k)) top[k] = v;
    }

    // Surface the web link BEFORE cleanAdo strips `_links`: `_links.html.href`
    // is the clickable ticket URL the user expects. (cleanAdo keeps `webUrl`.)
    const htmlHref = (raw["_links"] as { html?: { href?: string } } | undefined)?.html?.href;
    if (typeof htmlHref === "string") top["webUrl"] = htmlHref;

    // Truncate every field whose value looks like HTML (contains an opening tag).
    // This catches System.Description, ReproSteps, SystemInfo, History, etc.
    const fields = { ...(raw.fields as Record<string, unknown> | undefined) };
    for (const [key, val] of Object.entries(fields)) {
      if (typeof val === "string" && val.includes("<") && val.length > MAX_DESCRIPTION_CHARS) {
        fields[key] = truncateField(val, MAX_DESCRIPTION_CHARS);
      }
    }

    shaped = { ...top, fields };
  }
  const cleaned = cleanAdo(shaped);
  const bytes = Buffer.byteLength(JSON.stringify(cleaned), "utf8");
  if (bytes > MAX_INLINE_RESULT_BYTES) {
    const id = (item as { id?: number } | null)?.id;
    return textResult(
      `Work item ${id ?? "?"} is too large to return inline (${bytes} bytes). ` +
        `Re-fetch only the fields you need via wit_get's "fields" argument, ` +
        `e.g. ["System.Title","System.State","System.AssignedTo"].`,
    );
  }
  return textResult(JSON.stringify(cleaned));
}

/**
 * work-items domain: query, read, create, update, comment, and type metadata.
 * Endpoints (Azure DevOps Server, api-version configurable):
 *   POST  {project}/_apis/wit/wiql                      (WIQL query, GA)
 *   GET   {collection}/_apis/wit/workitems/{id}         (GA)
 *   POST  {project}/_apis/wit/workitems/${type}         (GA, JSON-Patch)
 *   PATCH {collection}/_apis/wit/workitems/{id}         (GA, JSON-Patch)
 *   POST  {project}/_apis/wit/workItems/{id}/comments   (preview)
 *   GET   {project}/_apis/wit/workitemtypes             (GA)
 * Source: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit (api-version 7.1)
 */

const JSON_PATCH = "application/json-patch+json";

interface JsonPatchOp {
  op: "add";
  path: string;
  value: unknown;
}

/** Turn a flat `{ "System.Title": "x" }` map into an ADO JSON-Patch document. */
function fieldsToPatch(fields: Record<string, unknown>): JsonPatchOp[] {
  return Object.entries(fields).map(([name, value]) => ({
    op: "add",
    path: `/fields/${name}`,
    value,
  }));
}

/** Full REST url of a work item, used as the target of a relation (e.g. parent link). */
function workItemApiUrl(serverUrl: string, collection: string, id: number): string {
  return `${serverUrl.replace(/\/+$/, "")}/${encodeURIComponent(collection)}/_apis/wit/workItems/${id}`;
}

/**
 * Compact, weak-LLM-friendly confirmation for a freshly created work item —
 * crucially including the clickable `webUrl` (from `_links.html.href`, or built
 * from config) so the user always gets a real link and can trust it was made.
 */
function compactCreated(
  created: Record<string, unknown>,
  serverUrl: string,
  collection: string,
  project: string,
): Record<string, unknown> {
  const fields = (created["fields"] as Record<string, unknown> | undefined) ?? {};
  const id = created["id"];
  const htmlHref = (created["_links"] as { html?: { href?: string } } | undefined)?.html?.href;
  const webUrl =
    typeof htmlHref === "string"
      ? htmlHref
      : `${serverUrl.replace(/\/+$/, "")}/${encodeURIComponent(collection)}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
  return {
    id,
    type: fields["System.WorkItemType"],
    title: fields["System.Title"],
    state: fields["System.State"],
    assignedTo: cleanAdo(fields["System.AssignedTo"]),
    webUrl,
  };
}

/**
 * The value the tool will default a field to when the user didn't supply one:
 * a real (non-empty) `defaultValue`, else the *sole* allowed value. Returns
 * undefined when there is no safe default — a multi-value pick-list is left for
 * the user to choose (via guided mode) rather than guessing an arbitrary value.
 * `""` is treated as "no default" so an empty defaultValue falls through.
 */
function pickDefault(f: { defaultValue?: unknown; allowedValues?: string[] }): unknown {
  const dv = f.defaultValue;
  if (dv !== undefined && dv !== null && dv !== "") return dv;
  if (f.allowedValues && f.allowedValues.length === 1) return f.allowedValues[0];
  return undefined;
}

export function configureWorkItemsTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "wit_query",
    {
      description:
        "Run a WIQL (Work Item Query Language) query. For flat queries (SELECT … FROM WorkItems), " +
        "fetches the matched items' fields and returns them as a compact ticket list — same format " +
        "as wit_list_my_work_items. For hierarchical queries (FROM WorkItemLinks), returns the raw " +
        "relation graph. Prefer wit_list_my_work_items for everyday filtering (my tickets, current " +
        "sprint, state) — it handles identity resolution and iteration without requiring WIQL. " +
        "To find items by title, use wit_search (substring match on the title) — do NOT hand-write " +
        "[System.Title] = '…' (exact match rarely matches).",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "WIQL query text, e.g. 'SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me'",
          ),
        project: z
          .string()
          .optional()
          .describe("Project name or ID to scope the query; omit for collection scope"),
        top: z.number().int().positive().optional().describe("Maximum number of results"),
      },
    },
    async ({ query, project, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      // Cap like every other list tool: an unbounded WIQL can return thousands
      // of references and overflow a small model's context. boundLimit applies
      // min(top ?? maxResults, maxResults) so $top is always set.
      const cap = boundLimit(top, deps.config.maxResults);
      const result = await client.post<{
        workItems?: Array<{ id?: number }>;
        workItemRelations?: unknown[];
      }>("/_apis/wit/wiql", { query }, { project, query: { $top: cap } });

      // Flat query: a `workItems` array is present → fetch each item's fields
      // and return them as a compact ticket list, the same shape a weak model
      // already understands from wit_list_my_work_items. The cap warning is
      // merged into the list header via meta.total (single content block).
      if (Array.isArray(result?.workItems)) {
        const refs = result.workItems.filter(
          (r): r is { id: number } => typeof r?.id === "number",
        );
        const total = refs.length;
        const ids = refs.slice(0, cap).map((r) => r.id);
        if (ids.length === 0) return asTicketList([], { total: 0 });

        const items = await client.workItemsBatch<{
          id?: number;
          fields?: Record<string, unknown>;
        }>(ids, LIST_FIELDS);
        const byId = new Map(items.map((it) => [it.id, it]));
        const ordered = ids
          .map((id) => byId.get(id))
          .filter((it): it is NonNullable<typeof it> => it !== undefined);
        return asTicketList(ordered, { total });
      }

      // Hierarchical / tree query: return the cleaned relation graph as a single
      // text block, embedding the cap note in the text (no second content block).
      const relations = result?.workItemRelations ?? [];
      const cleaned = cleanAdo(result);
      const note =
        relations.length >= cap
          ? `\n\nNote: results capped at ${cap}. Add a tighter WHERE clause or raise "top".`
          : "";
      return textResult(JSON.stringify(cleaned) + note);
    },
  );

  server.registerTool(
    "wit_list_my_work_items",
    {
      description:
        "List work items assigned to you (default) or to a named teammate, as a compact " +
        "one-line-per-ticket summary. Composes the query, identity matching, and field " +
        "projection server-side so you never write WIQL or fetch items one-by-one. Defaults " +
        "to open items; pass state='all' or an explicit state set to change that.",
      inputSchema: {
        mine: z
          .boolean()
          .optional()
          .describe("Only your own items (default true unless assignedTo is given)"),
        assignedTo: z
          .string()
          .min(1)
          .optional()
          .describe("Assignee display name to match (resolved server-side; substring match)"),
        state: z
          .string()
          .min(1)
          .optional()
          .describe("State filter: 'open' (default), 'all', or a comma-separated set e.g. 'Active,New'"),
        titleContains: z
          .string()
          .min(1)
          .optional()
          .describe("Substring to match in the title"),
        iteration: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Sprint/iteration filter: 'current' for the active sprint, or an exact iteration path e.g. 'MyProject\\\\Sprint 48'",
          ),
        project: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Project to scope to; falls back to ADO_DEFAULT_PROJECT if set, otherwise collection-wide",
          ),
        top: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of results (default ADO_AGENT_LIST_CAP, bounded by ADO_MAX_RESULTS)"),
      },
    },
    async ({ mine, assignedTo, state, titleContains, iteration, project, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const cap = boundLimit(top ?? deps.config.agentListCap, deps.config.maxResults);

      // Project: caller-supplied wins; fall back to ADO_DEFAULT_PROJECT so the
      // model doesn't need to know the project name for common queries.
      const effectiveProject = project ?? deps.config.defaultProject;

      // "Mine" unless an explicit assignee is named. An explicit `mine: true`
      // wins over `assignedTo` (matching buildWorkItemQuery's documented
      // precedence); `mine` defaults to true only when no assignee is given.
      // For a named teammate, try to resolve to the server's canonical display
      // name (best-effort): when resolved we match exactly (avoids substring
      // collisions like "Dan" → "Daniel"); when resolution fails we fall back
      // to a CONTAINS on the raw input — robust to bilingual strings and the
      // on-prem "Display Name <unique>" storage format.
      const useMine = mine ?? !assignedTo;
      let assignedToOpt: { value: string; match: "contains" | "equals" } | undefined;
      if (!useMine && assignedTo) {
        const canonical = await client.resolveIdentity(assignedTo);
        assignedToOpt = canonical
          ? { value: canonical, match: "equals" }
          : { value: assignedTo, match: "contains" };
      }

      let states: string[] | undefined;
      let allStates = false;
      if (state) {
        const normalized = state.trim().toLowerCase();
        if (normalized === "all") allStates = true;
        else if (normalized !== "open")
          states = state.split(",").map((s) => s.trim()).filter(Boolean);
      }

      const wiql = buildWorkItemQuery({
        mine: useMine,
        assignedTo: assignedToOpt,
        states,
        allStates,
        titleContains,
        iteration,
      });

      // The WIQL id-query is intentionally *not* capped with $top: ids are
      // cheap (numbers, never forwarded to the model) and we need the true
      // match count so the list can honestly report "showing N of M" and tell
      // the model to refine. Capping happens when we slice ids for the batch.
      const result = await client.post<{ workItems?: Array<{ id?: number }> }>(
        "/_apis/wit/wiql",
        { query: wiql },
        { project: effectiveProject },
      );
      const refs = (result?.workItems ?? []).filter(
        (r): r is { id: number } => typeof r.id === "number",
      );
      const total = refs.length;
      const ids = refs.slice(0, cap).map((r) => r.id);
      if (ids.length === 0) return asTicketList([], { total: 0 });

      const items = await client.workItemsBatch<{ id?: number; fields?: Record<string, unknown> }>(
        ids,
        LIST_FIELDS,
      );
      // workitemsbatch does not guarantee it echoes items in requested-id
      // order, so re-sort back into the WIQL ORDER BY (ChangedDate DESC) order
      // we asked for; otherwise "the top item" would be arbitrary.
      const byId = new Map(items.map((it) => [it.id, it]));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((it): it is NonNullable<typeof it> => it !== undefined);
      const listed = asTicketList(ordered, { total });
      // List-path size-guard: even a thin list can be large with long titles.
      // Measure UTF-8 bytes to match the repo's size-guard convention.
      const listText = listed.content[0]?.text ?? "";
      if (Buffer.byteLength(listText, "utf8") > MAX_INLINE_RESULT_BYTES) {
        return textResult(
          `Result set is too large to return inline (${items.length} items). ` +
            `Narrow your filter (state, assignedTo, titleContains) or lower "top".`,
        );
      }
      return listed;
    },
  );

  server.registerTool(
    "wit_get",
    {
      description:
        "Get a single work item by id. " +
        "Pass 'fields' for a specific field projection OR 'expand' for related data — " +
        "they are mutually exclusive (ADO rejects both together).",
      inputSchema: {
        id: z.number().int().positive().describe("Work item id"),
        fields: z
          .array(z.string())
          .optional()
          .describe("Specific fields to return (reference names), e.g. System.Title"),
        expand: z
          .enum(["none", "relations", "fields", "links", "all"])
          .optional()
          .describe("Expand options for related data"),
      },
    },
    async ({ id, fields, expand }, extra) => {
      // ADO's Get Work Item treats `fields` and `$expand` as mutually exclusive
      // and errors when both are supplied; reject at the boundary instead.
      if (fields && fields.length > 0 && expand && expand !== "none") {
        throw new Error("wit_get: 'fields' and 'expand' are mutually exclusive; pass only one.");
      }
      const client = deps.clientFor(patFromExtra(extra));
      const item = await client.get(`/_apis/wit/workitems/${id}`, {
        query: {
          fields: fields && fields.length > 0 ? fields.join(",") : undefined,
          $expand: expand,
        },
      });
      // Detail path: truncate the raw HTML description and emit compact JSON,
      // with an oversize fallback. Keeps a heavy work item from overflowing.
      return formatWorkItemDetail(item);
    },
  );

  server.registerTool(
    "wit_create",
    {
      description:
        "Create a work item (Bug, Task, User Story, …). Only `type` and `title` are required — " +
        "everything else is optional and defaults sensibly (project → ADO_DEFAULT_PROJECT, " +
        "assignee → you). Returns the new item's id and clickable web link. " +
        "Pass guided:true to FIRST see the type's required and common fields with their allowed " +
        "values and defaults (nothing is created) so you can ask the user before creating.",
      inputSchema: {
        type: z.string().min(1).describe("Work item type, e.g. Bug, Task, User Story"),
        title: z.string().min(1).describe("Work item title — the one thing always required"),
        project: z
          .string()
          .min(1)
          .optional()
          .describe("Project; defaults to ADO_DEFAULT_PROJECT if set"),
        description: z.string().optional().describe("Description / details (plain text or HTML)"),
        assignedTo: z
          .string()
          .min(1)
          .optional()
          .describe("Assignee display name; defaults to you (the authenticated user)"),
        parent: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Parent work item id to link under (e.g. a User Story for a Task)"),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Advanced/optional: any other ADO field by reference name → value, e.g. " +
              '{"Microsoft.VSTS.Common.Priority": 2, "System.Tags": "login"}',
          ),
        guided: z
          .boolean()
          .optional()
          .describe(
            "If true, do NOT create — return the type's required and common fields with allowed " +
              "values + defaults, so you can ask the user (Enter = default) before creating.",
          ),
      },
    },
    async ({ type, title, project, description, assignedTo, parent, fields, guided }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const effectiveProject = project ?? deps.config.defaultProject;
      if (!effectiveProject) {
        return textResult(
          'No project given and ADO_DEFAULT_PROJECT is not set. Pass project: "<name>".',
        );
      }

      // Guided mode: return the create "form" (required + common fields with
      // allowed values and defaults) and create nothing. The agent asks the
      // user, then calls wit_create again without `guided`.
      if (guided) {
        const typeFields = await client
          .getWorkItemTypeFields(effectiveProject, type)
          .catch(() => []);
        const COMMON = new Set([
          "System.AreaPath",
          "System.IterationPath",
          "Microsoft.VSTS.Common.Priority",
        ]);
        // Title and AssignedTo are handled automatically (title is given;
        // assignee defaults to @Me), so they are never prompted here.
        const AUTO = new Set(["System.Title", "System.AssignedTo"]);
        const form = typeFields
          .filter((f) => (f.alwaysRequired || COMMON.has(f.referenceName)) && !AUTO.has(f.referenceName))
          .map((f) => ({
            field: f.referenceName,
            name: f.name,
            required: !!f.alwaysRequired,
            allowedValues: f.allowedValues,
            default: pickDefault(f),
          }));
        return textResult(
          JSON.stringify({
            mode: "guided",
            type,
            project: effectiveProject,
            instructions:
              "Ask the user for these fields (Enter accepts the shown default), then call " +
              "wit_create again WITHOUT guided, passing the chosen values in `fields`.",
            fields: form,
          }),
        );
      }

      // Fast mode: assemble the field map. Title first; caller `fields` merged in.
      const createFields: Record<string, unknown> = { "System.Title": title, ...(fields ?? {}) };
      if (description !== undefined && createFields["System.Description"] === undefined) {
        createFields["System.Description"] = description;
      }
      // Default assignee → the caller (@Me), unless one was provided. This is
      // BEST-EFFORT: it must never break a type+title create (a display name
      // can fail identity resolution on-prem), so `assigneeAuto` marks it for
      // the retry-without-assignee fallback below.
      let assigneeAuto = false;
      if (assignedTo) {
        createFields["System.AssignedTo"] = assignedTo;
      } else if (createFields["System.AssignedTo"] === undefined) {
        const me = (await client.getAuthenticatedIdentity())?.displayName;
        if (me) {
          createFields["System.AssignedTo"] = me;
          assigneeAuto = true;
        }
      }

      // Best-effort: auto-fill required fields where a SAFE default exists, else
      // name the ones we can't so the user can choose (guided). Never guess a
      // value from a multi-option pick-list, and never block on AssignedTo
      // (best-effort above; ADO can auto-assign / leave it unassigned).
      const NO_BLOCK = new Set([
        "System.Title",
        "System.AreaPath",
        "System.IterationPath",
        "System.State",
        "System.Reason",
        "System.AssignedTo",
      ]);
      const missingRequired: string[] = [];
      try {
        const typeFields = await client.getWorkItemTypeFields(effectiveProject, type);
        for (const f of typeFields) {
          if (!f.alwaysRequired || createFields[f.referenceName] !== undefined) continue;
          if (NO_BLOCK.has(f.referenceName)) continue;
          const def = pickDefault(f);
          if (def !== undefined) createFields[f.referenceName] = def;
          else missingRequired.push(f.name ? `${f.name} (${f.referenceName})` : f.referenceName);
        }
      } catch {
        // Type metadata unavailable — proceed; ADO will reject if truly required.
      }
      if (missingRequired.length > 0) {
        return textResult(
          `Cannot create: the "${type}" type requires values for ${missingRequired.join(", ")}. ` +
            "Re-run wit_create with guided:true to see the allowed values, then pass them in `fields`.",
        );
      }

      const patch = fieldsToPatch(createFields);
      if (parent !== undefined) {
        // Hierarchy-Reverse links a child up to its parent.
        patch.push({
          op: "add",
          path: "/relations/-",
          value: {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: workItemApiUrl(deps.config.serverUrl, deps.config.collection, parent),
          },
        });
      }

      const createPath = `/_apis/wit/workitems/$${encodeURIComponent(type)}`;
      const doCreate = (p: JsonPatchOp[]) =>
        client.post<Record<string, unknown>>(createPath, p, { project: effectiveProject }, JSON_PATCH);
      let created: Record<string, unknown>;
      try {
        created = await doCreate(patch);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // The auto @Me assignee must never sink a type+title create: retry once
        // without it, and tell the user assignment was skipped.
        if (assigneeAuto) {
          const noAssignee = patch.filter((op) => op.path !== "/fields/System.AssignedTo");
          const retried = await doCreate(noAssignee).catch(() => undefined);
          if (retried) {
            const result = compactCreated(
              retried,
              deps.config.serverUrl,
              deps.config.collection,
              effectiveProject,
            );
            result["assignedTo"] = null;
            result["note"] = `Created, but could not auto-assign it to you (${msg}). Assign it manually if needed.`;
            return textResult(JSON.stringify(result));
          }
        }
        if (parent !== undefined) {
          return textResult(
            `Could not create the work item (${msg}). If parent ${parent} is wrong or from another ` +
              "project/collection, correct or omit it.",
          );
        }
        throw err;
      }
      return textResult(
        JSON.stringify(
          compactCreated(created, deps.config.serverUrl, deps.config.collection, effectiveProject),
        ),
      );
    },
  );

  server.registerTool(
    "wit_update",
    {
      description: "Update fields on an existing work item by id.",
      inputSchema: {
        id: z.number().int().positive().describe("Work item id"),
        fields: z
          .record(z.string(), z.unknown())
          .refine((f) => Object.keys(f).length > 0, { message: "at least one field is required" })
          .describe(
            "Field map keyed by ADO field reference names. Common fields: " +
              '"System.State" (e.g. "Active", "Resolved", "Closed"), "System.AssignedTo" (display name), ' +
              '"System.Title", "System.Description", "System.Tags", "System.AreaPath", ' +
              '"System.IterationPath", "Microsoft.VSTS.Common.Priority" (1-4), ' +
              '"Microsoft.VSTS.Common.ResolvedReason", "System.Reason". ' +
              'Example: {"System.State": "Active", "System.AssignedTo": "Bob Jones"}',
          ),
      },
    },
    async ({ id, fields }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const updated = await client.patch(
        `/_apis/wit/workitems/${id}`,
        fieldsToPatch(fields),
        {},
        JSON_PATCH,
      );
      return formatWorkItemDetail(updated);
    },
  );

  server.registerTool(
    "wit_add_comment",
    {
      description: "Add a comment to a work item.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        id: z.number().int().positive().describe("Work item id"),
        text: z.string().min(1).describe("Comment text"),
      },
    },
    async ({ project, id, text }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
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
    },
  );

  server.registerTool(
    "wit_list_types",
    {
      description: "List the available work item types for a project.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
      },
    },
    async ({ project }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const result = await client.get<{ value?: unknown[] }>("/_apis/wit/workitemtypes", {
        project,
      });
      // Slim to the fields a model needs to pick a type; ADO returns icons,
      // field lists, transitions, and other noise that's pure token cost here.
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
    },
  );

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
          states = state
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
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
}
