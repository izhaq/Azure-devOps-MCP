import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";
import type { QueryValue } from "../azure/client.js";

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

function asText(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

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

export function configureRepositoriesTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "repo_list",
    {
      description: "List Git repositories in a project, or across the collection if no project.",
      inputSchema: {
        project: z.string().min(1).optional().describe("Project name or ID; omit for collection-wide"),
        top: z.number().int().positive().optional().describe("Maximum number of repositories"),
      },
    },
    async ({ project, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const result = await client.get<{ value?: unknown[] }>("/_apis/git/repositories", { project });
      const repos = result.value ?? [];
      return asText(top ? repos.slice(0, top) : repos);
    },
  );

  server.registerTool(
    "repo_list_branches",
    {
      description: "List branches (heads) of a repository.",
      inputSchema: {
        repositoryId: z.string().min(1).describe("Repository id or name"),
        project: z.string().min(1).optional().describe("Project name or ID"),
        top: z.number().int().positive().optional().describe("Maximum number of branches"),
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
      description: "Get the contents of a file at a path (optionally on a branch).",
      inputSchema: {
        repositoryId: z.string().min(1).describe("Repository id or name"),
        path: z.string().min(1).describe("File path, e.g. /src/index.ts"),
        project: z.string().min(1).optional().describe("Project name or ID"),
        branch: z.string().min(1).optional().describe("Branch name; defaults to the repo default"),
      },
    },
    async ({ repositoryId, path, project, branch }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const item = await client.get(
        `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/items`,
        { project, query: { path, includeContent: true, ...branchVersion(branch) } },
      );
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
        scopePath: z.string().min(1).optional().describe("Folder path to list; defaults to /"),
        recursionLevel: z
          .enum(RECURSION)
          .optional()
          .describe("Tree recursion: none, oneLevel (default), or full"),
        branch: z.string().min(1).optional().describe("Branch name; defaults to the repo default"),
      },
    },
    async ({ repositoryId, project, scopePath, recursionLevel, branch }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
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
      return asText(result.value ?? []);
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
        path: z.string().min(1).optional().describe("Filter by item path"),
        top: z.number().int().positive().optional().describe("Maximum number of commits"),
      },
    },
    async ({ repositoryId, project, branch, author, path, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const query: Record<string, QueryValue> = {
        "searchCriteria.author": author,
        "searchCriteria.itemPath": path,
        "searchCriteria.$top": top,
      };
      if (branch) {
        query["searchCriteria.itemVersion.version"] = branch;
        query["searchCriteria.itemVersion.versionType"] = "branch";
      }
      const result = await client.get<{ value?: unknown[] }>(
        `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/commits`,
        { project, query },
      );
      return asText(result.value ?? []);
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
