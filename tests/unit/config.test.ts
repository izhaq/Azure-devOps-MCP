import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";

const base = { ADO_SERVER_URL: "https://devops.corp.local/tfs" };

describe("loadConfig", () => {
  it("applies defaults when only the server URL is provided", () => {
    const cfg = loadConfig(base);
    expect(cfg.serverUrl).toBe("https://devops.corp.local/tfs");
    expect(cfg.collection).toBe("DefaultCollection");
    expect(cfg.apiVersion).toBe("7.1");
    expect(cfg.pageSize).toBe(50);
    expect(cfg.maxResults).toBe(200);
    expect(cfg.timeoutMs).toBe(30000);
    expect(cfg.httpHost).toBe("127.0.0.1");
    expect(cfg.httpPort).toBe(3000);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.domains).toBeUndefined();
  });

  it("coerces numeric options from strings", () => {
    const cfg = loadConfig({ ...base, ADO_PAGE_SIZE: "10", ADO_MAX_RESULTS: "25", ADO_HTTP_PORT: "8080" });
    expect(cfg.pageSize).toBe(10);
    expect(cfg.maxResults).toBe(25);
    expect(cfg.httpPort).toBe(8080);
  });

  it("parses a comma-separated domains list, trimming whitespace", () => {
    const cfg = loadConfig({ ...base, ADO_DOMAINS: "core, work-items , repositories" });
    expect(cfg.domains).toEqual(["core", "work-items", "repositories"]);
  });

  it("parses allowed origins into a list", () => {
    const cfg = loadConfig({ ...base, ADO_ALLOWED_ORIGINS: "https://a.corp,https://b.corp" });
    expect(cfg.allowedOrigins).toEqual(["https://a.corp", "https://b.corp"]);
  });

  it("passes the raw PAT and default project through", () => {
    const cfg = loadConfig({ ...base, ADO_PAT: "secret-token", ADO_DEFAULT_PROJECT: "MyProj" });
    expect(cfg.pat).toBe("secret-token");
    expect(cfg.defaultProject).toBe("MyProj");
  });

  it("throws a clear error on an invalid log level", () => {
    expect(() => loadConfig({ ...base, ADO_LOG_LEVEL: "verbose" })).toThrow(/log level/i);
  });

  it("throws a clear error on a non-numeric page size", () => {
    expect(() => loadConfig({ ...base, ADO_PAGE_SIZE: "abc" })).toThrow(/ADO_PAGE_SIZE/);
  });

  it("throws a clear error on a malformed server URL", () => {
    expect(() => loadConfig({ ADO_SERVER_URL: "not-a-url" })).toThrow(/ADO_SERVER_URL/);
  });
});
