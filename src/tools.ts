import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./context.js";
import { Domain, DomainsManager } from "./shared/domains.js";
import { configureCoreTools } from "./tools/core.js";
import { configureWorkItemsTools } from "./tools/work-items.js";
import { configureRepositoriesTools, configurePullRequestTools } from "./tools/repositories.js";
import { configurePipelinesTools } from "./tools/pipelines.js";
import { configureWorkTools } from "./tools/work.js";

/**
 * Registers all enabled tool domains with the server.
 * Mirrors the `configureIfDomainEnabled` orchestration of microsoft/azure-devops-mcp.
 */
export function registerTools(server: McpServer, deps: ToolDeps, domains: DomainsManager): void {
  const whenEnabled = (domain: Domain, configure: () => void): void => {
    if (domains.isEnabled(domain)) configure();
  };

  whenEnabled(Domain.CORE, () => configureCoreTools(server, deps));
  whenEnabled(Domain.WORK_ITEMS, () => configureWorkItemsTools(server, deps));
  whenEnabled(Domain.REPOSITORIES, () => {
    configureRepositoriesTools(server, deps);
    configurePullRequestTools(server, deps);
  });
  whenEnabled(Domain.PIPELINES, () => configurePipelinesTools(server, deps));
  whenEnabled(Domain.WORK, () => configureWorkTools(server, deps));
  // Remaining domains (wiki, test-plans)
  // are wired in their respective tasks (T13–T14).
}
