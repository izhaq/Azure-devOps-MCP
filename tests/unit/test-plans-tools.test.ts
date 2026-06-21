import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configureTestPlansTools } from "../../src/tools/test-plans.js";
import { createToolDeps } from "../../src/context.js";
import { createLogger } from "../../src/logger.js";
import type { ServerConfig } from "../../src/config.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: unknown }>;

function fakeServer() {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, cb: Handler) => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  return { server, tools };
}

const config: ServerConfig = {
  serverUrl: "https://devops.corp.local/tfs",
  collection: "DefaultCollection",
  pat: "cfg-pat",
  apiVersion: "7.1",
  httpHost: "127.0.0.1",
  httpPort: 3000,
  pageSize: 50,
  maxResults: 200,
  agentListCap: 25,
  timeoutMs: 30000,
  logLevel: "error",
};
const logger = createLogger({ level: "error", sink: () => {} });

interface Call {
  url: string;
  method: string;
  auth: string;
}

/** Fetch stub that replays a queue of responses (for continuation-token paging). */
function queueFetch(responses: Array<{ body: unknown; status?: number; continuationToken?: string }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers?.["Authorization"] ?? "",
    });
    const next = responses.shift() ?? { body: { value: [] } };
    const responseHeaders: Record<string, string> = { "content-type": "application/json" };
    if (next.continuationToken) responseHeaders["x-ms-continuationtoken"] = next.continuationToken;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: responseHeaders });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

interface SetupOptions {
  config?: ServerConfig;
}

function setup(
  responses: Array<{ body: unknown; status?: number; continuationToken?: string }>,
  options: SetupOptions = {},
) {
  const { calls, impl } = queueFetch(responses);
  const { server, tools } = fakeServer();
  configureTestPlansTools(server, createToolDeps({ config: options.config ?? config, logger, fetchImpl: impl }));
  return { calls, tools };
}

function parseResult(result: unknown): unknown {
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text) as unknown;
}

describe("configureTestPlansTools (plans)", () => {
  it("registers testplan_list", () => {
    const { tools } = setup([{ body: { value: [] } }]);
    expect(tools.has("testplan_list")).toBe(true);
  });

  it("testplan_list queries the project-scoped testplan endpoint", async () => {
    const { calls, tools } = setup([{ body: { value: [{ id: 1 }] } }]);
    const plans = parseResult(await tools.get("testplan_list")!({ project: "Proj" }, {})) as unknown[];
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/testplan/plans");
    expect(plans).toEqual([{ id: 1 }]);
  });

  it("testplan_list forwards owner and filterActivePlans filters", async () => {
    const { calls, tools } = setup([{ body: { value: [] } }]);
    await tools.get("testplan_list")!(
      { project: "Proj", owner: "Ada", filterActivePlans: true },
      {},
    );
    expect(calls[0]!.url).toContain("owner=Ada");
    expect(calls[0]!.url).toContain("filterActivePlans=true");
  });

  it("testplan_list follows the continuation token across pages", async () => {
    const { calls, tools } = setup([
      { body: { value: [{ id: 1 }, { id: 2 }] }, continuationToken: "TOKEN1" },
      { body: { value: [{ id: 3 }] } },
    ]);
    const plans = parseResult(await tools.get("testplan_list")!({ project: "Proj" }, {})) as unknown[];
    expect(plans).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(calls[1]!.url).toContain("continuationToken=TOKEN1");
  });

  it("testplan_list bounds results to top", async () => {
    const { tools } = setup([
      { body: { value: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] }, continuationToken: "T" },
    ]);
    const plans = parseResult(await tools.get("testplan_list")!({ project: "Proj", top: 2 }, {})) as unknown[];
    expect(plans).toHaveLength(2);
  });

  it("uses the per-request PAT from the x-ado-pat header when present", async () => {
    const { calls, tools } = setup([{ body: { value: [] } }]);
    const extra = { requestInfo: { headers: { "x-ado-pat": "req-pat" } } };
    await tools.get("testplan_list")!({ project: "Proj" }, extra);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(":req-pat").toString("base64")}`);
  });

  it("surfaces a mapped ADO error when the REST call returns a 4xx", async () => {
    const { tools } = setup([{ body: { message: "TF401174: project not found" }, status: 404 }]);
    await expect(tools.get("testplan_list")!({ project: "Nope" }, {})).rejects.toThrow(
      /Azure DevOps API error 404: TF401174/,
    );
  });
});

describe("configureTestPlansTools (suites + cases)", () => {
  it("registers the suite and case tools", () => {
    const { tools } = setup([{ body: { value: [] } }]);
    expect(tools.has("testplan_list_suites")).toBe(true);
    expect(tools.has("testplan_list_cases")).toBe(true);
  });

  it("testplan_list_suites queries the plan's suites endpoint", async () => {
    const { calls, tools } = setup([{ body: { value: [{ id: 10 }] } }]);
    const suites = parseResult(
      await tools.get("testplan_list_suites")!({ project: "Proj", planId: 5 }, {}),
    ) as unknown[];
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/testplan/plans/5/suites");
    expect(suites).toEqual([{ id: 10 }]);
  });

  it("testplan_list_suites forwards asTreeView", async () => {
    const { calls, tools } = setup([{ body: { value: [] } }]);
    await tools.get("testplan_list_suites")!({ project: "Proj", planId: 5, asTreeView: true }, {});
    expect(calls[0]!.url).toContain("asTreeView=true");
  });

  it("testplan_list_suites omits asTreeView when not provided", async () => {
    const { calls, tools } = setup([{ body: { value: [] } }]);
    await tools.get("testplan_list_suites")!({ project: "Proj", planId: 5 }, {});
    expect(calls[0]!.url).not.toContain("asTreeView");
  });

  it("testplan_list_suites follows the continuation token and bounds to top", async () => {
    const { calls, tools } = setup([
      { body: { value: [{ id: 1 }, { id: 2 }] }, continuationToken: "S1" },
      { body: { value: [{ id: 3 }, { id: 4 }] } },
    ]);
    const suites = parseResult(
      await tools.get("testplan_list_suites")!({ project: "Proj", planId: 5, top: 3 }, {}),
    ) as unknown[];
    expect(suites).toHaveLength(3);
    expect(calls[1]!.url).toContain("continuationToken=S1");
  });

  it("uses the per-request PAT and maps ADO errors for nested tools", async () => {
    const ok = setup([{ body: { value: [] } }]);
    const extra = { requestInfo: { headers: { "x-ado-pat": "req-pat" } } };
    await ok.tools.get("testplan_list_cases")!({ project: "Proj", planId: 5, suiteId: 9 }, extra);
    expect(ok.calls[0]!.auth).toBe(`Basic ${Buffer.from(":req-pat").toString("base64")}`);

    const err = setup([{ body: { message: "TF401174: suite not found" }, status: 404 }]);
    await expect(
      err.tools.get("testplan_list_suites")!({ project: "Proj", planId: 5 }, {}),
    ).rejects.toThrow(/Azure DevOps API error 404: TF401174/);
  });

  it("testplan_list_cases queries the suite's test case endpoint", async () => {
    const { calls, tools } = setup([{ body: { value: [{ workItem: { id: 42 } }] } }]);
    const cases = parseResult(
      await tools.get("testplan_list_cases")!({ project: "Proj", planId: 5, suiteId: 9 }, {}),
    ) as unknown[];
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/testplan/plans/5/suites/9/testcase");
    expect(cases).toEqual([{ workItem: { id: 42 } }]);
  });

  it("testplan_list_cases follows the continuation token and bounds to top", async () => {
    const { calls, tools } = setup([
      { body: { value: [{ id: 1 }, { id: 2 }] }, continuationToken: "C1" },
      { body: { value: [{ id: 3 }, { id: 4 }] } },
    ]);
    const cases = parseResult(
      await tools.get("testplan_list_cases")!({ project: "Proj", planId: 5, suiteId: 9, top: 3 }, {}),
    ) as unknown[];
    expect(cases).toHaveLength(3);
    expect(calls[1]!.url).toContain("continuationToken=C1");
  });
});
