import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";
import { boundLimit, type QueryValue } from "../azure/client.js";
import { asText } from "./_shared.js";

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
      const result = await client.get<{ value?: unknown[] }>("/_apis/wiki/wikis", { project });
      return asText((result.value ?? []).slice(0, cap));
    },
  );

  server.registerTool(
    "wiki_get_page",
    {
      description:
        "Get a wiki page by path. Returns the page and its version as `eTag`; pass " +
        "that `eTag` to wiki_create_or_update_page to edit the page. Pages larger than " +
        `${MAX_INLINE_PAGE_BYTES} bytes have their content omitted (metadata only).`,
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        wikiIdentifier: z.string().min(1).describe("Wiki id or name"),
        path: z.string().min(1).max(MAX_PATH_LENGTH).describe("Page path, e.g. /Home or /Docs/Setup"),
        includeContent: z
          .boolean()
          .optional()
          .describe("Include the page's markdown content (default true)"),
        recursionLevel: z
          .enum(RECURSION)
          .optional()
          .describe("Include sub-pages: none (default), oneLevel, oneLevelPlusNestedEmptyFolders, or full"),
      },
    },
    async ({ project, wikiIdentifier, path, includeContent, recursionLevel }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const query: Record<string, QueryValue> = {
        path,
        includeContent: includeContent ?? true,
        recursionLevel,
      };
      const { data, etag } = await client.requestWithEtag<Record<string, unknown>>(
        "GET",
        `/_apis/wiki/wikis/${encodeURIComponent(wikiIdentifier)}/pages`,
        undefined,
        { project, query },
      );
      // Guard against returning a huge page tree inline: JSON.stringify would
      // double the bytes and bloat the response. Drop the content and report
      // the size so the caller can re-fetch with includeContent=false.
      const size = Buffer.byteLength(JSON.stringify(data), "utf8");
      if (size > MAX_INLINE_PAGE_BYTES) {
        const { content: _omitted, ...metadata } = data;
        return asText({
          page: { ...metadata, contentOmitted: true, size },
          eTag: etag,
          message: `Page payload (${size} bytes) exceeds the ${MAX_INLINE_PAGE_BYTES}-byte inline limit; content omitted. Re-fetch with includeContent=false and recursionLevel=none for metadata only.`,
        });
      }
      return asText({ page: data, eTag: etag });
    },
  );

  server.registerTool(
    "wiki_create_or_update_page",
    {
      description:
        "Create or edit a wiki page at a path. Omit `eTag` to create a new page; " +
        "to edit an existing page, pass the `eTag` returned by wiki_get_page " +
        "(Azure DevOps requires it to confirm you are editing the current revision). " +
        "Returns the saved page and its new `eTag`.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        wikiIdentifier: z.string().min(1).describe("Wiki id or name"),
        path: z.string().min(1).max(MAX_PATH_LENGTH).describe("Page path, e.g. /Home or /Docs/Setup"),
        content: z.string().describe("Markdown content for the page"),
        eTag: z
          .string()
          .min(1)
          .optional()
          .describe("Current page version (the `eTag` from wiki_get_page); required to edit, omit to create"),
      },
    },
    async ({ project, wikiIdentifier, path, content, eTag }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
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
      return asText({ page: data, eTag: etag });
    },
  );
}
