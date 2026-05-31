#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createToolDeps } from "./context.js";
import { DomainsManager } from "./shared/domains.js";
import { buildServer } from "./server.js";
import { startStdio } from "./transports/stdio.js";
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
  const server = buildServer(deps, domains);

  if (values.http) {
    throw new Error("HTTP transport is not yet implemented (T7). Use --stdio.");
  }

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
