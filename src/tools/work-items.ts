import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";
import { toPreviewVersion } from "../shared/api-version.js";
import { asText } from "./_shared.js";

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
        "Run a WIQL (Work Item Query Language) query and return matching work item references.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("WIQL query text, e.g. SELECT [System.Id] FROM workitems"),
        project: z
          .string()
          .optional()
          .describe("Project name or ID to scope the query; omit for collection scope"),
        top: z.number().int().positive().optional().describe("Maximum number of results"),
      },
    },
    async ({ query, project, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const result = await client.post(
        "/_apis/wit/wiql",
        { query },
        { project, query: top ? { $top: top } : undefined },
      );
      return asText(result);
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
      return asText(item);
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
      return asText(created);
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
      return asText(updated);
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
      return asText(comment);
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
      return asText(result.value ?? []);
    },
  );
}
