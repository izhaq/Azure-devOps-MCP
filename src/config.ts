import { z } from "zod";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ServerConfig {
  serverUrl: string;
  collection: string;
  pat?: string;
  apiVersion: string;
  defaultProject?: string;
  domains?: string[];
  httpHost: string;
  httpPort: number;
  allowedOrigins?: string[];
  tlsCert?: string;
  tlsKey?: string;
  pageSize: number;
  maxResults: number;
  /**
   * Default cap for the agent-facing task-level list tools (e.g.
   * `wit_list_my_work_items`). Smaller than `maxResults` so a small-context
   * model isn't flooded; still hard-bounded by `maxResults`. Tunable via
   * `ADO_AGENT_LIST_CAP` without a rebuild (important for air-gapped deploys).
   */
  agentListCap: number;
  timeoutMs: number;
  logLevel: LogLevel;
}

type Env = Record<string, string | undefined>;

const isUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const list = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : undefined,
  );

const port = (name: string) =>
  z.coerce
    .number({ message: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .positive(`${name} must be positive`);

const schema = z.object({
  ADO_SERVER_URL: z
    .string({ message: "ADO_SERVER_URL is required" })
    .refine(isUrl, { message: "ADO_SERVER_URL must be a valid URL" }),
  ADO_COLLECTION: z.string().default("DefaultCollection"),
  ADO_PAT: z.string().optional(),
  ADO_API_VERSION: z.string().default("7.1"),
  ADO_DEFAULT_PROJECT: z.string().optional(),
  ADO_DOMAINS: list,
  ADO_HTTP_HOST: z.string().default("127.0.0.1"),
  ADO_HTTP_PORT: port("ADO_HTTP_PORT").default(3000),
  ADO_ALLOWED_ORIGINS: list,
  ADO_TLS_CERT: z.string().optional(),
  ADO_TLS_KEY: z.string().optional(),
  ADO_PAGE_SIZE: port("ADO_PAGE_SIZE").default(50),
  ADO_MAX_RESULTS: port("ADO_MAX_RESULTS").default(200),
  ADO_AGENT_LIST_CAP: port("ADO_AGENT_LIST_CAP").default(25),
  ADO_TIMEOUT_MS: port("ADO_TIMEOUT_MS").default(30000),
  ADO_LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"], { message: "invalid log level" })
    .default("info"),
});

/**
 * Parse and validate configuration from an environment-like record.
 * Throws an Error with a readable message listing every invalid field.
 */
export function loadConfig(env: Env = process.env): ServerConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => issue.message)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  const v = result.data;
  return {
    serverUrl: v.ADO_SERVER_URL,
    collection: v.ADO_COLLECTION,
    pat: v.ADO_PAT,
    apiVersion: v.ADO_API_VERSION,
    defaultProject: v.ADO_DEFAULT_PROJECT,
    domains: v.ADO_DOMAINS,
    httpHost: v.ADO_HTTP_HOST,
    httpPort: v.ADO_HTTP_PORT,
    allowedOrigins: v.ADO_ALLOWED_ORIGINS,
    tlsCert: v.ADO_TLS_CERT,
    tlsKey: v.ADO_TLS_KEY,
    pageSize: v.ADO_PAGE_SIZE,
    maxResults: v.ADO_MAX_RESULTS,
    agentListCap: v.ADO_AGENT_LIST_CAP,
    timeoutMs: v.ADO_TIMEOUT_MS,
    logLevel: v.ADO_LOG_LEVEL,
  };
}
