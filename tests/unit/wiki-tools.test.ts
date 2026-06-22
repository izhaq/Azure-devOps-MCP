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

  it("wiki_list falls back to ADO_DEFAULT_PROJECT when project is omitted", async () => {
    const cfgWithDefault: ServerConfig = { ...config, defaultProject: "DefaultProj" };
    const { calls, tools } = setup({ value: [] }, { config: cfgWithDefault });
    await tools.get("wiki_list")!({}, {});
    expect(calls[0]!.url).toContain("/DefaultCollection/DefaultProj/_apis/wiki/wikis");
  });

  it("wiki_get_page falls back to ADO_DEFAULT_PROJECT when project is omitted", async () => {
    const cfgWithDefault: ServerConfig = { ...config, defaultProject: "DefaultProj" };
    const { calls, tools } = setup({ path: "/Home", content: "x" }, { config: cfgWithDefault, etag: '"e"' });
    await tools.get("wiki_get_page")!({ wikiIdentifier: "MyWiki", path: "/Home" }, {});
    expect(calls[0]!.url).toContain("/DefaultCollection/DefaultProj/_apis/wiki/wikis/");
  });

  it("wiki_list slims objects to id/name/type only", async () => {
    const { tools } = setup({
      value: [{ id: "w1", name: "project-wiki", type: "projectWiki", repositoryId: "r1", mappedPath: "/", remoteUrl: "https://..." }],
    });
    const wikis = parseResult(await tools.get("wiki_list")!({ project: "Proj" }, {})) as Array<Record<string, unknown>>;
    expect(wikis[0]).toEqual({ id: "w1", name: "project-wiki", type: "projectWiki" });
    expect(wikis[0]).not.toHaveProperty("repositoryId");
    expect(wikis[0]).not.toHaveProperty("remoteUrl");
  });

  it("wiki_get_page with recursionLevel returns top-level sections only by default", async () => {
    const { calls, tools } = setup(
      {
        path: "/",
        subPages: [
          { path: "/Home", subPages: [] },
          { path: "/Docs", subPages: [{ path: "/Docs/Setup", subPages: [] }] },
        ],
      },
      { etag: '"e"' },
    );
    const result = (await tools.get("wiki_get_page")!(
      { project: "Proj", wikiIdentifier: "MyWiki", path: "/", recursionLevel: "full" },
      {},
    )) as { content: Array<{ text: string }> };
    const text = result.content[0]!.text;
    // Top-level sections are shown
    expect(text).toContain("/Home");
    expect(text).toContain("/Docs");
    // Sub-sections are hidden by default
    expect(text).not.toContain("/Docs/Setup");
    expect(text).not.toContain("gitItemPath");
    expect(text).not.toContain("isParentPage");
    // Content should default to false when recursionLevel is set
    expect(calls[0]!.url).toContain("includeContent=false");
  });

  it("wiki_get_page with showSubSections=true returns the full nested tree", async () => {
    const { tools } = setup(
      {
        path: "/",
        subPages: [
          { path: "/Home", subPages: [] },
          { path: "/Docs", subPages: [{ path: "/Docs/Setup", subPages: [] }] },
        ],
      },
      { etag: '"e"' },
    );
    const result = (await tools.get("wiki_get_page")!(
      { project: "Proj", wikiIdentifier: "MyWiki", path: "/", recursionLevel: "full", showSubSections: true },
      {},
    )) as { content: Array<{ text: string }> };
    const text = result.content[0]!.text;
    expect(text).toContain("/Home");
    expect(text).toContain("/Docs");
    expect(text).toContain("/Docs/Setup");
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

  it("url-encodes a wiki identifier that contains spaces", async () => {
    const { calls, tools } = setup({ path: "/Home" }, { etag: '"e"' });
    await tools.get("wiki_get_page")!(
      { project: "Proj", wikiIdentifier: "My Wiki", path: "/Home" },
      {},
    );
    expect(calls[0]!.url).toContain("/_apis/wiki/wikis/My%20Wiki/pages");
  });

  it("omits content and reports size when the page exceeds the inline limit", async () => {
    const huge = "x".repeat(1_000_001);
    const { tools } = setup({ path: "/Big", content: huge, id: 7 }, { etag: '"e"' });
    const result = parseResult(
      await tools.get("wiki_get_page")!({ project: "Proj", wikiIdentifier: "MyWiki", path: "/Big" }, {}),
    ) as { page: Record<string, unknown>; eTag: string; message: string };
    expect(result.page.content).toBeUndefined();
    expect(result.page.contentOmitted).toBe(true);
    expect(result.page.id).toBe(7);
    expect(typeof result.page.size).toBe("number");
    expect(result.message).toMatch(/exceeds the 1000000-byte inline limit/);
    expect(result.eTag).toBe('"e"');
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

describe("configureWikiTools (write)", () => {
  it("wiki_create_or_update_page falls back to ADO_DEFAULT_PROJECT when project is omitted", async () => {
    const cfgWithDefault: ServerConfig = { ...config, defaultProject: "DefaultProj" };
    const { calls, tools } = setup({ path: "/New", content: "hi" }, { config: cfgWithDefault, etag: '"v1"' });
    await tools.get("wiki_create_or_update_page")!(
      { wikiIdentifier: "MyWiki", path: "/New", content: "hi" },
      {},
    );
    expect(calls[0]!.url).toContain("/DefaultCollection/DefaultProj/_apis/wiki/wikis/");
  });

  it("registers the create-or-update tool", () => {
    const { tools } = setup();
    expect(tools.has("wiki_create_or_update_page")).toBe(true);
  });

  it("creates a page with a PUT body and no If-Match when version is omitted", async () => {
    const { calls, tools } = setup({ path: "/New", content: "hi" }, { etag: '"v1"' });
    const result = parseResult(
      await tools.get("wiki_create_or_update_page")!(
        { project: "Proj", wikiIdentifier: "MyWiki", path: "/New", content: "hi" },
        {},
      ),
    ) as { page: unknown; eTag: string };
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/wiki/wikis/MyWiki/pages");
    expect(calls[0]!.url).toContain("path=%2FNew");
    expect(calls[0]!.body).toEqual({ content: "hi" });
    expect(calls[0]!.ifMatch).toBeUndefined();
    expect(result.eTag).toBe('"v1"');
  });

  it("edits a page by sending the eTag as the If-Match header", async () => {
    const { calls, tools } = setup({ path: "/Home", content: "new" }, { etag: '"v2"' });
    await tools.get("wiki_create_or_update_page")!(
      { project: "Proj", wikiIdentifier: "MyWiki", path: "/Home", content: "new", eTag: '"v1"' },
      {},
    );
    expect(calls[0]!.ifMatch).toBe('"v1"');
    expect(calls[0]!.body).toEqual({ content: "new" });
  });

  it("surfaces a 412 when editing with a stale eTag", async () => {
    const { tools } = setup(
      { message: "VS402567: The version of the page does not match" },
      { status: 412 },
    );
    await expect(
      tools.get("wiki_create_or_update_page")!(
        { project: "Proj", wikiIdentifier: "MyWiki", path: "/Home", content: "x", eTag: '"stale"' },
        {},
      ),
    ).rejects.toThrow(/Azure DevOps API error 412/);
  });

  it("returns an actionable hint when a 412 occurs without an eTag (create over existing)", async () => {
    const { tools } = setup(
      { message: "VS402567: The version of the page does not match" },
      { status: 412 },
    );
    const res = (await tools.get("wiki_create_or_update_page")!(
      { project: "Proj", wikiIdentifier: "MyWiki", path: "/Home", content: "x" },
      {},
    )) as { content: Array<{ text: string }> };
    expect(res.content[0]!.text).toContain("already exists");
    expect(res.content[0]!.text).toContain("wiki_get_page");
  });

  it("surfaces a conflict when creating over an existing page", async () => {
    const { tools } = setup(
      { message: "VS402097: The page already exists" },
      { status: 409 },
    );
    await expect(
      tools.get("wiki_create_or_update_page")!(
        { project: "Proj", wikiIdentifier: "MyWiki", path: "/Home", content: "x" },
        {},
      ),
    ).rejects.toThrow(/Azure DevOps API error 409/);
  });
});
