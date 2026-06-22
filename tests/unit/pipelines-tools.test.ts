import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configurePipelinesTools } from "../../src/tools/pipelines.js";
import { createToolDeps } from "../../src/context.js";
import { createLogger, type Logger } from "../../src/logger.js";
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
  body: unknown;
  contentType: string;
}

function recordingFetch(responseBody: unknown = { value: [] }, status = 200) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers?.["Authorization"] ?? "",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      contentType: headers?.["Content-Type"] ?? "",
    });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

interface SetupOptions {
  status?: number;
  config?: ServerConfig;
  logger?: Logger;
}

function setup(responseBody?: unknown, options: SetupOptions = {}) {
  const { calls, impl } = recordingFetch(responseBody, options.status);
  const { server, tools } = fakeServer();
  configurePipelinesTools(
    server,
    createToolDeps({ config: options.config ?? config, logger: options.logger ?? logger, fetchImpl: impl }),
  );
  return { calls, tools };
}

function parseResult(result: unknown): unknown {
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text) as unknown;
}

const TOOLS = [
  "pipeline_list",
  "pipeline_get",
  "build_list",
  "build_get",
  "build_queue",
  "build_get_logs",
];

describe("configurePipelinesTools (read)", () => {
  it("registers all pipeline tools", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual([...TOOLS].sort());
  });

  it("pipeline_list queries the project-scoped pipelines endpoint", async () => {
    const { calls, tools } = setup({ value: [{ id: 1 }] });
    await tools.get("pipeline_list")!({ project: "Proj" }, {});
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/pipelines");
  });

  it("pipeline_list bounds results to maxResults", async () => {
    const smallConfig: ServerConfig = { ...config, maxResults: 2 };
    const { calls, tools } = setup(
      { value: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      { config: smallConfig },
    );
    const pipelines = parseResult(
      await tools.get("pipeline_list")!({ project: "Proj" }, {}),
    ) as unknown[];
    expect(pipelines).toHaveLength(2);
    expect(calls[0]!.url).toContain("%24top=2");
  });

  it("pipeline_get fetches a single pipeline by id with optional version", async () => {
    const { calls, tools } = setup({ id: 7 });
    await tools.get("pipeline_get")!({ project: "Proj", pipelineId: 7, pipelineVersion: 3 }, {});
    expect(calls[0]!.url).toContain("/_apis/pipelines/7");
    expect(calls[0]!.url).toContain("pipelineVersion=3");
  });

  it("pipeline_get omits pipelineVersion from the URL when not provided", async () => {
    const { calls, tools } = setup({ id: 7 });
    await tools.get("pipeline_get")!({ project: "Proj", pipelineId: 7 }, {});
    expect(calls[0]!.url).toContain("/_apis/pipelines/7");
    expect(calls[0]!.url).not.toContain("pipelineVersion");
  });

  it("pipeline_get returns slim fields by default and full config when includeConfiguration=true", async () => {
    const fullPipeline = {
      id: 7,
      name: "ci-build",
      folder: "\\",
      revision: 3,
      configuration: {
        type: "yaml",
        path: "/azure-pipelines.yml",
        repository: { id: "repo-guid", type: "azureReposGit", name: "my-repo" },
        variables: { BIG: "lots of data" },
        triggers: [{ type: "continuous" }],
      },
    };
    const { tools } = setup(fullPipeline);

    // Default (slim)
    const slim = parseResult(
      await tools.get("pipeline_get")!({ project: "Proj", pipelineId: 7 }, {}),
    ) as Record<string, unknown>;
    expect(slim["id"]).toBe(7);
    expect(slim["name"]).toBe("ci-build");
    const cfg = slim["configuration"] as Record<string, unknown>;
    expect(cfg["type"]).toBe("yaml");
    expect(cfg["path"]).toBe("/azure-pipelines.yml");
    expect(cfg).not.toHaveProperty("variables");
    expect(cfg).not.toHaveProperty("triggers");

    // With includeConfiguration=true
    const full = parseResult(
      await tools.get("pipeline_get")!(
        { project: "Proj", pipelineId: 7, includeConfiguration: true },
        {},
      ),
    ) as Record<string, unknown>;
    const fullCfg = full["configuration"] as Record<string, unknown>;
    expect(fullCfg).toHaveProperty("variables");
    expect(fullCfg).toHaveProperty("triggers");
  });

  it("build_list applies definition/branch/status/result filters", async () => {
    const { calls, tools } = setup({ value: [{ id: 100 }] });
    await tools.get("build_list")!(
      {
        project: "Proj",
        definitionIds: [4, 5],
        branch: "main",
        statusFilter: "completed",
        resultFilter: "succeeded",
      },
      {},
    );
    const url = calls[0]!.url;
    expect(url).toContain("/_apis/build/builds");
    expect(url).toContain("definitions=4%2C5");
    expect(url).toContain("branchName=refs%2Fheads%2Fmain");
    expect(url).toContain("statusFilter=completed");
    expect(url).toContain("resultFilter=succeeded");
  });

  it("build_list bounds results to maxResults", async () => {
    const smallConfig: ServerConfig = { ...config, maxResults: 1 };
    const { tools } = setup({ value: [{ id: 1 }, { id: 2 }] }, { config: smallConfig });
    const builds = parseResult(await tools.get("build_list")!({ project: "Proj" }, {})) as unknown[];
    expect(builds).toHaveLength(1);
  });

  it("build_get fetches a single build by id", async () => {
    const { calls, tools } = setup({ id: 100 });
    await tools.get("build_get")!({ project: "Proj", buildId: 100 }, {});
    expect(calls[0]!.url).toContain("/_apis/build/builds/100");
  });

  it("uses the per-request PAT from the x-ado-pat header when present", async () => {
    const { calls, tools } = setup({ value: [] });
    const extra = { requestInfo: { headers: { "x-ado-pat": "req-pat" } } };
    await tools.get("pipeline_list")!({ project: "Proj" }, extra);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(":req-pat").toString("base64")}`);
  });

  it("surfaces a mapped ADO error when the REST call returns a 4xx", async () => {
    const { tools } = setup({ message: "TF400813: build not found" }, { status: 404 });
    await expect(
      tools.get("build_get")!({ project: "Proj", buildId: 999 }, {}),
    ).rejects.toThrow(/Azure DevOps API error 404: TF400813/);
  });
});

describe("configurePipelinesTools (write + logs)", () => {
  it("build_queue POSTs the definition and normalized source branch", async () => {
    const { calls, tools } = setup({ id: 100, status: "notStarted" });
    await tools.get("build_queue")!(
      {
        project: "Proj",
        definitionId: 5,
        sourceBranch: "feature/x",
        templateParameters: { env: "dev" },
      },
      {},
    );
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("/_apis/build/builds");
    expect(call.body).toEqual({
      definition: { id: 5 },
      sourceBranch: "refs/heads/feature/x",
      templateParameters: { env: "dev" },
    });
  });

  it("build_queue omits optional fields when not provided", async () => {
    const { calls, tools } = setup({ id: 101 });
    await tools.get("build_queue")!({ project: "Proj", definitionId: 5 }, {});
    expect(calls[0]!.body).toEqual({ definition: { id: 5 } });
  });

  it("build_queue returns a slim confirmation object", async () => {
    const { tools } = setup({
      id: 42,
      buildNumber: "20240101.1",
      status: "notStarted",
      queueTime: "2024-01-01T00:00:00Z",
      definition: { id: 5, name: "ci-build" },
      orchestrationPlan: { planId: "guid" },
      validationResults: [],
    });
    const result = parseResult(
      await tools.get("build_queue")!({ project: "Proj", definitionId: 5 }, {}),
    ) as Record<string, unknown>;
    expect(result["id"]).toBe(42);
    expect(result["buildNumber"]).toBe("20240101.1");
    expect(result["status"]).toBe("notStarted");
    expect(result).not.toHaveProperty("orchestrationPlan");
    expect(result).not.toHaveProperty("validationResults");
    const def = result["definition"] as Record<string, unknown>;
    expect(def["name"]).toBe("ci-build");
  });

  it("build_get_logs lists logs when no logId is given", async () => {
    const { calls, tools } = setup({ count: 2, value: [{ id: 1 }, { id: 2 }] });
    const logs = parseResult(
      await tools.get("build_get_logs")!({ project: "Proj", buildId: 100 }, {}),
    ) as unknown[];
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/_apis/build/builds/100/logs");
    expect(calls[0]!.url).not.toContain("/logs/");
    expect(logs).toHaveLength(2);
  });

  it("build_get_logs unwraps a single log's content from the ADO { count, value } shape", async () => {
    const { calls, tools } = setup({ count: 2, value: ["line 1", "line 2"] });
    const lines = parseResult(
      await tools.get("build_get_logs")!(
        { project: "Proj", buildId: 100, logId: 7, startLine: 0, endLine: 50 },
        {},
      ),
    ) as string[];
    const url = calls[0]!.url;
    expect(url).toContain("/_apis/build/builds/100/logs/7");
    expect(url).toContain("startLine=0");
    expect(url).toContain("endLine=50");
    expect(lines).toEqual(["line 1", "line 2"]);
  });

  it("build_get_logs accepts a bare string[] log body for back-compat", async () => {
    const { tools } = setup(["legacy line 1", "legacy line 2"]);
    const lines = parseResult(
      await tools.get("build_get_logs")!({ project: "Proj", buildId: 100, logId: 7 }, {}),
    ) as string[];
    expect(lines).toEqual(["legacy line 1", "legacy line 2"]);
  });
});
