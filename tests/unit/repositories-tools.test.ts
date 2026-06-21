import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configureRepositoriesTools } from "../../src/tools/repositories.js";
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
}

function recordingFetch(responseBody: unknown = { value: [] }, status = 200) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers?.["Authorization"] ?? "",
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
  configureRepositoriesTools(
    server,
    createToolDeps({ config: options.config ?? config, logger: options.logger ?? logger, fetchImpl: impl }),
  );
  return { calls, tools };
}

/** Parse the JSON array a list tool returns in its single text block. */
function parseList(result: unknown): unknown[] {
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text) as unknown[];
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

  it("repo_list_branches lists heads refs and strips the refs/heads/ prefix", async () => {
    const { calls, tools } = setup({ value: [{ name: "refs/heads/main", objectId: "abc" }] });
    const branches = parseList(
      await tools.get("repo_list_branches")!({ repositoryId: "my repo" }, {}),
    ) as Array<Record<string, unknown>>;
    expect(calls[0]!.url).toContain("/_apis/git/repositories/my%20repo/refs");
    expect(calls[0]!.url).toContain("filter=heads%2F");
    expect(branches[0]!["name"]).toBe("main");
    // Other fields are preserved.
    expect(branches[0]!["objectId"]).toBe("abc");
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
    expect(calls[0]!.url).not.toContain("changeCount");
  });

  it("repo_get_commit adds changeCount when includeChanges is true", async () => {
    const { calls, tools } = setup({ commitId: "abc123", changes: [] });
    await tools.get("repo_get_commit")!(
      { repositoryId: "repo1", commitId: "abc123", includeChanges: true },
      {},
    );
    expect(calls[0]!.url).toContain("changeCount=100");
  });

  it("uses the per-request PAT from the x-ado-pat header when present", async () => {
    const { calls, tools } = setup({ value: [] });
    const extra = { requestInfo: { headers: { "x-ado-pat": "req-pat" } } };
    await tools.get("repo_list")!({}, extra);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(":req-pat").toString("base64")}`);
  });

  it("surfaces a mapped ADO error when the REST call returns a 4xx", async () => {
    const { tools } = setup({ message: "TF401019: repo not found" }, { status: 404 });
    await expect(
      tools.get("repo_get_commit")!({ repositoryId: "repo1", commitId: "deadbeef" }, {}),
    ).rejects.toThrow(/Azure DevOps API error 404: TF401019/);
  });

  it("repo_list routes collection-wide (no project segment) when project is omitted", async () => {
    const { calls, tools } = setup({ value: [] });
    await tools.get("repo_list")!({}, {});
    expect(calls[0]!.url).toContain("/DefaultCollection/_apis/git/repositories");
    expect(calls[0]!.url).not.toContain("/DefaultCollection/Proj/");
  });

  it("repo_list_commits routes collection-wide (no project segment) when project is omitted", async () => {
    const { calls, tools } = setup({ value: [] });
    await tools.get("repo_list_commits")!({ repositoryId: "repo1" }, {});
    expect(calls[0]!.url).toContain("/DefaultCollection/_apis/git/repositories/repo1/commits");
    expect(calls[0]!.url).not.toContain("/DefaultCollection/Proj/");
  });

  describe("bounds results to maxResults", () => {
    const smallConfig: ServerConfig = { ...config, maxResults: 2 };
    const fivePage = { value: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] };

    it("repo_list returns at most maxResults", async () => {
      const { tools } = setup(fivePage, { config: smallConfig });
      const repos = parseList(await tools.get("repo_list")!({}, {}));
      expect(repos).toHaveLength(2);
    });

    it("repo_list_items returns at most maxResults and notes truncation", async () => {
      const { tools } = setup(fivePage, { config: smallConfig });
      const result = (await tools.get("repo_list_items")!(
        { repositoryId: "repo1", recursionLevel: "full" },
        {},
      )) as { content: Array<{ text: string }> };
      const text = result.content[0]!.text;
      expect(text).toContain("[Truncated: showing 2 of 5 items.");
      const items = JSON.parse(text.split("\n\n[Truncated")[0]!) as unknown[];
      expect(items).toHaveLength(2);
    });

    it("repo_list_items omits the truncation note when under the cap", async () => {
      const { tools } = setup({ value: [{ path: "/a" }] });
      const items = parseList(await tools.get("repo_list_items")!({ repositoryId: "repo1" }, {}));
      expect(items).toHaveLength(1);
    });

    it("repo_list_commits returns at most maxResults when top is omitted", async () => {
      const { calls, tools } = setup(fivePage, { config: smallConfig });
      const commits = parseList(
        await tools.get("repo_list_commits")!({ repositoryId: "repo1" }, {}),
      );
      expect(commits).toHaveLength(2);
      // The cap is also pushed to the server so it does not over-return.
      expect(calls[0]!.url).toContain("searchCriteria.%24top=2");
    });
  });

  it("repo_get_file omits content above the inline byte limit instead of returning it", async () => {
    const huge = "a".repeat(1_000_001);
    const { tools } = setup({ path: "/big.bin", content: huge });
    const result = (await tools.get("repo_get_file")!(
      { repositoryId: "repo1", path: "/big.bin" },
      {},
    )) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text) as {
      contentOmitted?: boolean;
      content?: unknown;
      size?: number;
    };
    expect(payload.contentOmitted).toBe(true);
    expect(payload.content).toBeUndefined();
    expect(payload.size).toBe(1_000_001);
    expect(result.content[0]!.text).not.toContain(huge);
  });

  it("repo_get_file returns small file content inline", async () => {
    const { tools } = setup({ path: "/a.ts", content: "hello" });
    const result = (await tools.get("repo_get_file")!(
      { repositoryId: "repo1", path: "/a.ts" },
      {},
    )) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text) as { content?: string };
    expect(payload.content).toBe("hello");
  });

  it("never writes the PAT to the logger", async () => {
    const lines: string[] = [];
    const capturing = createLogger({ level: "debug", sink: (line) => lines.push(line) });
    const { tools } = setup(
      { path: "/a.ts", content: "x" },
      { logger: capturing },
    );
    const extra = { requestInfo: { headers: { "x-ado-pat": "super-secret-pat" } } };
    await tools.get("repo_get_file")!({ repositoryId: "repo1", path: "/a.ts" }, extra);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("super-secret-pat");
    }
  });
});
