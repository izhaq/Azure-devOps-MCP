import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configureWorkItemsTools } from "../../src/tools/work-items.js";
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
  contentType: string;
  body: unknown;
}

function recordingFetch(responseBody: unknown = { value: [] }) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers?.["Authorization"] ?? "",
      contentType: headers?.["Content-Type"] ?? "",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
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
  configureWorkItemsTools(server, createToolDeps({ config, logger, fetchImpl: impl }));
  return { calls, tools };
}

const TOOLS = [
  "wit_query",
  "wit_list_my_work_items",
  "wit_get",
  "wit_create",
  "wit_update",
  "wit_add_comment",
  "wit_list_types",
];

describe("configureWorkItemsTools", () => {
  it("registers all work-item tools", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual([...TOOLS].sort());
  });

  it("wit_query POSTs WIQL to the project-scoped wiql endpoint", async () => {
    const { calls, tools } = setup({ workItems: [{ id: 1 }] });
    await tools.get("wit_query")!({ project: "Proj", query: "SELECT [System.Id] FROM workitems" }, {});
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/wit/wiql");
    expect(calls[0]!.body).toEqual({ query: "SELECT [System.Id] FROM workitems" });
  });

  it("wit_query passes $top when a limit is given", async () => {
    const { calls, tools } = setup({ workItems: [] });
    await tools.get("wit_query")!({ query: "SELECT [System.Id] FROM workitems", top: 25 }, {});
    expect(calls[0]!.url).toContain("%24top=25");
  });

  it("wit_query caps at maxResults when no top is given", async () => {
    const { calls, tools } = setup({ workItems: [] });
    await tools.get("wit_query")!({ query: "SELECT [System.Id] FROM workitems" }, {});
    expect(calls[0]!.url).toContain("%24top=200");
  });

  it("wit_query (flat) fetches fields and returns a single-block ticket list", async () => {
    const { calls, tools } = routedSetup((url) => {
      if (url.includes("workitemsbatch"))
        return {
          value: [
            {
              id: 1,
              fields: {
                "System.Id": 1,
                "System.Title": "Fix login",
                "System.State": "Active",
                "System.WorkItemType": "Bug",
                "System.AssignedTo": { displayName: "Me Myself" },
              },
            },
          ],
        };
      if (url.includes("/wiql")) return { workItems: [{ id: 1 }] };
      return {};
    });
    const res = (await tools.get("wit_query")!(
      { query: "SELECT [System.Id] FROM WorkItems" },
      {},
    )) as { content: Array<{ text: string }> };
    // Single content block (L10): the cap note is merged into the list header.
    expect(res.content).toHaveLength(1);
    const batch = calls.find((c) => c.url.includes("workitemsbatch"))!;
    expect((batch.body as { ids: number[] }).ids).toEqual([1]);
    expect(res.content[0]!.text).toContain("#1 [Bug] Fix login — Active · Me Myself");
  });

  it("wit_query (flat) merges the cap into the ticket-list header (no 2nd block)", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    const { tools } = routedSetup((url) => {
      if (url.includes("workitemsbatch"))
        return { value: many.slice(0, 2).map((r) => ({ id: r.id, fields: {} })) };
      if (url.includes("/wiql")) return { workItems: many };
      return {};
    });
    const res = (await tools.get("wit_query")!(
      { query: "SELECT [System.Id] FROM WorkItems", top: 2 },
      {},
    )) as { content: Array<{ text: string }> };
    expect(res.content).toHaveLength(1);
    expect(res.content[0]!.text).toContain("Showing 2 of 5");
  });

  it("wit_query (hierarchical) returns the cleaned relation graph in one block", async () => {
    const { calls, tools } = routedSetup((url) => {
      if (url.includes("/wiql"))
        return {
          workItemRelations: [
            { rel: null, target: { id: 1 } },
            { rel: "System.LinkTypes.Hierarchy-Forward", source: { id: 1 }, target: { id: 2 } },
          ],
        };
      return {};
    });
    const res = (await tools.get("wit_query")!(
      { query: "SELECT [System.Id] FROM WorkItemLinks" },
      {},
    )) as { content: Array<{ text: string }> };
    expect(res.content).toHaveLength(1);
    // Tree queries do not fetch item fields, so no batch call is made.
    expect(calls.some((c) => c.url.includes("workitemsbatch"))).toBe(false);
    const parsed = JSON.parse(res.content[0]!.text) as { workItemRelations: unknown[] };
    expect(parsed.workItemRelations).toHaveLength(2);
  });

  it("wit_get truncates a long System.Description and returns compact JSON", async () => {
    const longHtml = `<p>${"x".repeat(5000)}</p>`;
    const { tools } = setup({ id: 7, fields: { "System.Description": longHtml, "System.Title": "T" } });
    const res = (await tools.get("wit_get")!({ id: 7 }, {})) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0]!.text).toContain("truncated");
    expect(res.content[0]!.text.length).toBeLessThan(longHtml.length);
    expect(res.content[0]!.text).not.toContain("\n  "); // compact, not pretty-printed
  });

  it("wit_get reads a single work item by id", async () => {
    const { calls, tools } = setup({ id: 42, fields: {} });
    await tools.get("wit_get")!({ id: 42 }, {});
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/DefaultCollection/_apis/wit/workitems/42");
  });

  it("wit_get forwards a comma-joined fields list", async () => {
    const { calls, tools } = setup({ id: 42 });
    await tools.get("wit_get")!({ id: 42, fields: ["System.Title", "System.State"] }, {});
    expect(calls[0]!.url).toContain("fields=System.Title%2CSystem.State");
  });

  it("wit_get forwards $expand", async () => {
    const { calls, tools } = setup({ id: 42 });
    await tools.get("wit_get")!({ id: 42, expand: "relations" }, {});
    expect(calls[0]!.url).toContain("%24expand=relations");
  });

  it("wit_get rejects passing both fields and expand (mutually exclusive)", async () => {
    const { calls, tools } = setup({ id: 42 });
    await expect(
      tools.get("wit_get")!({ id: 42, fields: ["System.Title"], expand: "relations" }, {}),
    ).rejects.toThrow(/mutually exclusive/);
    expect(calls).toHaveLength(0);
  });

  it("wit_create POSTs a JSON-Patch document with json-patch content type", async () => {
    const { calls, tools } = setup({ id: 100 });
    await tools.get("wit_create")!(
      { project: "Proj", type: "Bug", fields: { "System.Title": "Boom", "System.State": "New" } },
      {},
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/wit/workitems/$Bug");
    expect(calls[0]!.contentType).toBe("application/json-patch+json");
    expect(calls[0]!.body).toEqual([
      { op: "add", path: "/fields/System.Title", value: "Boom" },
      { op: "add", path: "/fields/System.State", value: "New" },
    ]);
  });

  it("wit_update PATCHes a JSON-Patch document by id", async () => {
    const { calls, tools } = setup({ id: 100 });
    await tools.get("wit_update")!({ id: 100, fields: { "System.State": "Active" } }, {});
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/DefaultCollection/_apis/wit/workitems/100");
    expect(calls[0]!.contentType).toBe("application/json-patch+json");
    expect(calls[0]!.body).toEqual([{ op: "add", path: "/fields/System.State", value: "Active" }]);
  });

  it("wit_add_comment POSTs the comment to the preview comments endpoint", async () => {
    const { calls, tools } = setup({ id: 1, text: "hi" });
    await tools.get("wit_add_comment")!({ project: "Proj", id: 100, text: "hi" }, {});
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/wit/workItems/100/comments");
    expect(calls[0]!.url).toContain("api-version=7.1-preview.3");
    expect(calls[0]!.body).toEqual({ text: "hi" });
  });

  it("wit_list_types lists work item types for a project", async () => {
    const { calls, tools } = setup({ value: [{ name: "Bug" }, { name: "Task" }] });
    const result = (await tools.get("wit_list_types")!({ project: "Proj" }, {})) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(calls[0]!.url).toContain("/DefaultCollection/Proj/_apis/wit/workitemtypes");
    const types = JSON.parse(result.content[0]!.text) as Array<{ name: string }>;
    expect(types.map((t) => t.name)).toEqual(["Bug", "Task"]);
  });

  it("uses the per-request PAT from the x-ado-pat header when present", async () => {
    const { calls, tools } = setup({ id: 1 });
    const extra = { requestInfo: { headers: { "x-ado-pat": "req-pat" } } };
    await tools.get("wit_get")!({ id: 1 }, extra);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(":req-pat").toString("base64")}`);
  });
});

/** Fetch that returns a different body per endpoint, recording each call. */
function routedSetup(routes: (url: string) => unknown) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers?.["Authorization"] ?? "",
      contentType: headers?.["Content-Type"] ?? "",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(routes(String(url))), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const { server, tools } = fakeServer();
  configureWorkItemsTools(server, createToolDeps({ config, logger, fetchImpl: impl }));
  return { calls, tools };
}

const defaultRoutes = (url: string): unknown => {
  if (url.includes("workitemsbatch"))
    return {
      value: [
        {
          id: 1,
          fields: {
            "System.Id": 1,
            "System.Title": "Fix login",
            "System.State": "Active",
            "System.WorkItemType": "Bug",
            "System.AssignedTo": { displayName: "Me Myself" },
          },
        },
      ],
    };
  if (url.includes("/_apis/identities")) return { value: [{ providerDisplayName: "Canonical Name" }] };
  if (url.includes("/wiql")) return { workItems: [{ id: 1 }] };
  return {};
};

function wiqlOf(calls: Call[]): string {
  const call = calls.find((c) => c.url.includes("/wiql"));
  return (call!.body as { query: string }).query;
}

describe("wit_list_my_work_items", () => {
  it("defaults to @Me + open states, composes wiql→batch, returns a compact list", async () => {
    const { calls, tools } = routedSetup(defaultRoutes);
    const res = (await tools.get("wit_list_my_work_items")!({ project: "Proj" }, {})) as {
      content: Array<{ text: string }>;
    };
    const wiql = wiqlOf(calls);
    expect(wiql).toContain("[System.AssignedTo] = @Me");
    expect(wiql).toContain("[System.State] NOT IN");
    expect(wiql).not.toContain("System.Description");

    const batch = calls.find((c) => c.url.includes("workitemsbatch"))!;
    expect(batch.method).toBe("POST");
    expect((batch.body as { ids: number[] }).ids).toEqual([1]);
    expect((batch.body as { fields: string[] }).fields).not.toContain("System.Description");

    expect(res.content[0]!.text).toContain("Showing 1 work item");
    expect(res.content[0]!.text).toContain("#1 [Bug] Fix login — Active · Me Myself");
  });

  it("resolves a named assignee and matches it exactly (not @Me)", async () => {
    const { calls, tools } = routedSetup(defaultRoutes);
    await tools.get("wit_list_my_work_items")!({ assignedTo: "John" }, {});
    const idCall = calls.find((c) => c.url.includes("/_apis/identities"))!;
    expect(idCall.url).toContain("filterValue=John");
    const wiql = wiqlOf(calls);
    expect(wiql).toContain("[System.AssignedTo] = 'Canonical Name'");
    expect(wiql).not.toContain("@Me");
  });

  it("falls back to CONTAINS on the raw name when identity resolution finds nothing", async () => {
    const { calls, tools } = routedSetup((url) => {
      if (url.includes("/_apis/identities")) return { value: [] };
      if (url.includes("/wiql")) return { workItems: [{ id: 1 }] };
      if (url.includes("workitemsbatch")) return { value: [{ id: 1, fields: {} }] };
      return {};
    });
    await tools.get("wit_list_my_work_items")!({ assignedTo: "Jane" }, {});
    const wiql = wiqlOf(calls);
    expect(wiql).toContain("[System.AssignedTo] CONTAINS 'Jane'");
    expect(wiql).not.toContain("=");
  });

  it("honors explicit mine:true over assignedTo (mine wins)", async () => {
    const { calls, tools } = routedSetup(defaultRoutes);
    await tools.get("wit_list_my_work_items")!({ mine: true, assignedTo: "John" }, {});
    expect(wiqlOf(calls)).toContain("[System.AssignedTo] = @Me");
    expect(calls.some((c) => c.url.includes("/_apis/identities"))).toBe(false);
  });

  it("renders items in the WIQL order, not the batch response order", async () => {
    const { tools } = routedSetup((url) => {
      if (url.includes("workitemsbatch"))
        return {
          value: [
            { id: 2, fields: { "System.Title": "two" } },
            { id: 3, fields: { "System.Title": "three" } },
            { id: 1, fields: { "System.Title": "one" } },
          ],
        };
      if (url.includes("/wiql")) return { workItems: [{ id: 3 }, { id: 1 }, { id: 2 }] };
      return {};
    });
    const res = (await tools.get("wit_list_my_work_items")!({}, {})) as {
      content: Array<{ text: string }>;
    };
    const lines = res.content[0]!.text.split("\n").slice(1); // drop the count header
    expect(lines.map((l) => l.match(/^#(\d+)/)![1])).toEqual(["3", "1", "2"]);
  });

  it("state='all' omits the state filter", async () => {
    const { calls, tools } = routedSetup(defaultRoutes);
    await tools.get("wit_list_my_work_items")!({ state: "all" }, {});
    expect(wiqlOf(calls)).not.toContain("[System.State]");
  });

  it("returns 'Showing 0' and skips the batch call when nothing matches", async () => {
    const { calls, tools } = routedSetup((url) =>
      url.includes("/wiql") ? { workItems: [] } : {},
    );
    const res = (await tools.get("wit_list_my_work_items")!({}, {})) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0]!.text).toContain("Showing 0 work items");
    expect(calls.some((c) => c.url.includes("workitemsbatch"))).toBe(false);
  });

  it("leaves the WIQL id-query uncapped, caps the batch, and reports true 'N of M'", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
    const { calls, tools } = routedSetup((url) => {
      if (url.includes("workitemsbatch"))
        return { value: many.slice(0, 25).map((r) => ({ id: r.id, fields: {} })) };
      if (url.includes("/wiql")) return { workItems: many };
      return {};
    });
    const res = (await tools.get("wit_list_my_work_items")!({}, {})) as {
      content: Array<{ text: string }>;
    };
    // The id-query must NOT carry $top — we need the true match count.
    const wiqlCall = calls.find((c) => c.url.includes("/wiql"))!;
    expect(wiqlCall.url).not.toContain("%24top");
    // The cap is applied to the batch ids (default agentListCap = 25).
    const batch = calls.find((c) => c.url.includes("workitemsbatch"))!;
    expect((batch.body as { ids: number[] }).ids).toHaveLength(25);
    // The "refine" signal now fires because total (30) > shown (25).
    expect(res.content[0]!.text).toContain("Showing 25 of 30");
    expect(res.content[0]!.text).toContain("refine your filter");
  });

  it("drops WIQL refs that lack a numeric id instead of crashing the batch", async () => {
    const { calls, tools } = routedSetup((url) => {
      if (url.includes("workitemsbatch")) return { value: [{ id: 7, fields: {} }] };
      if (url.includes("/wiql")) return { workItems: [{ id: 7 }, { url: "no-id" }, {}] };
      return {};
    });
    await tools.get("wit_list_my_work_items")!({}, {});
    const batch = calls.find((c) => c.url.includes("workitemsbatch"))!;
    expect((batch.body as { ids: number[] }).ids).toEqual([7]);
  });
});
