import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createNodeHttpsFetch } from "../../src/azure/node-https-fetch.js";

const fetchImpl = createNodeHttpsFetch();

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** Start a throwaway HTTP server and return its base URL plus a record of the last request. */
async function start(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ base: string; seen: Seen }> {
  const seen: Seen = { headers: {}, body: "" };
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.headers = req.headers;
      seen.body = Buffer.concat(chunks).toString("utf8");
      handler(req, res, seen.body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen };
}

describe("createNodeHttpsFetch", () => {
  it("performs a GET and exposes status, body text, and response headers", async () => {
    const { base } = await start((_req, res) => {
      res.setHeader("x-custom", "abc");
      res.writeHead(200);
      res.end("hello");
    });
    const res = await fetchImpl(`${base}/thing?q=1`);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("x-custom")).toBe("abc");
  });

  it("sends a POST body and the chosen method", async () => {
    const { base, seen } = await start((_req, res) => {
      res.writeHead(201);
      res.end("created");
    });
    const res = await fetchImpl(`${base}/items`, { method: "post", body: '{"a":1}' });
    expect(res.status).toBe(201);
    expect(seen.method).toBe("POST");
    expect(seen.body).toBe('{"a":1}');
  });

  it("returns a null body for 204 No Content", async () => {
    const { base } = await start((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const res = await fetchImpl(`${base}/x`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it.each([
    ["Headers instance", new Headers({ "x-mode": "headers" })],
    ["entry array", [["x-mode", "array"]] as [string, string][]],
    ["plain object", { "x-mode": "object" }],
  ])("forwards request headers given as a %s", async (_label, headers) => {
    const { base, seen } = await start((_req, res) => res.end("ok"));
    await fetchImpl(`${base}/h`, { headers });
    expect(seen.headers["x-mode"]).toBeDefined();
  });

  it("accepts a URL instance as input", async () => {
    const { base, seen } = await start((_req, res) => res.end("ok"));
    await fetchImpl(new URL(`${base}/from-url`));
    expect(seen.url).toBe("/from-url");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { base } = await start((_req, res) => res.end("ok"));
    const controller = new AbortController();
    controller.abort();
    await expect(fetchImpl(`${base}/x`, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects with AbortError when aborted mid-flight", async () => {
    const { base } = await start((_req, res) => {
      // Never respond, so the abort path is exercised.
      setTimeout(() => res.end("late"), 5000);
    });
    const controller = new AbortController();
    const pending = fetchImpl(`${base}/slow`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
