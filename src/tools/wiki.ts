import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";
import { boundLimit, type QueryValue } from "../azure/client.js";
import { asCleanText, textResult } from "./_shared.js";
import { AdoApiError } from "../azure/errors.js";

/**
 * wiki domain: project wikis + pages.
 * Endpoints (Azure DevOps Server, api-version configurable). All are
 * project-scoped, so `project` is required on every tool.
 *   GET {project}/_apis/wiki/wikis                                  (wiki_list)
 *   GET {project}/_apis/wiki/wikis/{wikiIdentifier}/pages?path=    (wiki_get_page)
 *   PUT {project}/_apis/wiki/wikis/{wikiIdentifier}/pages?path=    (wiki_create_or_update_page)
 * Page versions ride the `ETag` response header: wiki_get_page surfaces it as
 * `eTag`, and wiki_create_or_update_page echoes it back via `If-Match` to edit.
 * Source: https://learn.microsoft.com/en-us/rest/api/azure/devops/wiki (api-version 7.1)
 */

/** Upper bound on a wiki page path accepted at the tool boundary. */
const MAX_PATH_LENGTH = 1024;

/**
 * Flatten a nested wiki page tree (subPages recursion) into an indented list
 * of paths. Used by wiki_get_page when recursionLevel is set — the model only
 * needs the structure, not the full per-page objects.
 */
function flattenWikiTree(page: Record<string, unknown>, depth = 0): string[] {
  const lines: string[] = [];
  const pagePath = (page["path"] as string) ?? "?";
  lines.push(`${"  ".repeat(depth)}${pagePath}`);
  const sub = page["subPages"] as Array<Record<string, unknown>> | undefined;
  if (sub) {
    for (const child of sub) lines.push(...flattenWikiTree(child, depth + 1));
  }
  return lines;
}

/** Recursion levels for fetching a page's subtree (ADO `VersionControlRecursionType`). */
const RECURSION = ["none", "oneLevel", "oneLevelPlusNestedEmptyFolders", "full"] as const;

/**
 * Largest serialized page (in bytes) returned inline by `wiki_get_page`. The
 * page — including its `content` and any `subPages` from `recursionLevel: full`
 * — is delivered as raw text inside the JSON result, so an unbounded tree would
 * bloat memory (via JSON.stringify) and the response. When exceeded we drop the
 * page's `content` and note it; mirrors `repo_get_file`'s inline-size guard.
 */
const MAX_INLINE_PAGE_BYTES = 1_000_000;

export function configureWikiTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "wiki_list",
    {
      description: "List the wikis in a project.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        top: z
          .number()
          .int()
          .positive()
          .max(deps.config.maxResults)
          .optional()
          .describe("Maximum number of wikis"),
      },
    },
    async ({ project, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const cap = boundLimit(top, deps.config.maxResults);
      const result = await client.get<{ value?: Array<Record<string, unknown>> }>(
        "/_apis/wiki/wikis",
        { project },
      );
      // Slim to the fields a model needs to call wiki_get_page; full objects
      // carry repositoryId, mappedPath, versions, remoteUrl etc. that waste tokens.
      const slim = (result.value ?? []).slice(0, cap).map((w) => ({
        id: w["id"],
        name: w["name"],
        type: w["type"],
      }));
      return asCleanText(slim);
    },
  );

  server.registerTool(
    "wiki_get_page",
    {
      description:
        "Get a wiki page by path, or list its sections. Two modes: " +
        "(1) Read a page: omit recursionLevel (or set to 'none') — returns the markdown content and its eTag. " +
        "(2) List sections/sub-pages: set recursionLevel to 'oneLevel' or 'full' — returns a compact indented " +
        "path tree (NOT full objects). Use mode 2 to answer 'what sections does the wiki have?'. " +
        "The eTag from mode 1 is required by wiki_create_or_update_page to edit the page. " +
        `Pages larger than ${MAX_INLINE_PAGE_BYTES} bytes have their content omitted.`,
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        wikiIdentifier: z.string().min(1).describe("Wiki id or name"),
        path: z.string().min(1).max(MAX_PATH_LENGTH).describe("Page path, e.g. /Home or /Docs/Setup"),
        includeContent: z
          .boolean()
          .optional()
          .describe(
            "Include the page's markdown content; defaults to true when reading a single page, " +
            "false when listing sub-pages (recursionLevel set)",
          ),
        recursionLevel: z
          .enum(RECURSION)
          .optional()
          .describe(
            "Sub-page listing depth: none (default — read single page), oneLevel, " +
            "oneLevelPlusNestedEmptyFolders, or full (entire tree). " +
            "When set, returns a compact path list instead of full objects.",
          ),
      },
    },
    async ({ project, wikiIdentifier, path, includeContent, recursionLevel }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      // When listing sections (recursionLevel set), default to NOT fetching
      // content — the model wants structure, not the text of 17 pages.
      const listingTree = recursionLevel && recursionLevel !== "none";
      const query: Record<string, QueryValue> = {
        path,
        includeContent: includeContent ?? (listingTree ? false : true),
        recursionLevel,
      };
      const { data, etag } = await client.requestWithEtag<Record<string, unknown>>(
        "GET",
        `/_apis/wiki/wikis/${encodeURIComponent(wikiIdentifier)}/pages`,
        undefined,
        { project, query },
      );

      // Tree mode: return a compact indented path list instead of full objects.
      // Full per-page objects (order, gitItemPath, isParentPage, subPages nesting…)
      // are pure token waste when the model just wants to know what sections exist.
      if (listingTree) {
        const lines = flattenWikiTree(data);
        return textResult(
          `Wiki sections at '${path}' (${lines.length} page${lines.length === 1 ? "" : "s"}):\n` +
          lines.join("\n") +
          (etag ? `\n\neTag: ${etag}` : ""),
        );
      }

      // Single-page mode: guard against a huge content blob.
      const size = Buffer.byteLength(JSON.stringify(data), "utf8");
      if (size > MAX_INLINE_PAGE_BYTES) {
        const { content: _omitted, ...metadata } = data;
        return asCleanText({
          page: { ...metadata, contentOmitted: true, size },
          eTag: etag,
          message: `Page payload (${size} bytes) exceeds the ${MAX_INLINE_PAGE_BYTES}-byte inline limit; content omitted. Re-fetch with includeContent=false and recursionLevel=none for metadata only.`,
        });
      }
      return asCleanText({ page: data, eTag: etag });
    },
  );

  server.registerTool(
    "wiki_create_or_update_page",
    {
      description:
        "Create or edit a wiki page at a path. " +
        "IMPORTANT: To EDIT an existing page, you must first call wiki_get_page to retrieve its eTag, " +
        "then pass that eTag here — Azure DevOps requires it for optimistic concurrency. " +
        "Without eTag, edits to an existing page are rejected. " +
        "To CREATE a new page, omit eTag entirely. " +
        "Returns the saved page and its new eTag (save it if you plan to edit again).",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        wikiIdentifier: z.string().min(1).describe("Wiki id or name"),
        path: z.string().min(1).max(MAX_PATH_LENGTH).describe("Page path, e.g. /Home or /Docs/Setup"),
        content: z.string().describe("Markdown content for the page"),
        eTag: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Version token from wiki_get_page — REQUIRED to edit an existing page, omit when creating a new one",
          ),
      },
    },
    async ({ project, wikiIdentifier, path, content, eTag }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      try {
        const { data, etag } = await client.requestWithEtag<Record<string, unknown>>(
          "PUT",
          `/_apis/wiki/wikis/${encodeURIComponent(wikiIdentifier)}/pages`,
          { content },
          {
            project,
            query: { path },
            headers: eTag ? { "If-Match": eTag } : undefined,
          },
        );
        return asCleanText({ page: data, eTag: etag });
      } catch (err) {
        // No eTag + a 412 means the page already exists and ADO wants the
        // current version. Turn the opaque error into an actionable hint.
        if (!eTag && err instanceof AdoApiError && err.status === 412) {
          return textResult(
            `Page '${path}' already exists. Call wiki_get_page to get its eTag, then retry ` +
              `wiki_create_or_update_page with that eTag set.`,
          );
        }
        throw err;
      }
    },
  );
}
