import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";
import { toPreviewVersion } from "../shared/api-version.js";
import { asCleanText } from "./_shared.js";

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
      return asCleanText(projects);
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
        return asCleanText(teams);
      }
      // Collection-wide listing requires the preview api-version.
      const teams = await client.getAll("/_apis/teams", {
        apiVersion: toPreviewVersion(deps.config.apiVersion, 3),
      });
      return asCleanText(teams);
    },
  );
}
