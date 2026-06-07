import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";
import { boundLimit, type QueryValue } from "../azure/client.js";
import { asText, toRefName } from "./_shared.js";

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
 * Unwrap build log lines from the ADO JSON response. "Get Build Log" returns
 * `{ count, value: string[] }` when `Accept: application/json` (api-version 7.1):
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/get-build-log
 * Some servers may return a bare `string[]`; accept both and always return lines.
 */
function unwrapBuildLogLines(body: unknown): string[] {
  if (Array.isArray(body)) return body as string[];
  if (
    body !== null &&
    typeof body === "object" &&
    "value" in body &&
    Array.isArray((body as { value: unknown }).value)
  ) {
    return (body as { value: string[] }).value;
  }
  return [];
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

  server.registerTool(
    "build_queue",
    {
      description:
        "Queue (start) a new build for a pipeline definition. Optionally target a " +
        "source branch and pass YAML template parameters.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        definitionId: z.number().int().positive().describe("Pipeline definition id to queue"),
        sourceBranch: z
          .string()
          .min(1)
          .optional()
          .describe("Source branch to build (short name or full ref); defaults to the pipeline default"),
        templateParameters: z
          .record(z.string(), z.string())
          .optional()
          .describe("Runtime YAML template parameters (name -> value)"),
      },
    },
    async ({ project, definitionId, sourceBranch, templateParameters }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const body: Record<string, unknown> = { definition: { id: definitionId } };
      if (sourceBranch) body["sourceBranch"] = toRefName(sourceBranch);
      if (templateParameters) body["templateParameters"] = templateParameters;
      const build = await client.post("/_apis/build/builds", body, { project });
      return asText(build);
    },
  );

  server.registerTool(
    "build_get_logs",
    {
      description:
        "Get build logs. Without logId, returns the list of log files (metadata) for " +
        "the build so you can pick one. With logId, returns that log's content as lines " +
        "(optionally a startLine..endLine range).",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        buildId: z.number().int().positive().describe("Build id"),
        logId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Log file id; omit to list the build's logs"),
        startLine: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("First line of the log to return; only used when logId is set"),
        endLine: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Last line of the log to return; only used when logId is set"),
      },
    },
    async ({ project, buildId, logId, startLine, endLine }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      if (logId === undefined) {
        const result = await client.get<{ value?: unknown[] }>(
          `/_apis/build/builds/${buildId}/logs`,
          { project },
        );
        return asText(result.value ?? []);
      }
      const body = await client.get<unknown>(`/_apis/build/builds/${buildId}/logs/${logId}`, {
        project,
        query: { startLine, endLine },
      });
      return asText(unwrapBuildLogLines(body));
    },
  );
}
