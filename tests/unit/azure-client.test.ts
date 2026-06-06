import { describe, it, expect } from "vitest";
import { AzureDevOpsClient } from "../../src/azure/client.js";
import { AdoApiError } from "../../src/azure/errors.js";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function mockFetch(responses: Response[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("no more mock responses");
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const baseOpts = {
  serverUrl: "https://devops.corp.local/tfs",
  collection: "DefaultCollection",
  apiVersion: "7.1",
  pat: "abc",
  timeoutMs: 30000,
  pageSize: 50,
  maxResults: 200,
};

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function authOf(call: Call): string {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.["Authorization"] ?? "";
}

describe("AzureDevOpsClient", () => {
  it("builds the URL with collection and api-version", async () => {
    const { impl, calls } = mockFetch([json({ value: [], count: 0 })]);
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    await client.get("/_apis/projects", { query: { $top: 10 } });
    expect(calls[0]!.url).toContain("https://devops.corp.local/tfs/DefaultCollection/_apis/projects");
    expect(calls[0]!.url).toContain("api-version=7.1");
    expect(calls[0]!.url).toContain("%24top=10");
  });

  it("includes the project segment when a project is provided", async () => {
    const { impl, calls } = mockFetch([json({ id: 5 })]);
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    await client.get("/_apis/wit/workitems/5", { project: "My Proj" });
    expect(calls[0]!.url).toContain("/DefaultCollection/My%20Proj/_apis/wit/workitems/5");
  });

  it("sends the PAT as a Basic Authorization header", async () => {
    const { impl, calls } = mockFetch([json({ value: [] })]);
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    await client.get("/_apis/projects");
    expect(authOf(calls[0]!)).toBe("Basic OmFiYw==");
  });

  it("returns the parsed JSON body", async () => {
    const { impl } = mockFetch([json({ value: [{ name: "P1" }], count: 1 })]);
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    const result = await client.get<{ value: Array<{ name: string }> }>("/_apis/projects");
    expect(result.value[0]!.name).toBe("P1");
  });

  it("returns undefined for a 204 No Content response", async () => {
    const { impl } = mockFetch([new Response(null, { status: 204 })]);
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    const result = await client.get("/_apis/wit/workitems/5");
    expect(result).toBeUndefined();
  });

  it("throws AdoApiError with status and message on a non-2xx response", async () => {
    const { impl } = mockFetch([
      json({ message: "The work item does not exist" }, { status: 404 }),
    ]);
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    const error = await client.get("/_apis/wit/workitems/999").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdoApiError);
    expect((error as AdoApiError).status).toBe(404);
    expect((error as AdoApiError).message).toMatch(/work item does not exist/i);
  });

  it("getAll follows the continuation token and concatenates pages", async () => {
    const { impl, calls } = mockFetch([
      json({ value: [1, 2] }, { headers: { "x-ms-continuationtoken": "TOKEN1" } }),
      json({ value: [3] }),
    ]);
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    const result = await client.getAll<number>("/_apis/projects");
    expect(result).toEqual([1, 2, 3]);
    expect(calls[1]!.url).toContain("continuationToken=TOKEN1");
  });

  it("getAll caps results at maxResults", async () => {
    const { impl } = mockFetch([
      json({ value: [1, 2, 3, 4] }, { headers: { "x-ms-continuationtoken": "T" } }),
    ]);
    const client = new AzureDevOpsClient({ ...baseOpts, maxResults: 2, fetchImpl: impl });
    const result = await client.getAll<number>("/_apis/projects");
    expect(result).toEqual([1, 2]);
  });

  it("getAll honors an explicit limit smaller than maxResults", async () => {
    const { impl, calls } = mockFetch([json({ value: [1, 2, 3, 4, 5, 6] })]);
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    const result = await client.getAll<number>("/_apis/projects", {}, 3);
    expect(result).toEqual([1, 2, 3]);
    // Per-page $top is derived from the remaining budget, not pageSize.
    expect(calls[0]!.url).toContain("%24top=3");
  });

  it("getAll ignores a caller-supplied $top and derives it from the budget", async () => {
    const { impl, calls } = mockFetch([json({ value: [1, 2] })]);
    const client = new AzureDevOpsClient({ ...baseOpts, pageSize: 50, fetchImpl: impl });
    await client.getAll<number>("/_apis/projects", { query: { $top: 999 } }, 5);
    expect(calls[0]!.url).toContain("%24top=5");
    expect(calls[0]!.url).not.toContain("%24top=999");
  });

  it("getAll stops when a page returns no items but echoes a token (non-advancing server)", async () => {
    const { impl, calls } = mockFetch([
      json({ value: [] }, { headers: { "x-ms-continuationtoken": "STUCK" } }),
      json({ value: [] }, { headers: { "x-ms-continuationtoken": "STUCK" } }),
    ]);
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    const result = await client.getAll<number>("/_apis/projects");
    expect(result).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("getAll stops once the continuation token stops advancing", async () => {
    const { impl, calls } = mockFetch([
      json({ value: [1] }, { headers: { "x-ms-continuationtoken": "SAME" } }),
      json({ value: [2] }, { headers: { "x-ms-continuationtoken": "SAME" } }),
      json({ value: [3] }),
    ]);
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    const result = await client.getAll<number>("/_apis/projects");
    // Page 2 echoes the same token it was given, so paging halts there
    // rather than looping forever (the third page is never requested).
    expect(result).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
  });

  it("getAll applies a per-call api-version override", async () => {
    const { impl, calls } = mockFetch([json({ value: [] })]);
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    await client.getAll("/_apis/teams", { apiVersion: "7.1-preview.3" });
    expect(calls[0]!.url).toContain("api-version=7.1-preview.3");
    expect(calls[0]!.url).not.toContain("api-version=7.1&");
  });
});
