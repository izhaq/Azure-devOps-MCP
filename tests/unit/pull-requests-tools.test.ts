import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configurePullRequestTools } from "../../src/tools/repositories.js";
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
  configurePullRequestTools(
    server,
    createToolDeps({ config: options.config ?? config, logger: options.logger ?? logger, fetchImpl: impl }),
  );
  return { calls, tools };
}

function parseResult(result: unknown): unknown {
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text) as unknown;
}

/** Fetch that returns a different body per (url, method), recording each call. */
function routedSetup(routes: (url: string, method: string) => unknown) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const method = init?.method ?? "GET";
    calls.push({
      url: String(url),
      method,
      auth: headers?.["Authorization"] ?? "",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      contentType: headers?.["Content-Type"] ?? "",
    });
    return new Response(JSON.stringify(routes(String(url), method)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const { server, tools } = fakeServer();
  configurePullRequestTools(
    server,
    createToolDeps({ config, logger, fetchImpl: impl }),
  );
  return { calls, tools };
}

const TOOLS = ["pr_list", "pr_get", "pr_list_threads", "pr_create", "pr_add_comment", "pr_update_status"];

describe("configurePullRequestTools", () => {
  it("registers all pull request tools", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual([...TOOLS].sort());
  });

  it("pr_list queries the repo-scoped pullrequests endpoint with filters", async () => {
    const { calls, tools } = setup({ value: [{ pullRequestId: 1 }] });
    await tools.get("pr_list")!(
      { repositoryId: "repo1", project: "Proj", status: "active", targetBranch: "main" },
      {},
    );
    const url = calls[0]!.url;
    expect(calls[0]!.method).toBe("GET");
    expect(url).toContain("/DefaultCollection/Proj/_apis/git/repositories/repo1/pullrequests");
    expect(url).toContain("searchCriteria.status=active");
    expect(url).toContain("searchCriteria.targetRefName=refs%2Fheads%2Fmain");
  });

  it("pr_list bounds results to maxResults", async () => {
    const smallConfig: ServerConfig = { ...config, maxResults: 2 };
    const { calls, tools } = setup(
      { value: [{ pullRequestId: 1 }, { pullRequestId: 2 }, { pullRequestId: 3 }] },
      { config: smallConfig },
    );
    const prs = parseResult(await tools.get("pr_list")!({ repositoryId: "repo1" }, {})) as unknown[];
    expect(prs).toHaveLength(2);
    expect(calls[0]!.url).toContain("%24top=2");
  });

  it("pr_get fetches a single pull request by id", async () => {
    const { calls, tools } = setup({ pullRequestId: 42 });
    await tools.get("pr_get")!({ repositoryId: "repo1", pullRequestId: 42 }, {});
    expect(calls[0]!.url).toContain("/_apis/git/repositories/repo1/pullrequests/42");
  });

  it("pr_list_threads lists threads for a pull request", async () => {
    const { calls, tools } = setup({ value: [{ id: 7 }] });
    await tools.get("pr_list_threads")!({ repositoryId: "repo1", pullRequestId: 42 }, {});
    expect(calls[0]!.url).toContain("/_apis/git/repositories/repo1/pullrequests/42/threads");
  });

  it("pr_list_threads bounds results to maxResults", async () => {
    const smallConfig: ServerConfig = { ...config, maxResults: 2 };
    const { tools } = setup(
      { value: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      { config: smallConfig },
    );
    const threads = parseResult(
      await tools.get("pr_list_threads")!({ repositoryId: "repo1", pullRequestId: 42 }, {}),
    ) as unknown[];
    expect(threads).toHaveLength(2);
  });

  it("pr_list_threads strips noisy thread and comment fields", async () => {
    const { tools } = setup({
      value: [
        {
          id: 7,
          status: "active",
          threadContext: { filePath: "/x.ts" },
          pullRequestThreadContext: { iterationContext: {} },
          isDeleted: false,
          properties: { foo: "bar" },
          comments: [
            { id: 1, content: "hi", usersLiked: [{ displayName: "A" }], author: { displayName: "B" } },
          ],
        },
      ],
    });
    const threads = parseResult(
      await tools.get("pr_list_threads")!({ repositoryId: "repo1", pullRequestId: 42 }, {}),
    ) as Array<Record<string, unknown>>;
    const thread = threads[0]!;
    expect(thread).not.toHaveProperty("threadContext");
    expect(thread).not.toHaveProperty("pullRequestThreadContext");
    expect(thread).not.toHaveProperty("isDeleted");
    expect(thread).not.toHaveProperty("properties");
    expect(thread).toHaveProperty("status", "active");
    const comment = (thread["comments"] as Array<Record<string, unknown>>)[0]!;
    expect(comment).not.toHaveProperty("usersLiked");
    // cleanAdo flattens the identity object to the display name.
    expect(comment["author"]).toBe("B");
  });

  it("pr_list_threads returns a summary when the payload exceeds the inline budget", async () => {
    const big = "x".repeat(60_000);
    const { tools } = setup({ value: [{ id: 1, comments: [{ id: 1, content: big }] }] });
    const res = (await tools.get("pr_list_threads")!(
      { repositoryId: "repo1", pullRequestId: 42 },
      {},
    )) as { content: Array<{ text: string }> };
    expect(res.content[0]!.text).toContain("too large to return inline");
  });

  it("uses the per-request PAT from the x-ado-pat header when present", async () => {
    const { calls, tools } = setup({ value: [] });
    const extra = { requestInfo: { headers: { "x-ado-pat": "req-pat" } } };
    await tools.get("pr_list")!({ repositoryId: "repo1" }, extra);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(":req-pat").toString("base64")}`);
  });

  it("surfaces a mapped ADO error when the REST call returns a 4xx", async () => {
    const { tools } = setup({ message: "TF401019: pr not found" }, { status: 404 });
    await expect(
      tools.get("pr_get")!({ repositoryId: "repo1", pullRequestId: 999 }, {}),
    ).rejects.toThrow(/Azure DevOps API error 404: TF401019/);
  });

  it("pr_create POSTs full refs and title to the pullrequests endpoint", async () => {
    const { calls, tools } = setup({ pullRequestId: 5 });
    await tools.get("pr_create")!(
      {
        repositoryId: "repo1",
        sourceBranch: "feature/x",
        targetBranch: "refs/heads/main",
        title: "Add x",
        description: "why",
      },
      {},
    );
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("/_apis/git/repositories/repo1/pullrequests");
    expect(call.body).toEqual({
      sourceRefName: "refs/heads/feature/x",
      targetRefName: "refs/heads/main",
      title: "Add x",
      description: "why",
    });
  });

  it("pr_add_comment POSTs a new thread with the comment text", async () => {
    const { calls, tools } = setup({ id: 11 });
    await tools.get("pr_add_comment")!(
      { repositoryId: "repo1", pullRequestId: 5, content: "looks good" },
      {},
    );
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("/_apis/git/repositories/repo1/pullrequests/5/threads");
    expect(call.body).toEqual({
      comments: [{ parentCommentId: 0, content: "looks good", commentType: "text" }],
    });
  });

  it("pr_update_status PATCHes the status field", async () => {
    const { calls, tools } = setup({ pullRequestId: 5, status: "abandoned" });
    await tools.get("pr_update_status")!(
      { repositoryId: "repo1", pullRequestId: 5, status: "abandoned" },
      {},
    );
    const call = calls[0]!;
    expect(call.method).toBe("PATCH");
    expect(call.url).toContain("/_apis/git/repositories/repo1/pullrequests/5");
    expect(call.body).toEqual({ status: "abandoned" });
  });

  it("pr_update_status auto-fetches lastMergeSourceCommit when completing without an id", async () => {
    const { calls, tools } = routedSetup((url, method) => {
      // PATCH completes the PR; GET fetches the source commit id.
      if (method === "PATCH") return { pullRequestId: 5, status: "completed" };
      return { lastMergeSourceCommit: { commitId: "tip999" } };
    });
    await tools.get("pr_update_status")!(
      { repositoryId: "repo1", pullRequestId: 5, status: "completed" },
      {},
    );
    // First a GET to read the tip commit, then a PATCH carrying it.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.body).toEqual({
      status: "completed",
      lastMergeSourceCommit: { commitId: "tip999" },
    });
  });

  it("pr_update_status throws when the PR has no source commit to auto-fetch", async () => {
    const { tools } = routedSetup((url, method) => (method === "PATCH" ? {} : { pullRequestId: 5 }));
    await expect(
      tools.get("pr_update_status")!(
        { repositoryId: "repo1", pullRequestId: 5, status: "completed" },
        {},
      ),
    ).rejects.toThrow(/Could not auto-fetch lastMergeSourceCommitId/);
  });

  it("pr_update_status includes lastMergeSourceCommit when completing with a source commit id", async () => {
    const { calls, tools } = setup({ pullRequestId: 5, status: "completed" });
    await tools.get("pr_update_status")!(
      {
        repositoryId: "repo1",
        pullRequestId: 5,
        status: "completed",
        lastMergeSourceCommitId: "abc123",
      },
      {},
    );
    expect(calls[0]!.body).toEqual({
      status: "completed",
      lastMergeSourceCommit: { commitId: "abc123" },
    });
  });
});
