import { describe, it, expect } from "vitest";
import { AzureDevOpsClient } from "../../src/azure/client.js";

const baseOpts = {
  serverUrl: "https://devops.corp.local/tfs",
  collection: "DefaultCollection",
  apiVersion: "7.1",
  pat: "abc",
  timeoutMs: 30000,
  pageSize: 50,
  maxResults: 200,
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function recording(responder: (url: string, body: unknown) => Response) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: String(url), method: init?.method ?? "GET", body });
    return responder(String(url), body);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AzureDevOpsClient.workItemsBatch", () => {
  it("posts {ids, fields} to the batch endpoint", async () => {
    const { calls, impl } = recording(() => json({ value: [{ id: 1 }] }));
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    await client.workItemsBatch([1, 2], ["System.Title", "System.State"]);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/_apis/wit/workitemsbatch");
    expect(calls[0]!.body).toEqual({ ids: [1, 2], fields: ["System.Title", "System.State"] });
  });

  it("chunks more than 200 ids and concatenates the results", async () => {
    const { calls, impl } = recording((_url, body) => {
      const ids = (body as { ids: number[] }).ids;
      return json({ value: ids.map((id) => ({ id })) });
    });
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const out = await client.workItemsBatch<{ id: number }>(ids, ["System.Title"]);
    expect(calls).toHaveLength(2);
    expect((calls[0]!.body as { ids: number[] }).ids).toHaveLength(200);
    expect((calls[1]!.body as { ids: number[] }).ids).toHaveLength(50);
    expect(out).toHaveLength(250);
  });
});

describe("AzureDevOpsClient.resolveIdentity", () => {
  it("returns the canonical display name on a match", async () => {
    const { calls, impl } = recording(() => json({ value: [{ providerDisplayName: "Canonical Name" }] }));
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    const resolved = await client.resolveIdentity("john");
    expect(resolved).toBe("Canonical Name");
    expect(calls[0]!.url).toContain("filterValue=john");
    expect(calls[0]!.url).toContain("searchFilter=General");
  });

  it("returns undefined when there is no match", async () => {
    const { impl } = recording(() => json({ value: [] }));
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    expect(await client.resolveIdentity("nobody")).toBeUndefined();
  });

  it("returns undefined (never throws) when the endpoint errors", async () => {
    const { impl } = recording(() => json({ message: "not found" }, 404));
    const client = new AzureDevOpsClient({ ...baseOpts, fetchImpl: impl });
    expect(await client.resolveIdentity("john")).toBeUndefined();
  });
});
