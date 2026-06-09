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
 *   GET {project}/_apis/testplan/plans/{planId}/suites                   (testplan_list_suites)
 *   GET {project}/_apis/testplan/plans/{planId}/suites/{suiteId}/testcase (testplan_list_cases)
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

  server.registerTool(
    "testplan_list_suites",
    {
      description:
        "List the test suites in a test plan. Pass asTreeView=true to get the suite hierarchy " +
        "(parent/child) instead of a flat list.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        planId: z.number().int().positive().describe("Test plan id"),
        asTreeView: z
          .boolean()
          .optional()
          .describe("Return suites as a parent/child tree instead of a flat list"),
        top: z
          .number()
          .int()
          .positive()
          .max(deps.config.maxResults)
          .optional()
          .describe("Maximum number of suites"),
      },
    },
    async ({ project, planId, asTreeView, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const query: Record<string, QueryValue> = { asTreeView };
      const suites = await client.getAll(
        `/_apis/testplan/plans/${planId}/suites`,
        { project, query },
        top,
      );
      return asText(suites);
    },
  );

  server.registerTool(
    "testplan_list_cases",
    {
      description: "List the test cases in a test suite of a plan.",
      inputSchema: {
        project: z.string().min(1).describe("Project name or ID"),
        planId: z.number().int().positive().describe("Test plan id"),
        suiteId: z.number().int().positive().describe("Test suite id"),
        top: z
          .number()
          .int()
          .positive()
          .max(deps.config.maxResults)
          .optional()
          .describe("Maximum number of test cases"),
      },
    },
    async ({ project, planId, suiteId, top }, extra) => {
      const client = deps.clientFor(patFromExtra(extra));
      const cases = await client.getAll(
        `/_apis/testplan/plans/${planId}/suites/${suiteId}/testcase`,
        { project },
        top,
      );
      return asText(cases);
    },
  );
}
