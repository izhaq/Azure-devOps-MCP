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
      const projects = await client.getAll<Record<string, unknown>>("/_apis/projects", {}, top);
      // Keep only the fields a model needs to identify a project; ADO returns
      // many extras (capabilities, defaultTeam, visibility, lastUpdateTime…)
      // that are pure token cost here.
      const slim = projects.map((p) => ({
        id: p["id"],
        name: p["name"],
        description: p["description"],
        state: p["state"],
      }));
      return asCleanText(slim);
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
      const slimTeam = (t: unknown) => {
        const team = t as Record<string, unknown>;
        return {
          id: team["id"],
          name: team["name"],
          description: team["description"],
          projectName: team["projectName"],
        };
      };
      if (project) {
        const teams = await client.getAll(`/_apis/projects/${encodeURIComponent(project)}/teams`);
        return asCleanText(teams.map(slimTeam));
      }
      // Collection-wide listing requires the preview api-version.
      const teams = await client.getAll("/_apis/teams", {
        apiVersion: toPreviewVersion(deps.config.apiVersion, 3),
      });
      return asCleanText(teams.map(slimTeam));
    },
  );
}
