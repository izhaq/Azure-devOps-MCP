import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configureWikiTools } from "../../src/tools/wiki.js";
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
  ifMatch: string | undefined;
}

function recordingFetch(responseBody: unknown = { value: [] }, status = 200, etag?: string) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers?.["Authorization"] ?? "",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      ifMatch: headers?.["If-Match"],
    });
    const responseHeaders: Record<string, string> = { "content-type": "application/json" };
    if (etag) responseHeaders["etag"] = etag;
    return new Response(JSON.stringify(responseBody), { status, headers: responseHeaders });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

interface SetupOptions {
  status?: number;
  etag?: string;
  config?: ServerConfig;
  logger?: Logger;
}

function setup(responseBody?: unknown, options: SetupOptions = {}) {
  const { calls, impl } = recordingFetch(responseBody, options.status, options.etag);
  const { server, tools } = fakeServer();
  configureWikiTools(
    server,
    createToolDeps({ config: options.config ?? config, logger: options.logger ?? logger, fetchImpl: impl }),
  );
  return { calls, tools };
}

function parseResult(result: unknown): unknown {
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text) as unknown;
}

describe("configureWikiTools (read)", () => {
  it("registers the wiki read tools", () => {
    const { tools } = setup();
    expect(tools.has("wiki_list")).toBe(true);
    expect(tools.has("wiki_get_page")).toBe(true);
  });

  it("wiki_list queries the project-scoped wikis endpoint", async () => {
    const { calls, tools } = setup({ value: [{ id: "w1" }] });
    await tools.get("wiki_list")!({ project: "Proj" }, {});
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/wiki/wikis");
  });

  it("wiki_list bounds results to maxResults", async () => {
    const smallConfig: ServerConfig = { ...config, maxResults: 2 };
    const { tools } = setup({ value: [{ id: "a" }, { id: "b" }, { id: "c" }] }, { config: smallConfig });
    const wikis = parseResult(await tools.get("wiki_list")!({ project: "Proj" }, {})) as unknown[];
    expect(wikis).toHaveLength(2);
  });

  it("wiki_get_page requests the page with path + includeContent and surfaces the ETag", async () => {
    const { calls, tools } = setup(
      { path: "/Home", content: "# Hello" },
      { etag: '"abc123"' },
    );
    const result = parseResult(
      await tools.get("wiki_get_page")!(
        { project: "Proj", wikiIdentifier: "MyWiki", path: "/Home" },
        {},
      ),
    ) as { page: unknown; eTag: string };
    const url = calls[0]!.url;
    expect(url).toContain("/DefaultCollection/Proj/_apis/wiki/wikis/MyWiki/pages");
    expect(url).toContain("path=%2FHome");
    expect(url).toContain("includeContent=true");
    expect(result.eTag).toBe('"abc123"');
    expect(result.page).toEqual({ path: "/Home", content: "# Hello" });
  });

  it("wiki_get_page can disable content and request a recursion level", async () => {
    const { calls, tools } = setup({ path: "/Docs" }, { etag: '"e"' });
    await tools.get("wiki_get_page")!(
      { project: "Proj", wikiIdentifier: "MyWiki", path: "/Docs", includeContent: false, recursionLevel: "oneLevel" },
      {},
    );
    const url = calls[0]!.url;
    expect(url).toContain("includeContent=false");
    expect(url).toContain("recursionLevel=oneLevel");
  });

  it("uses the per-request PAT from the x-ado-pat header when present", async () => {
    const { calls, tools } = setup({ value: [] });
    const extra = { requestInfo: { headers: { "x-ado-pat": "req-pat" } } };
    await tools.get("wiki_list")!({ project: "Proj" }, extra);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(":req-pat").toString("base64")}`);
  });

  it("surfaces a mapped ADO error when the REST call returns a 4xx", async () => {
    const { tools } = setup({ message: "TF401174: wiki page not found" }, { status: 404 });
    await expect(
      tools.get("wiki_get_page")!({ project: "Proj", wikiIdentifier: "MyWiki", path: "/nope" }, {}),
    ).rejects.toThrow(/Azure DevOps API error 404: TF401174/);
  });
});
