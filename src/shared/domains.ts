/**
 * Tool domains. Mirrors the domain grouping of microsoft/azure-devops-mcp so
 * clients can load only the areas they need (respecting MCP tool limits).
 */
export enum Domain {
  CORE = "core",
  WORK = "work",
  WORK_ITEMS = "work-items",
  REPOSITORIES = "repositories",
  PIPELINES = "pipelines",
  WIKI = "wiki",
  TEST_PLANS = "test-plans",
}

export const ALL_DOMAINS: Domain[] = Object.values(Domain);

/** Resolves which tool domains are enabled. Empty/absent request = all domains. */
export class DomainsManager {
  private readonly enabled: Set<string>;

  constructor(requested?: string[]) {
    if (!requested || requested.length === 0) {
      this.enabled = new Set<string>(ALL_DOMAINS);
      return;
    }
    const valid = new Set<string>(ALL_DOMAINS);
    const unknown = requested.filter((domain) => !valid.has(domain));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown domain(s): ${unknown.join(", ")}. Valid domains: ${ALL_DOMAINS.join(", ")}`,
      );
    }
    this.enabled = new Set<string>(requested);
  }

  isEnabled(domain: Domain | string): boolean {
    return this.enabled.has(domain);
  }

  list(): string[] {
    return [...this.enabled];
  }
}
