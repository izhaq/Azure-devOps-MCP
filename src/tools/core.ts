import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";

/**
 * Core domain: projects and teams.
 * Endpoints (Azure DevOps Server, api-version configurable):
 *   GET {collection}/_apis/projects                  (GA)
 *   GET {collection}/_apis/projects/{project}/teams  (GA, "Get Teams")
 *   GET {collection}/_apis/teams                     (preview-only, "Get All Teams")
 * Sources:
 *   https://learn.microsoft.com/en-us/rest/api/azure/devops/core/teams/get-teams (api-version 7.1)
 *   https://learn.microsoft.com/en-us/rest/api/azure/devops/core/teams/get-all-teams (api-version 7.1-preview.3)
 */

/**
 * Collection-wide "Get All Teams" is only exposed under a preview api-version.
 * Derive the matching preview from the configured base version so the override
 * still respects an operator-chosen version (e.g. 6.0 → 6.0-preview.3) and is a
 * no-op if a preview is already configured.
 * Source: https://learn.microsoft.com/en-us/rest/api/azure/devops/core/teams/get-all-teams
 */
function toPreviewVersion(version: string, revision: number): string {
  return version.includes("-preview") ? version : `${version}-preview.${revision}`;
}

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
      const projects = await client.getAll("/_apis/projects", {}, top);
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
      if (project) {
        const teams = await client.getAll(`/_apis/projects/${encodeURIComponent(project)}/teams`);
        return { content: [{ type: "text", text: JSON.stringify(teams, null, 2) }] };
      }
      // Collection-wide listing requires the preview api-version.
      const teams = await client.getAll("/_apis/teams", {
        apiVersion: toPreviewVersion(deps.config.apiVersion, 3),
      });
      return { content: [{ type: "text", text: JSON.stringify(teams, null, 2) }] };
    },
  );
}
