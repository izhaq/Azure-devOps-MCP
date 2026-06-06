import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configureCoreTools } from "../../src/tools/core.js";
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
  timeoutMs: 30000,
  logLevel: "error",
};
const logger = createLogger({ level: "error", sink: () => {} });

function recordingFetch() {
  const calls: Array<{ url: string; auth: string }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ url: String(url), auth: headers?.["Authorization"] ?? "" });
    return new Response(JSON.stringify({ value: [{ name: "P1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("configureCoreTools", () => {
  it("registers core_list_projects and core_list_teams", () => {
    const { server, tools } = fakeServer();
    configureCoreTools(server, createToolDeps({ config, logger }));
    expect([...tools.keys()].sort()).toEqual(["core_list_projects", "core_list_teams"]);
  });

  it("core_list_projects queries the projects endpoint", async () => {
    const { calls, impl } = recordingFetch();
    const { server, tools } = fakeServer();
    configureCoreTools(server, createToolDeps({ config, logger, fetchImpl: impl }));
    const result = await tools.get("core_list_projects")!({}, {});
    expect(calls[0]!.url).toContain("/DefaultCollection/_apis/projects");
    expect(result.content).toBeDefined();
  });

  it("core_list_teams targets the project teams endpoint when given a project", async () => {
    const { calls, impl } = recordingFetch();
    const { server, tools } = fakeServer();
    configureCoreTools(server, createToolDeps({ config, logger, fetchImpl: impl }));
    await tools.get("core_list_teams")!({ project: "My Proj" }, {});
    expect(calls[0]!.url).toContain("/_apis/projects/My%20Proj/teams");
  });

  it("core_list_teams lists all teams when no project is given", async () => {
    const { calls, impl } = recordingFetch();
    const { server, tools } = fakeServer();
    configureCoreTools(server, createToolDeps({ config, logger, fetchImpl: impl }));
    await tools.get("core_list_teams")!({}, {});
    expect(calls[0]!.url).toContain("/DefaultCollection/_apis/teams");
  });

  it("core_list_teams uses the preview api-version for the collection-wide endpoint", async () => {
    const { calls, impl } = recordingFetch();
    const { server, tools } = fakeServer();
    configureCoreTools(server, createToolDeps({ config, logger, fetchImpl: impl }));
    await tools.get("core_list_teams")!({}, {});
    expect(calls[0]!.url).toContain("api-version=7.1-preview.3");
  });

  it("core_list_teams keeps the GA api-version for the project-scoped endpoint", async () => {
    const { calls, impl } = recordingFetch();
    const { server, tools } = fakeServer();
    configureCoreTools(server, createToolDeps({ config, logger, fetchImpl: impl }));
    await tools.get("core_list_teams")!({ project: "My Proj" }, {});
    expect(calls[0]!.url).toContain("api-version=7.1");
    expect(calls[0]!.url).not.toContain("preview");
  });

  it("core_list_projects honors the top argument by limiting returned items", async () => {
    const manyFetch = (async (url: string | URL | Request) => {
      void url;
      return new Response(
        JSON.stringify({ value: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { server, tools } = fakeServer();
    configureCoreTools(server, createToolDeps({ config, logger, fetchImpl: manyFetch }));
    const result = (await tools.get("core_list_projects")!({ top: 2 }, {})) as {
      content: Array<{ type: string; text: string }>;
    };
    const projects = JSON.parse(result.content[0]!.text) as unknown[];
    expect(projects).toHaveLength(2);
  });

  it("uses the per-request PAT from the x-ado-pat header when present", async () => {
    const { calls, impl } = recordingFetch();
    const { server, tools } = fakeServer();
    configureCoreTools(server, createToolDeps({ config, logger, fetchImpl: impl }));
    const extra = { requestInfo: { headers: { "x-ado-pat": "req-pat" } } };
    await tools.get("core_list_projects")!({}, extra);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(":req-pat").toString("base64")}`);
  });
});
