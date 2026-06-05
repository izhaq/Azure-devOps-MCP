import { describe, it, expect } from "vitest";
import { createToolDeps } from "../../src/context.js";
import { AzureDevOpsClient } from "../../src/azure/client.js";
import type { ServerConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";

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
  logLevel: "info",
};

const logger = createLogger({ level: "error", sink: () => {} });

function captureAuthFetch() {
  const auths: string[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    auths.push(headers?.["Authorization"] ?? "");
    return new Response(JSON.stringify({ value: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { auths, impl };
}

describe("createToolDeps", () => {
  it("clientFor() returns an AzureDevOpsClient", () => {
    const deps = createToolDeps({ config, logger });
    expect(deps.clientFor()).toBeInstanceOf(AzureDevOpsClient);
  });

  it("clientFor() uses the configured PAT", async () => {
    const { auths, impl } = captureAuthFetch();
    const deps = createToolDeps({ config, logger, fetchImpl: impl });
    await deps.clientFor().get("/_apis/projects");
    // ":cfg-pat" base64
    expect(auths[0]).toBe(`Basic ${Buffer.from(":cfg-pat").toString("base64")}`);
  });

  it("clientFor(patOverride) prefers the per-request PAT", async () => {
    const { auths, impl } = captureAuthFetch();
    const deps = createToolDeps({ config, logger, fetchImpl: impl });
    await deps.clientFor("req-pat").get("/_apis/projects");
    expect(auths[0]).toBe(`Basic ${Buffer.from(":req-pat").toString("base64")}`);
  });

  it("clientFor() throws when no PAT is available", () => {
    const noPat = { ...config, pat: undefined };
    const deps = createToolDeps({ config: noPat, logger });
    expect(() => deps.clientFor()).toThrow(/pat/i);
  });
});
