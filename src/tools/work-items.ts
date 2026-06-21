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

/**
 * Format a single work item for the detail path: truncate the raw HTML
 * description, then apply cleanAdo (strips _links everywhere, flattens identity
 * objects to display names). If still oversized, return an actionable message.
 */
function formatWorkItemDetail(item: unknown): ReturnType<typeof textResult> {
  let shaped: unknown = item;
  if (item && typeof item === "object" && "fields" in item) {
    const raw = item as Record<string, unknown>;
    const fields = { ...(raw.fields as Record<string, unknown> | undefined) };
    if (typeof fields["System.Description"] === "string") {
      fields["System.Description"] = truncateField(fields["System.Description"], MAX_DESCRIPTION_CHARS);
    }
    shaped = { ...raw, fields };
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

export function configureWorkItemsTools(server: McpServer, deps: ToolDeps): void {
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
      description: "Get a single work item by id.",
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
      description: "Create a work item of the given type from a map of field reference names.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        type: z.string().min(1).describe("Work item type, e.g. Bug, Task, User Story"),
        fields: z
          .record(z.string(), z.unknown())
          .refine((f) => Object.keys(f).length > 0, { message: "at least one field is required" })
          .describe('Field map keyed by reference name, e.g. {"System.Title": "..."}'),
      },
    },
    async ({ project, type, fields }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const created = await client.post(
        `/_apis/wit/workitems/$${encodeURIComponent(type)}`,
        fieldsToPatch(fields),
        { project },
        JSON_PATCH,
      );
      return asCleanText(created);
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
          .describe('Field map keyed by reference name, e.g. {"System.State": "Active"}'),
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
      return asCleanText(updated);
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
      const comment = await client.post(
        `/_apis/wit/workItems/${id}/comments`,
        { text },
        { project, apiVersion: toPreviewVersion(deps.config.apiVersion, 3) },
      );
      return asCleanText(comment);
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
      return asCleanText(result.value ?? []);
    },
  );
}
