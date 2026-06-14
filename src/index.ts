#!/usr/bin/env node
import { Agent, setGlobalDispatcher } from "undici";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";

// Undici (Node.js native fetch) has a 10s connect timeout that is separate
// from ADO_TIMEOUT_MS and fires before the TLS handshake completes on some
// corporate servers. Raise it to 60s so slow internal ADO hosts don't get
// cut off before the connection is established.
setGlobalDispatcher(new Agent({ connectTimeout: 60_000 }));
import { createLogger } from "./logger.js";
import { createToolDeps } from "./context.js";
import { DomainsManager } from "./shared/domains.js";
import { buildServer } from "./server.js";
import { startStdio } from "./transports/stdio.js";
import { startHttp } from "./transports/http.js";
import { packageVersion } from "./version.js";

const HELP = `azure-devops-mcp v${packageVersion}

Usage: mcp-server-azuredevops [options]

Options:
  --stdio              Run over stdio (default)
  --http               Run the Streamable HTTP transport
  --port <number>      HTTP port (default 3000 / ADO_HTTP_PORT)
  -d, --domains <list> Comma-separated domains to enable (default: all)
                       core,work,work-items,repositories,pipelines,wiki,test-plans
  --version            Print version and exit
  --help               Show this help

Configuration is read from environment variables (see .env.example).
`;

/**
 * Resolve the HTTP port from the `--port` flag, falling back to the configured
 * value. The env path is validated by zod; this validates the CLI flag so a
 * non-numeric `--port` errors instead of silently binding a random port.
 */
function resolvePort(flag: string | undefined, fallback: number): number {
  if (flag === undefined) return fallback;
  const parsed = Number(flag);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --port "${flag}": must be a positive integer.`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      stdio: { type: "boolean", default: false },
      http: { type: "boolean", default: false },
      port: { type: "string" },
      domains: { type: "string", short: "d" },
      version: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.version) {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, secrets: [config.pat] });

  const requestedDomains = values.domains
    ? values.domains.split(",").map((d) => d.trim()).filter(Boolean)
    : config.domains;
  const domains = new DomainsManager(requestedDomains);

  const deps = createToolDeps({ config, logger });

  if (values.http) {
    const port = resolvePort(values.port, config.httpPort);
    await startHttp({ deps, domains, config: { ...config, httpPort: port }, logger });
    logger.info("azure-devops-mcp started", {
      transport: "http",
      host: config.httpHost,
      port,
      domains: domains.list(),
    });
    return;
  }

  const server = buildServer(deps, domains);
  await startStdio(server);
  logger.info("azure-devops-mcp started", {
    transport: "stdio",
    domains: domains.list(),
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
