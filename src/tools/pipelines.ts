import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";
import { boundLimit, type QueryValue } from "../azure/client.js";
import { asCleanText, toRefName } from "./_shared.js";

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
      const slim = (result.value ?? []).slice(0, cap).map((p) => {
        const pipeline = p as Record<string, unknown>;
        return {
          id: pipeline["id"],
          name: pipeline["name"],
          folder: pipeline["folder"],
          revision: pipeline["revision"],
        };
      });
      return asCleanText(slim);
    },
  );

  server.registerTool(
    "pipeline_get",
    {
      description:
        "Get a single pipeline definition by id. Returns id, name, folder, revision, and the " +
        "configuration type/path/repository by default (safe for weak models). " +
        "Set includeConfiguration=true to include variables, triggers, and queue config.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        pipelineId: z.number().int().positive().describe("Pipeline id"),
        pipelineVersion: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Pipeline revision to retrieve; defaults to the latest"),
        includeConfiguration: z
          .boolean()
          .optional()
          .describe(
            "Include the full pipeline configuration (variables, triggers, queue). " +
              "Defaults to false — returns only id, name, folder, revision, and the " +
              "configuration type/path/repository reference.",
          ),
      },
    },
    async ({ project, pipelineId, pipelineVersion, includeConfiguration }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const query: Record<string, QueryValue> = { pipelineVersion };
      const pipeline = await client.get<Record<string, unknown>>(`/_apis/pipelines/${pipelineId}`, {
        project,
        query,
      });
      if (includeConfiguration) return asCleanText(pipeline);
      const config = pipeline["configuration"] as Record<string, unknown> | undefined;
      const repo = config?.["repository"] as Record<string, unknown> | undefined;
      return asCleanText({
        id: pipeline["id"],
        name: pipeline["name"],
        folder: pipeline["folder"],
        revision: pipeline["revision"],
        configuration: config
          ? {
              type: config["type"],
              path: config["path"],
              repository: repo
                ? { id: repo["id"], type: repo["type"], name: repo["name"] }
                : undefined,
            }
          : undefined,
      });
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
      const slim = (result.value ?? []).slice(0, cap).map((b) => {
        const build = b as Record<string, unknown>;
        const def = build["definition"] as Record<string, unknown> | undefined;
        return {
          id: build["id"],
          buildNumber: build["buildNumber"],
          status: build["status"],
          result: build["result"],
          startTime: build["startTime"],
          finishTime: build["finishTime"],
          sourceBranch: build["sourceBranch"],
          definition: def ? { id: def["id"], name: def["name"] } : undefined,
          requestedBy: build["requestedBy"],
        };
      });
      return asCleanText(slim);
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
      const build = await client.get<Record<string, unknown>>(`/_apis/build/builds/${buildId}`, {
        project,
      });
      const STRIP_BUILD_KEYS = new Set([
        "orchestrationPlan",
        "validationResults",
        "properties",
        "triggerInfo",
        "project",
      ]);
      const slim: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(build)) {
        if (!STRIP_BUILD_KEYS.has(k)) slim[k] = v;
      }
      return asCleanText(slim);
    },
  );

  server.registerTool(
    "build_queue",
    {
      description:
        "Queue (start) a new build for a pipeline definition. Optionally target a " +
        "source branch and pass YAML template parameters. " +
        "Returns {id, buildNumber, status, queueTime, definition} — use build_get_logs " +
        "with that buildId to follow progress.",
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
      const build = await client.post<Record<string, unknown>>("/_apis/build/builds", body, {
        project,
      });
      const def = build["definition"] as Record<string, unknown> | undefined;
      return asCleanText({
        id: build["id"],
        buildNumber: build["buildNumber"],
        status: build["status"],
        queueTime: build["queueTime"],
        definition: def ? { id: def["id"], name: def["name"] } : undefined,
      });
    },
  );

  server.registerTool(
    "build_get_logs",
    {
      description:
        "Get build logs. Two-step workflow: " +
        "(1) Call WITHOUT logId to get the list of log files for the build — each has an id and a name like 'Initialize job' or 'Run tests'. " +
        "(2) Call WITH the logId you want to read its full content as lines. " +
        "Use startLine/endLine to page through large logs. " +
        "Tip: look for the step where the build failed (non-zero exit code) and fetch that log.",
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
        return asCleanText(result.value ?? []);
      }
      const body = await client.get<unknown>(`/_apis/build/builds/${buildId}/logs/${logId}`, {
        project,
        query: { startLine, endLine },
      });
      return asCleanText(unwrapBuildLogLines(body));
    },
  );
}
