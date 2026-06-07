import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";
import { boundLimit, type QueryValue } from "../azure/client.js";
import { asText } from "./_shared.js";

/**
 * repositories domain: Git read operations.
 * Endpoints (Azure DevOps Server, api-version configurable):
 *   GET {project?}/_apis/git/repositories                                   (List)
 *   GET {project?}/_apis/git/repositories/{repositoryId}/refs              (refs/branches)
 *   GET {project?}/_apis/git/repositories/{repositoryId}/items            (Items - get/list)
 *   GET {project?}/_apis/git/repositories/{repositoryId}/commits          (Commits - list)
 *   GET {project?}/_apis/git/repositories/{repositoryId}/commits/{id}     (Commits - get)
 * Source: https://learn.microsoft.com/en-us/rest/api/azure/devops/git (api-version 7.1)
 */

/**
 * Build the `versionDescriptor.*` query params that pin a Git read to a branch.
 * Returns an empty object when no branch is given (defaults to the repo default).
 */
function branchVersion(branch: string | undefined): Record<string, QueryValue> {
  if (!branch) return {};
  return {
    "versionDescriptor.version": branch,
    "versionDescriptor.versionType": "branch",
  };
}

const RECURSION = ["none", "oneLevel", "full"] as const;

/**
 * Upper bound on a file/scope path length accepted at the tool boundary. Git
 * paths are far shorter in practice; this just rejects absurd inputs early.
 */
const MAX_PATH_LENGTH = 1024;

/**
 * Largest file content (in bytes) returned inline by `repo_get_file`. Content
 * is delivered as raw text inside the JSON result, so an unbounded blob would
 * bloat memory (via JSON.stringify) and the response. Bounded and documented;
 * not configurable via env to keep the config surface small.
 */
const MAX_INLINE_FILE_BYTES = 1_000_000;

export function configureRepositoriesTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "repo_list",
    {
      description: "List Git repositories in a project, or across the collection if no project.",
      inputSchema: {
        project: z.string().min(1).optional().describe("Project name or ID; omit for collection-wide"),
        top: z
          .number()
          .int()
          .positive()
          .max(deps.config.maxResults)
          .optional()
          .describe("Maximum number of repositories"),
      },
    },
    async ({ project, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      // The List repositories endpoint returns the full set in one response
      // (no server-side paging / continuation token), so the fetch itself is
      // best-effort. Bound the RESULT by the same min(top ?? maxResults,
      // maxResults) cap getAll applies, so list tools stay consistent.
      const cap = boundLimit(top, deps.config.maxResults);
      const result = await client.get<{ value?: unknown[] }>("/_apis/git/repositories", { project });
      return asText((result.value ?? []).slice(0, cap));
    },
  );

  server.registerTool(
    "repo_list_branches",
    {
      description: "List branches (heads) of a repository.",
      inputSchema: {
        repositoryId: z.string().min(1).describe("Repository id or name"),
        project: z.string().min(1).optional().describe("Project name or ID"),
        top: z
          .number()
          .int()
          .positive()
          .max(deps.config.maxResults)
          .optional()
          .describe("Maximum number of branches"),
      },
    },
    async ({ repositoryId, project, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const refs = await client.getAll(
        `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/refs`,
        { project, query: { filter: "heads/" } },
        top,
      );
      return asText(refs);
    },
  );

  server.registerTool(
    "repo_get_file",
    {
      description:
        `Get the contents of a file at a path (optionally on a branch). Content is ` +
        `returned inline as raw text; Git LFS pointers are NOT resolved (no ` +
        `resolveLfs), so an LFS-tracked file yields its pointer text. Files larger ` +
        `than ${MAX_INLINE_FILE_BYTES} bytes have their content omitted (metadata only).`,
      inputSchema: {
        repositoryId: z.string().min(1).describe("Repository id or name"),
        path: z.string().min(1).max(MAX_PATH_LENGTH).describe("File path, e.g. /src/index.ts"),
        project: z.string().min(1).optional().describe("Project name or ID"),
        branch: z.string().min(1).optional().describe("Branch name; defaults to the repo default"),
      },
    },
    async ({ repositoryId, path, project, branch }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const item = await client.get<Record<string, unknown>>(
        `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/items`,
        { project, query: { path, includeContent: true, ...branchVersion(branch) } },
      );
      // Guard against returning a huge blob inline: a large content string
      // would be doubled by JSON.stringify and bloat the response. Drop the
      // content and return metadata plus a size so the caller can decide.
      const content = item.content;
      if (typeof content === "string") {
        const size = Buffer.byteLength(content, "utf8");
        if (size > MAX_INLINE_FILE_BYTES) {
          const { content: _omitted, ...metadata } = item;
          return asText({
            ...metadata,
            contentOmitted: true,
            size,
            message: `File content (${size} bytes) exceeds the ${MAX_INLINE_FILE_BYTES}-byte inline limit and was omitted.`,
          });
        }
      }
      return asText(item);
    },
  );

  server.registerTool(
    "repo_list_items",
    {
      description: "List items (files and folders) under a path in a repository.",
      inputSchema: {
        repositoryId: z.string().min(1).describe("Repository id or name"),
        project: z.string().min(1).optional().describe("Project name or ID"),
        scopePath: z
          .string()
          .min(1)
          .max(MAX_PATH_LENGTH)
          .optional()
          .describe("Folder path to list; defaults to /"),
        recursionLevel: z
          .enum(RECURSION)
          .optional()
          .describe("Tree recursion: none, oneLevel (default), or full"),
        branch: z.string().min(1).optional().describe("Branch name; defaults to the repo default"),
      },
    },
    async ({ repositoryId, project, scopePath, recursionLevel, branch }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      // The Items endpoint returns the whole listing in one response (no
      // server-side paging); recursionLevel "full" can walk an entire tree, so
      // the fetch is best-effort. Bound the RESULT to maxResults so a large
      // tree can't blow up memory or the payload.
      const cap = boundLimit(undefined, deps.config.maxResults);
      const result = await client.get<{ value?: unknown[] }>(
        `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/items`,
        {
          project,
          query: {
            scopePath: scopePath ?? "/",
            recursionLevel: recursionLevel ?? "oneLevel",
            ...branchVersion(branch),
          },
        },
      );
      return asText((result.value ?? []).slice(0, cap));
    },
  );

  server.registerTool(
    "repo_list_commits",
    {
      description: "List commits in a repository, optionally filtered by branch, author, or path.",
      inputSchema: {
        repositoryId: z.string().min(1).describe("Repository id or name"),
        project: z.string().min(1).optional().describe("Project name or ID"),
        branch: z.string().min(1).optional().describe("Branch name to list commits from"),
        author: z.string().min(1).optional().describe("Filter by commit author"),
        path: z.string().min(1).max(MAX_PATH_LENGTH).optional().describe("Filter by item path"),
        top: z
          .number()
          .int()
          .positive()
          .max(deps.config.maxResults)
          .optional()
          .describe("Maximum number of commits"),
      },
    },
    async ({ repositoryId, project, branch, author, path, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      // Push the cap to the server via searchCriteria.$top so it doesn't
      // over-return, and bound the RESULT by the same cap as a belt-and-braces
      // guard (and to cover the "no top" case, which would otherwise be
      // unbounded). Source: GET .../commits supports searchCriteria.$top —
      // https://learn.microsoft.com/en-us/rest/api/azure/devops/git/commits/get-commits
      const cap = boundLimit(top, deps.config.maxResults);
      const query: Record<string, QueryValue> = {
        "searchCriteria.author": author,
        "searchCriteria.itemPath": path,
        "searchCriteria.$top": cap,
      };
      if (branch) {
        query["searchCriteria.itemVersion.version"] = branch;
        query["searchCriteria.itemVersion.versionType"] = "branch";
      }
      const result = await client.get<{ value?: unknown[] }>(
        `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/commits`,
        { project, query },
      );
      return asText((result.value ?? []).slice(0, cap));
    },
  );

  server.registerTool(
    "repo_get_commit",
    {
      description: "Get a single commit by id.",
      inputSchema: {
        repositoryId: z.string().min(1).describe("Repository id or name"),
        commitId: z.string().min(1).describe("Commit SHA"),
        project: z.string().min(1).optional().describe("Project name or ID"),
      },
    },
    async ({ repositoryId, commitId, project }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const commit = await client.get(
        `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/commits/${encodeURIComponent(commitId)}`,
        { project },
      );
      return asText(commit);
    },
  );
}
