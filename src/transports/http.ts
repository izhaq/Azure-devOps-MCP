import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ServerConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ToolDeps } from "../context.js";
import type { DomainsManager } from "../shared/domains.js";
import { buildServer } from "../server.js";
import { PAT_HEADER } from "../context.js";

/** Single MCP endpoint path (MCP Streamable HTTP transport). */
const MCP_PATH = "/mcp";

/** Max accepted request body size; guards against an unbounded-body OOM. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Thrown when a request body exceeds {@link MAX_BODY_BYTES}. */
class PayloadTooLargeError extends Error {}

/**
 * Security response headers applied to every HTTP response (MCP transport
 * security requirements, spec 2025-11-25).
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export interface HttpContext {
  deps: ToolDeps;
  domains: DomainsManager;
  config: ServerConfig;
  logger: Logger;
}

/**
 * Handle one MCP HTTP request and return a Web-standard `Response`.
 *
 * Enforces the transport security contract before touching the MCP layer:
 * Origin/Host allowlist (403), POST-only in stateless mode (405), and a
 * required per-request `X-ADO-PAT` (401). On the happy path it builds a fresh
 * server + stateless Web-standard transport per request (so the per-request PAT
 * reaches tool handlers via `extra.requestInfo.headers`), then tears them down.
 * Every returned response carries the security headers.
 */
export async function handleMcpRequest(request: Request, ctx: HttpContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== MCP_PATH) {
    return errorResponse(404, -32600, `Not found. Use POST ${MCP_PATH}.`);
  }
  if (!originAllowed(request, ctx) || !hostAllowed(request, ctx)) {
    return errorResponse(403, -32600, "Forbidden: Origin/Host not allowed.");
  }
  if (request.method !== "POST") {
    // Stateless mode: no standalone SSE stream (GET) or session teardown (DELETE).
    return errorResponse(405, -32600, "Method Not Allowed. Use POST.", { Allow: "POST" });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return errorResponse(413, -32600, "Payload Too Large.");
  }
  const pat = request.headers.get(PAT_HEADER);
  if (!pat || pat.trim().length === 0) {
    return errorResponse(401, -32001, `Unauthorized: missing ${PAT_HEADER} header.`);
  }

  const server = buildServer(ctx.deps, ctx.domains);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // JSON-response mode returns a fully-buffered body; read it so we can close
    // the per-request server/transport before returning.
    const bodyText = await response.text();
    return new Response(bodyText.length > 0 ? bodyText : null, {
      status: response.status,
      headers: withSecurity(response.headers),
    });
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/**
 * Start the Streamable HTTP transport bound to `config.httpHost:config.httpPort`.
 *
 * If both `tlsCert` and `tlsKey` are configured, serves over HTTPS. Otherwise
 * serves plain HTTP — which is only safe over loopback. Hosted deployments that
 * bind a network interface (e.g. `ADO_HTTP_HOST=0.0.0.0`) MUST supply TLS here
 * or sit behind a TLS-terminating reverse proxy; otherwise per-user PATs travel
 * in cleartext. Returns the listening server.
 */
export async function startHttp(ctx: HttpContext): Promise<http.Server | https.Server> {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleNodeRequest(req, res, ctx);
  };
  const { tlsCert, tlsKey } = ctx.config;
  const server =
    tlsCert && tlsKey
      ? https.createServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }, handler)
      : http.createServer(handler);
  if (!(tlsCert && tlsKey) && ctx.config.httpHost !== "127.0.0.1" && ctx.config.httpHost !== "localhost") {
    ctx.logger.warn(
      "HTTP transport is serving plaintext on a non-loopback interface; per-user PATs will travel in cleartext. Configure ADO_TLS_CERT/ADO_TLS_KEY or front this with a TLS-terminating reverse proxy.",
      { host: ctx.config.httpHost },
    );
  }
  await new Promise<void>((resolve) => {
    server.listen(ctx.config.httpPort, ctx.config.httpHost, resolve);
  });
  return server;
}

async function handleNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
): Promise<void> {
  try {
    const request = await toWebRequest(req, ctx);
    const response = await handleMcpRequest(request, ctx);
    await writeNodeResponse(res, response);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      await writeNodeResponse(res, errorResponse(413, -32600, "Payload Too Large."));
      return;
    }
    ctx.logger.error("http request failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json", ...SECURITY_HEADERS });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  }
}

function originAllowed(request: Request, ctx: HttpContext): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser clients send no Origin
  return (ctx.config.allowedOrigins ?? []).includes(origin);
}

function hostAllowed(request: Request, ctx: HttpContext): boolean {
  const host = request.headers.get("host");
  if (!host) return true;
  const allowed = buildAllowedHosts(ctx);
  const lower = host.toLowerCase();
  if (allowed.has(lower)) return true;
  // Fall back to the hostname (ignoring port): the DNS-rebinding concern is the
  // hostname, and hosted deployments may sit behind a proxy on a non-bind port.
  return allowed.has(lower.split(":")[0] ?? lower);
}

/**
 * Allowed `Host` values for DNS-rebinding defense: the configured bind
 * host/port plus loopback aliases, plus any hosts implied by the configured
 * Origin allowlist (so a hosted deployment that sets `ADO_ALLOWED_ORIGINS`
 * also accepts that Host).
 */
function buildAllowedHosts(ctx: HttpContext): Set<string> {
  const port = ctx.config.httpPort;
  const hosts = new Set<string>();
  for (const h of [ctx.config.httpHost, "localhost", "127.0.0.1"]) {
    const lower = h.toLowerCase();
    hosts.add(lower);
    hosts.add(`${lower}:${port}`);
  }
  for (const origin of ctx.config.allowedOrigins ?? []) {
    try {
      hosts.add(new URL(origin).host.toLowerCase());
    } catch {
      // ignore malformed origin entries
    }
  }
  return hosts;
}

function errorResponse(
  status: number,
  code: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...extraHeaders },
  });
}

function withSecurity(headers: Headers): Headers {
  const merged = new Headers(headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    merged.set(key, value);
  }
  return merged;
}

async function toWebRequest(req: IncomingMessage, ctx: HttpContext): Promise<Request> {
  const hostHeader = req.headers.host ?? `${ctx.config.httpHost}:${ctx.config.httpPort}`;
  const requestUrl = `http://${hostHeader}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await readBody(req);
  }
  return new Request(requestUrl, {
    method,
    headers,
    body: body && body.length > 0 ? body : undefined,
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new PayloadTooLargeError("request body exceeds limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function writeNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  const text = await response.text();
  res.end(text);
}
