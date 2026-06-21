import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configureWorkTools } from "../../src/tools/work.js";
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
  configureWorkTools(
    server,
    createToolDeps({ config: options.config ?? config, logger: options.logger ?? logger, fetchImpl: impl }),
  );
  return { calls, tools };
}

function parseResult(result: unknown): unknown {
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text) as unknown;
}

const TOOLS = ["work_list_iterations", "work_list_backlog_levels", "work_get_capacity"];

describe("configureWorkTools", () => {
  it("registers all work tools", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual([...TOOLS].sort());
  });

  it("work_list_iterations targets the team-scoped iterations endpoint with timeframe", async () => {
    const { calls, tools } = setup({ value: [{ id: "i1" }] });
    await tools.get("work_list_iterations")!(
      { project: "Proj", team: "My Team", timeframe: "current" },
      {},
    );
    const url = calls[0]!.url;
    expect(calls[0]!.method).toBe("GET");
    expect(url).toContain("/DefaultCollection/Proj/My%20Team/_apis/work/teamsettings/iterations");
    expect(url).toContain("%24timeframe=current");
  });

  it("work_list_iterations omits the team segment when no team is given", async () => {
    const { calls, tools } = setup({ value: [] });
    await tools.get("work_list_iterations")!({ project: "Proj" }, {});
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/work/teamsettings/iterations");
    expect(calls[0]!.url).not.toContain("%24timeframe");
  });

  it("work_list_iterations bounds results to maxResults", async () => {
    const smallConfig: ServerConfig = { ...config, maxResults: 2 };
    const { tools } = setup(
      { value: [{ id: "a" }, { id: "b" }, { id: "c" }] },
      { config: smallConfig },
    );
    const iterations = parseResult(
      await tools.get("work_list_iterations")!({ project: "Proj" }, {}),
    ) as unknown[];
    expect(iterations).toHaveLength(2);
  });

  it("work_list_iterations bounds results to a smaller caller-supplied top", async () => {
    const { tools } = setup({ value: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const iterations = parseResult(
      await tools.get("work_list_iterations")!({ project: "Proj", top: 1 }, {}),
    ) as unknown[];
    expect(iterations).toHaveLength(1);
  });

  it("work_list_backlog_levels targets the team-scoped backlogs endpoint", async () => {
    const { calls, tools } = setup({ value: [{ id: "Microsoft.EpicCategory" }] });
    const levels = parseResult(
      await tools.get("work_list_backlog_levels")!({ project: "Proj", team: "Team A" }, {}),
    ) as unknown[];
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/Team%20A/_apis/work/backlogs");
    expect(levels).toHaveLength(1);
  });

  it("work_list_backlog_levels omits the team segment when no team is given", async () => {
    const { calls, tools } = setup({ value: [{ id: "Microsoft.EpicCategory" }] });
    await tools.get("work_list_backlog_levels")!({ project: "Proj" }, {});
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/work/backlogs");
  });

  it("work_list_backlog_levels bounds results to a caller-supplied top", async () => {
    const { tools } = setup({ value: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const levels = parseResult(
      await tools.get("work_list_backlog_levels")!({ project: "Proj", top: 2 }, {}),
    ) as unknown[];
    expect(levels).toHaveLength(2);
  });

  it("work_get_capacity targets the iteration capacities endpoint and returns the full object", async () => {
    const capacity = {
      teamMembers: [{ teamMember: { displayName: "Dev" }, activities: [{ capacityPerDay: 6 }] }],
      totalCapacityPerDay: 6,
      totalDaysOff: 0,
    };
    const { calls, tools } = setup(capacity);
    const result = parseResult(
      await tools.get("work_get_capacity")!(
        { project: "Proj", team: "Team A", iterationId: "f8b1a0de-1234-4abc-9def-0123456789ab" },
        {},
      ),
    );
    expect(calls[0]!.url).toContain(
      "/DefaultCollection/Proj/Team%20A/_apis/work/teamsettings/iterations/f8b1a0de-1234-4abc-9def-0123456789ab/capacities",
    );
    // teamMember is an ADO identity object; cleanAdo flattens it to the displayName string.
    expect(result).toEqual({
      teamMembers: [{ teamMember: "Dev", activities: [{ capacityPerDay: 6 }] }],
      totalCapacityPerDay: 6,
      totalDaysOff: 0,
    });
  });

  it("work_get_capacity omits the team segment when no team is given", async () => {
    const { calls, tools } = setup({ teamMembers: [], totalCapacityPerDay: 0, totalDaysOff: 0 });
    await tools.get("work_get_capacity")!(
      { project: "Proj", iterationId: "f8b1a0de-1234-4abc-9def-0123456789ab" },
      {},
    );
    expect(calls[0]!.url).toContain(
      "/DefaultCollection/Proj/_apis/work/teamsettings/iterations/f8b1a0de-1234-4abc-9def-0123456789ab/capacities",
    );
  });

  it("uses the per-request PAT from the x-ado-pat header when present", async () => {
    const { calls, tools } = setup({ value: [] });
    const extra = { requestInfo: { headers: { "x-ado-pat": "req-pat" } } };
    await tools.get("work_list_iterations")!({ project: "Proj" }, extra);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(":req-pat").toString("base64")}`);
  });

  it("surfaces a mapped ADO error when the REST call returns a 4xx", async () => {
    const { tools } = setup({ message: "TF400499: team not found" }, { status: 404 });
    await expect(
      tools.get("work_get_capacity")!({ project: "Proj", iterationId: "nope" }, {}),
    ).rejects.toThrow(/Azure DevOps API error 404: TF400499/);
  });
});
