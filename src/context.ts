import type { ServerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { AzureDevOpsClient } from "./azure/client.js";

/**
 * Dependencies handed to every tool module. `clientFor` produces an
 * Azure DevOps REST client for the current request:
 * - stdio mode: the PAT comes from configuration (no override)
 * - HTTP mode (T7): the per-request `X-ADO-PAT` header is passed as the override
 */
export interface ToolDeps {
  config: ServerConfig;
  logger: Logger;
  clientFor(patOverride?: string): AzureDevOpsClient;
}

export interface ToolDepsOptions {
  config: ServerConfig;
  logger: Logger;
  /** Injectable for testing; forwarded to the REST client. */
  fetchImpl?: typeof fetch;
}

/** Header carrying the per-user PAT in hosted (HTTP) mode. */
export const PAT_HEADER = "x-ado-pat";

interface RequestExtraLike {
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
}

/**
 * Extract the per-request PAT from the MCP request `extra`, if present.
 * Returns undefined for stdio (no request headers), so callers fall back to config.
 */
export function patFromExtra(extra: unknown): string | undefined {
  const headers = (extra as RequestExtraLike | undefined)?.requestInfo?.headers;
  const value = headers?.[PAT_HEADER];
  return Array.isArray(value) ? value[0] : value;
}

export function createToolDeps(options: ToolDepsOptions): ToolDeps {
  const { config, logger, fetchImpl } = options;

  const clientFor = (patOverride?: string): AzureDevOpsClient => {
    const pat = patOverride ?? config.pat;
    if (!pat) {
      throw new Error(
        "No Azure DevOps PAT available. Set ADO_PAT (stdio) or send the X-ADO-PAT header (HTTP).",
      );
    }
    return new AzureDevOpsClient({
      serverUrl: config.serverUrl,
      collection: config.collection,
      apiVersion: config.apiVersion,
      pat,
      timeoutMs: config.timeoutMs,
      pageSize: config.pageSize,
      maxResults: config.maxResults,
      fetchImpl,
      logger,
    });
  };

  return { config, logger, clientFor };
}
