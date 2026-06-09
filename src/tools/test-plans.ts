import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDeps, patFromExtra } from "../context.js";
import type { QueryValue } from "../azure/client.js";
import { asText } from "./_shared.js";

/**
 * test-plans domain: test plans, their suites, and the test cases in a suite.
 * Uses the modern `testplan` REST area (not the legacy `test` area). All are
 * project-scoped, so `project` is required on every tool. These endpoints page
 * via the `x-ms-continuationtoken` header, so the tools use `client.getAll`,
 * which follows that token and caps results at `maxResults` (or `top`).
 *   GET {project}/_apis/testplan/plans                                   (testplan_list)
 * Source: https://learn.microsoft.com/en-us/rest/api/azure/devops/testplan (api-version 7.1)
 */
export function configureTestPlansTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "testplan_list",
    {
      description: "List the test plans in a project.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        owner: z.string().min(1).optional().describe("Filter to plans owned by this user (name or ID)"),
        filterActivePlans: z
          .boolean()
          .optional()
          .describe("Only return plans whose dates are active (not past)"),
        top: z
          .number()
          .int()
          .positive()
          .max(deps.config.maxResults)
          .optional()
          .describe("Maximum number of plans"),
      },
    },
    async ({ project, owner, filterActivePlans, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const query: Record<string, QueryValue> = { owner, filterActivePlans };
      const plans = await client.getAll("/_apis/testplan/plans", { project, query }, top);
      return asText(plans);
    },
  );
}
