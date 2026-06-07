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

const TOOLS = ["pipeline_list", "pipeline_get", "build_list", "build_get"];

describe("configurePipelinesTools (read)", () => {
  it("registers the pipeline read tools", () => {
    const { tools } = setup();
    expect(TOOLS.every((name) => tools.has(name))).toBe(true);
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
