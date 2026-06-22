import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";
import { boundLimit, type QueryValue } from "../azure/client.js";
import { asCleanText, textResult } from "./_shared.js";

/**
 * work domain: team boards/iterations (sprints), backlog levels, capacity.
 * Endpoints (Azure DevOps Server, api-version configurable). All are
 * team-scoped; `team` is optional and defaults to the project's default team.
 *   GET {project}/{team?}/_apis/work/teamsettings/iterations                          (work_list_iterations)
 *   GET {project}/{team?}/_apis/work/backlogs                                         (work_list_backlog_levels)
 *   GET {project}/{team?}/_apis/work/teamsettings/iterations/{iterationId}/capacities (work_get_capacity)
 * Source: https://learn.microsoft.com/en-us/rest/api/azure/devops/work (api-version 7.1)
 */

/**
 * Build a work-area request path, optionally scoped to a team. The team
 * segment precedes `_apis`; when omitted, Azure DevOps uses the project's
 * default team.
 */
function workPath(team: string | undefined, resource: string): string {
  const teamSegment = team ? `/${encodeURIComponent(team)}` : "";
  return `${teamSegment}/_apis/work/${resource}`;
}

export function configureWorkTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "work_get_current_sprint",
    {
      description:
        "Get the name and dates of the CURRENT (active) sprint for a project. Returns a single line. " +
        "Use this to answer 'what sprint are we in?' or 'what is the current sprint?'. " +
        "Falls back to ADO_DEFAULT_PROJECT when no project is given. " +
        "To see ALL sprints (past and future), use work_list_iterations instead.",
      inputSchema: {
        project: z.string().min(1).optional().describe("Project name or ID; uses ADO_DEFAULT_PROJECT if not given"),
        team: z.string().min(1).optional().describe("Team name or ID; defaults to the project's default team"),
      },
    },
    async ({ project, team }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const effectiveProject = project ?? deps.config.defaultProject;
      const result = await client.get<{ value?: Array<{
        name?: string;
        path?: string;
        attributes?: { startDate?: string; finishDate?: string; timeFrame?: string };
      }> }>(
        workPath(team, "teamsettings/iterations"),
        { project: effectiveProject, query: { $timeframe: "current" } },
      );
      const sprint = (result.value ?? [])[0];
      if (!sprint) {
        return textResult(
          "No current sprint found." +
          (effectiveProject ? ` Project: ${effectiveProject}.` : " Try specifying a project."),
        );
      }
      const start = sprint.attributes?.startDate?.slice(0, 10) ?? "unknown";
      const end   = sprint.attributes?.finishDate?.slice(0, 10) ?? "unknown";
      return textResult(
        `Current sprint: ${sprint.name}\nPeriod: ${start} to ${end}\nPath: ${sprint.path ?? ""}`,
      );
    },
  );

  server.registerTool(
    "work_list_iterations",
    {
      description:
        "List a team's iterations (sprints). By default lists ALL iterations (past and future). " +
        "Pass timeframe='current' to return only the active sprint (same as work_get_current_sprint " +
        "but returns the raw object). To just know the current sprint name and dates, prefer " +
        "work_get_current_sprint — it returns a single clean line.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        team: z.string().min(1).optional().describe("Team name or ID; defaults to the project's default team"),
        timeframe: z
          .literal("current")
          .optional()
          .describe("Only 'current' is supported; omit to list all iterations"),
        top: z
          .number()
          .int()
          .positive()
          .max(deps.config.maxResults)
          .optional()
          .describe("Maximum number of iterations"),
      },
    },
    async ({ project, team, timeframe, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const cap = boundLimit(top, deps.config.maxResults);
      const effectiveProject = project ?? deps.config.defaultProject;
      const query: Record<string, QueryValue> = { $timeframe: timeframe };
      const result = await client.get<{ value?: unknown[] }>(
        workPath(team, "teamsettings/iterations"),
        { project: effectiveProject, query },
      );
      const slim = (result.value ?? []).slice(0, cap).map((i) => {
        const it = i as Record<string, unknown>;
        const attrs = (it["attributes"] as Record<string, unknown>) ?? {};
        return {
          id: it["id"],
          name: it["name"],
          path: it["path"],
          startDate: (attrs["startDate"] as string | undefined)?.slice(0, 10),
          finishDate: (attrs["finishDate"] as string | undefined)?.slice(0, 10),
          timeFrame: attrs["timeFrame"],
        };
      });
      return asCleanText(slim);
    },
  );

  server.registerTool(
    "work_list_backlog_levels",
    {
      description:
        "List a team's backlog levels (e.g. Epics, Features, Stories) and their " +
        "configuration. To list the work items inside a backlog, use wit_query (WIQL).",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        team: z.string().min(1).optional().describe("Team name or ID; defaults to the project's default team"),
        top: z
          .number()
          .int()
          .positive()
          .max(deps.config.maxResults)
          .optional()
          .describe("Maximum number of backlog levels"),
      },
    },
    async ({ project, team, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const cap = boundLimit(top, deps.config.maxResults);
      const effectiveProject = project ?? deps.config.defaultProject;
      const result = await client.get<{ value?: unknown[] }>(workPath(team, "backlogs"), {
        project: effectiveProject,
      });
      const slim = (result.value ?? []).slice(0, cap).map((l) => {
        const level = l as Record<string, unknown>;
        const types = (level["workItemTypes"] as Array<Record<string, unknown>> | undefined) ?? [];
        const defType = level["defaultWorkItemType"] as Record<string, unknown> | undefined;
        return {
          id: level["id"],
          name: level["name"],
          rank: level["rank"],
          workItemTypes: types.map((t) => (t["name"] as string) ?? String(t)),
          defaultWorkItemType: defType ? ((defType["name"] as string) ?? undefined) : undefined,
        };
      });
      return asCleanText(slim);
    },
  );

  server.registerTool(
    "work_get_capacity",
    {
      description: "Get a team's capacity (per-member capacity and days off) for an iteration.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        iterationId: z
          .string()
          .min(1)
          .describe(
            "Iteration GUID or iteration name (e.g. 'Sprint 48'); a name is resolved to its " +
              "GUID automatically via the team's iteration list.",
          ),
        team: z.string().min(1).optional().describe("Team name or ID; defaults to the project's default team"),
      },
    },
    async ({ project, iterationId, team }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const effectiveProject = project ?? deps.config.defaultProject;

      // A weak model almost never knows the iteration GUID; it knows the sprint
      // name. Resolve a name to its GUID by listing the team's iterations and
      // matching case-insensitively. GUID input passes straight through.
      const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let resolvedId = iterationId;
      if (!GUID_RE.test(iterationId)) {
        const iters = await client.get<{ value?: Array<{ id?: string; name?: string }> }>(
          workPath(team, "teamsettings/iterations"),
          { project: effectiveProject },
        );
        const match = (iters.value ?? []).find(
          (it) => it.name?.toLowerCase() === iterationId.toLowerCase(),
        );
        if (!match?.id) {
          throw new Error(
            `No iteration named '${iterationId}' found in project '${effectiveProject ?? "(unknown)"}'. ` +
              `Use work_list_iterations to see available iterations and their ids.`,
          );
        }
        resolvedId = match.id;
      }

      const raw = await client.get<Record<string, unknown>>(
        workPath(team, `teamsettings/iterations/${encodeURIComponent(resolvedId)}/capacities`),
        { project: effectiveProject },
      );
      // Strip displayAttributes (UI-only display hints) from each member's activities.
      let result: unknown = raw;
      if (raw && Array.isArray(raw["teamMembers"])) {
        result = {
          ...raw,
          teamMembers: (raw["teamMembers"] as Array<Record<string, unknown>>).map((member) => ({
            ...member,
            activities: ((member["activities"] as Array<Record<string, unknown>>) ?? []).map(
              ({ displayAttributes: _d, ...rest }) => rest,
            ),
          })),
        };
      }
      return asCleanText(result);
    },
  );
}
