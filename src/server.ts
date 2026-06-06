import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./context.js";
import { DomainsManager } from "./shared/domains.js";
import { registerTools } from "./tools.js";
import { packageVersion } from "./version.js";

/** Build the MCP server with the enabled tool domains registered. */
export function buildServer(deps: ToolDeps, domains: DomainsManager): McpServer {
  const server = new McpServer({
    name: "azure-devops-mcp",
    version: packageVersion,
  });
  registerTools(server, deps, domains);
  return server;
}
