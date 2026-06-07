import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";
import { boundLimit, type QueryValue } from "../azure/client.js";
import { asText } from "./_shared.js";

/**
 * pipelines domain: Azure Pipelines (definitions) + Builds (runs).
 * Endpoints (Azure DevOps Server, api-version configurable). All are
 * project-scoped, so `project` is required on every tool.
 *   GET  {project}/_apis/pipelines                              (pipeline_list)
 *   GET  {project}/_apis/pipelines/{pipelineId}                 (pipeline_get)
 *   GET  {project}/_apis/build/builds                           (build_list)
 *   GET  {project}/_apis/build/builds/{buildId}                 (build_get)
 *   POST {project}/_apis/build/builds                           (build_queue)
 *   GET  {project}/_apis/build/builds/{buildId}/logs           (build_get_logs, list)
 *   GET  {project}/_apis/build/builds/{buildId}/logs/{logId}   (build_get_logs, content)
 * Sources (api-version 7.1):
 *   https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines
 *   https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds
 */

/** ADO `BuildStatus` filter values for build_list. */
const BUILD_STATUS = [
  "none",
  "inProgress",
  "completed",
  "cancelling",
  "postponed",
  "notStarted",
  "all",
] as const;

/** ADO `BuildResult` filter values for build_list. */
const BUILD_RESULT = ["none", "succeeded", "partiallySucceeded", "failed", "canceled"] as const;

/**
 * Normalise a branch name to a full Git ref. Accepts either a short name
 * (`main`) or an already-qualified ref (`refs/heads/main`). The Build API's
 * `branchName` filter and `sourceBranch` both expect a full ref.
 */
function toRefName(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

export function configurePipelinesTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "pipeline_list",
    {
      description: "List pipelines (pipeline definitions) in a project.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        top: z
          .number()
          .int()
          .positive()
          .max(deps.config.maxResults)
          .optional()
          .describe("Maximum number of pipelines"),
      },
    },
    async ({ project, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const cap = boundLimit(top, deps.config.maxResults);
      const result = await client.get<{ value?: unknown[] }>("/_apis/pipelines", {
        project,
        query: { $top: cap },
      });
      return asText((result.value ?? []).slice(0, cap));
    },
  );

  server.registerTool(
    "pipeline_get",
    {
      description: "Get a single pipeline by id, including its configuration.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        pipelineId: z.number().int().positive().describe("Pipeline id"),
        pipelineVersion: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Pipeline revision to retrieve; defaults to the latest"),
      },
    },
    async ({ project, pipelineId, pipelineVersion }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const query: Record<string, QueryValue> = { pipelineVersion };
      const pipeline = await client.get(`/_apis/pipelines/${pipelineId}`, { project, query });
      return asText(pipeline);
    },
  );

  server.registerTool(
    "build_list",
    {
      description:
        "List builds in a project, optionally filtered by pipeline definitions, branch, status, or result.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        definitionIds: z
          .array(z.number().int().positive())
          .nonempty()
          .optional()
          .describe("Filter to these pipeline definition ids"),
        branch: z
          .string()
          .min(1)
          .optional()
          .describe("Filter by source branch (short name or full ref)"),
        statusFilter: z.enum(BUILD_STATUS).optional().describe("Filter by build status"),
        resultFilter: z.enum(BUILD_RESULT).optional().describe("Filter by build result"),
        top: z
          .number()
          .int()
          .positive()
          .max(deps.config.maxResults)
          .optional()
          .describe("Maximum number of builds"),
      },
    },
    async ({ project, definitionIds, branch, statusFilter, resultFilter, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const cap = boundLimit(top, deps.config.maxResults);
      const query: Record<string, QueryValue> = {
        definitions: definitionIds?.join(","),
        branchName: branch ? toRefName(branch) : undefined,
        statusFilter,
        resultFilter,
        $top: cap,
      };
      const result = await client.get<{ value?: unknown[] }>("/_apis/build/builds", {
        project,
        query,
      });
      return asText((result.value ?? []).slice(0, cap));
    },
  );

  server.registerTool(
    "build_get",
    {
      description: "Get a single build by id.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        buildId: z.number().int().positive().describe("Build id"),
      },
    },
    async ({ project, buildId }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const build = await client.get(`/_apis/build/builds/${buildId}`, { project });
      return asText(build);
    },
  );
}
