import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";

/**
 * Core domain: projects and teams.
 * Endpoints (Azure DevOps Server, api-version configurable):
 *   GET {collection}/_apis/projects
 *   GET {collection}/_apis/projects/{project}/teams
 *   GET {collection}/_apis/teams
 * Source: https://learn.microsoft.com/en-us/rest/api/azure/devops/core/
 */
export function configureCoreTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "core_list_projects",
    {
      description: "List all team projects in the Azure DevOps collection.",
      inputSchema: {
        top: z.number().int().positive().optional().describe("Maximum number of projects to return"),
      },
    },
    async ({ top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const projects = await client.getAll("/_apis/projects", { query: { $top: top } });
      return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
    },
  );

  server.registerTool(
    "core_list_teams",
    {
      description: "List teams for a project, or all teams in the collection if no project is given.",
      inputSchema: {
        project: z.string().optional().describe("Project name or ID; omit to list all teams"),
      },
    },
    async ({ project }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const path = project
        ? `/_apis/projects/${encodeURIComponent(project)}/teams`
        : "/_apis/teams";
      const teams = await client.getAll(path);
      return { content: [{ type: "text", text: JSON.stringify(teams, null, 2) }] };
    },
  );
}
