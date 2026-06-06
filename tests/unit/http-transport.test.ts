import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { handleMcpRequest, startHttp, type HttpContext } from "../../src/transports/http.js";
import { createToolDeps } from "../../src/context.js";
import { createLogger } from "../../src/logger.js";
import { DomainsManager } from "../../src/shared/domains.js";
import type { ServerConfig } from "../../src/config.js";

const baseConfig: ServerConfig = {
  serverUrl: "https://devops.corp.local/tfs",
  collection: "DefaultCollection",
  pat: undefined, // hosted mode: PAT comes per request, not from config
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

function makeCtx(overrides: Partial<ServerConfig> = {}, fetchImpl?: typeof fetch): HttpContext {
  const config = { ...baseConfig, ...overrides };
  const deps = createToolDeps({ config, logger, fetchImpl });
  return { deps, domains: new DomainsManager(["core"]), config, logger };
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function rpc(method: string, params: unknown = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("strict-transport-security")).toContain("max-age=");
}

describe("handleMcpRequest", () => {
  it("returns 404 for a non-/mcp path", async () => {
    const res = await handleMcpRequest(
      new Request("http://127.0.0.1:3000/other", { method: "POST" }),
      makeCtx(),
    );
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  it("returns 403 when Origin is not in the allowlist", async () => {
    const res = await handleMcpRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, origin: "https://evil.test", "x-ado-pat": "p" },
        body: rpc("tools/list"),
      }),
      makeCtx({ allowedOrigins: ["https://ok.corp"] }),
    );
    expect(res.status).toBe(403);
    expectSecurityHeaders(res);
  });

  it("allows a request with no Origin (non-browser client)", async () => {
    const { impl } = recordingFetch();
    const res = await handleMcpRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, "x-ado-pat": "p" },
        body: rpc("tools/list"),
      }),
      makeCtx({}, impl),
    );
    expect(res.status).toBe(200);
  });

  it("returns 403 when the Host is not allowed", async () => {
    const res = await handleMcpRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, host: "evil.test:3000", "x-ado-pat": "p" },
        body: rpc("tools/list"),
      }),
      makeCtx(),
    );
    expect(res.status).toBe(403);
    expectSecurityHeaders(res);
  });

  it("returns 405 for GET (stateless mode, no standalone SSE)", async () => {
    const res = await handleMcpRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "GET",
        headers: { accept: "text/event-stream", "x-ado-pat": "p" },
      }),
      makeCtx(),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expectSecurityHeaders(res);
  });

  it("returns 401 when the X-ADO-PAT header is missing", async () => {
    const res = await handleMcpRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS },
        body: rpc("tools/list"),
      }),
      makeCtx(),
    );
    expect(res.status).toBe(401);
    expectSecurityHeaders(res);
  });

  it("returns 401 when the X-ADO-PAT header is whitespace-only", async () => {
    const res = await handleMcpRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, "x-ado-pat": "   " },
        body: rpc("tools/list"),
      }),
      makeCtx(),
    );
    expect(res.status).toBe(401);
    expectSecurityHeaders(res);
  });

  it("returns 413 when the declared content-length exceeds the body cap", async () => {
    const res = await handleMcpRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, "x-ado-pat": "p", "content-length": String(8 * 1024 * 1024) },
        body: rpc("tools/list"),
      }),
      makeCtx(),
    );
    expect(res.status).toBe(413);
    expectSecurityHeaders(res);
  });

  it("lists the core tools on a tools/list call carrying a PAT", async () => {
    const { impl } = recordingFetch();
    const res = await handleMcpRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, "x-ado-pat": "req-pat" },
        body: rpc("tools/list"),
      }),
      makeCtx({}, impl),
    );
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    const payload = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
    const names = (payload.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["core_list_projects", "core_list_teams"]);
  });

  it("threads the per-request PAT through to the outbound ADO call", async () => {
    const { calls, impl } = recordingFetch();
    const res = await handleMcpRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, "x-ado-pat": "req-pat" },
        body: rpc("tools/call", { name: "core_list_projects", arguments: {} }),
      }),
      makeCtx({}, impl),
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toContain("/DefaultCollection/_apis/projects");
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(":req-pat").toString("base64")}`);
  });

  it("does not leak the PAT between sequential requests sharing one context", async () => {
    const { calls, impl } = recordingFetch();
    const ctx = makeCtx({}, impl);
    const callWith = (pat: string) =>
      handleMcpRequest(
        new Request("http://127.0.0.1:3000/mcp", {
          method: "POST",
          headers: { ...MCP_HEADERS, "x-ado-pat": pat },
          body: rpc("tools/call", { name: "core_list_projects", arguments: {} }),
        }),
        ctx,
      );

    const first = await callWith("pat-alice");
    const second = await callWith("pat-bob");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(":pat-alice").toString("base64")}`);
    expect(calls[1]!.auth).toBe(`Basic ${Buffer.from(":pat-bob").toString("base64")}`);
  });
});

describe("startHttp (end-to-end over a real socket)", () => {
  it("serves /mcp: 401 without a PAT, 200 with one, security headers present", async () => {
    const { impl } = recordingFetch();
    const ctx = makeCtx({ httpPort: 0 }, impl);
    const server = await startHttp(ctx);
    try {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/mcp`;

      const noPat = await fetch(url, {
        method: "POST",
        headers: MCP_HEADERS,
        body: rpc("tools/list"),
      });
      expect(noPat.status).toBe(401);
      expect(noPat.headers.get("x-frame-options")).toBe("DENY");

      const ok = await fetch(url, {
        method: "POST",
        headers: { ...MCP_HEADERS, "x-ado-pat": "req-pat" },
        body: rpc("tools/list"),
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
      const payload = (await ok.json()) as { result?: { tools?: Array<{ name: string }> } };
      expect((payload.result?.tools ?? []).length).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
