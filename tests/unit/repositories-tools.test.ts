import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configureRepositoriesTools } from "../../src/tools/repositories.js";
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

interface Call {
  url: string;
  method: string;
  auth: string;
}

function recordingFetch(responseBody: unknown = { value: [] }) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers?.["Authorization"] ?? "",
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function setup(responseBody?: unknown) {
  const { calls, impl } = recordingFetch(responseBody);
  const { server, tools } = fakeServer();
  configureRepositoriesTools(server, createToolDeps({ config, logger, fetchImpl: impl }));
  return { calls, tools };
}

const TOOLS = [
  "repo_list",
  "repo_list_branches",
  "repo_get_file",
  "repo_list_items",
  "repo_list_commits",
  "repo_get_commit",
];

describe("configureRepositoriesTools", () => {
  it("registers all repository tools", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual([...TOOLS].sort());
  });

  it("repo_list queries the project-scoped repositories endpoint", async () => {
    const { calls, tools } = setup({ value: [{ name: "r1" }] });
    await tools.get("repo_list")!({ project: "Proj" }, {});
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/git/repositories");
  });

  it("repo_list honors top by slicing", async () => {
    const { tools } = setup({ value: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const result = (await tools.get("repo_list")!({ top: 2 }, {})) as {
      content: Array<{ type: string; text: string }>;
    };
    const repos = JSON.parse(result.content[0]!.text) as unknown[];
    expect(repos).toHaveLength(2);
  });

  it("repo_list_branches lists heads refs", async () => {
    const { calls, tools } = setup({ value: [{ name: "refs/heads/main" }] });
    await tools.get("repo_list_branches")!({ repositoryId: "my repo" }, {});
    expect(calls[0]!.url).toContain("/_apis/git/repositories/my%20repo/refs");
    expect(calls[0]!.url).toContain("filter=heads%2F");
  });

  it("repo_get_file requests item content at a path on a branch", async () => {
    const { calls, tools } = setup({ path: "/a.ts", content: "x" });
    await tools.get("repo_get_file")!(
      { repositoryId: "repo1", path: "/src/a.ts", branch: "main" },
      {},
    );
    expect(calls[0]!.url).toContain("/_apis/git/repositories/repo1/items");
    expect(calls[0]!.url).toContain("path=%2Fsrc%2Fa.ts");
    expect(calls[0]!.url).toContain("includeContent=true");
    expect(calls[0]!.url).toContain("versionDescriptor.version=main");
    expect(calls[0]!.url).toContain("versionDescriptor.versionType=branch");
  });

  it("repo_list_items defaults scopePath to / and recursion to oneLevel", async () => {
    const { calls, tools } = setup({ value: [{ path: "/" }] });
    await tools.get("repo_list_items")!({ repositoryId: "repo1" }, {});
    expect(calls[0]!.url).toContain("/_apis/git/repositories/repo1/items");
    expect(calls[0]!.url).toContain("scopePath=%2F");
    expect(calls[0]!.url).toContain("recursionLevel=oneLevel");
  });

  it("repo_list_commits maps filters onto searchCriteria params", async () => {
    const { calls, tools } = setup({ value: [{ commitId: "abc" }] });
    await tools.get("repo_list_commits")!(
      { repositoryId: "repo1", branch: "main", author: "Ada", top: 5 },
      {},
    );
    const url = calls[0]!.url;
    expect(url).toContain("/_apis/git/repositories/repo1/commits");
    expect(url).toContain("searchCriteria.itemVersion.version=main");
    expect(url).toContain("searchCriteria.itemVersion.versionType=branch");
    expect(url).toContain("searchCriteria.author=Ada");
    expect(url).toContain("searchCriteria.%24top=5");
  });

  it("repo_get_commit fetches a single commit by id", async () => {
    const { calls, tools } = setup({ commitId: "abc123" });
    await tools.get("repo_get_commit")!({ repositoryId: "repo1", commitId: "abc123" }, {});
    expect(calls[0]!.url).toContain("/_apis/git/repositories/repo1/commits/abc123");
  });

  it("uses the per-request PAT from the x-ado-pat header when present", async () => {
    const { calls, tools } = setup({ value: [] });
    const extra = { requestInfo: { headers: { "x-ado-pat": "req-pat" } } };
    await tools.get("repo_list")!({}, extra);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(":req-pat").toString("base64")}`);
  });
});
