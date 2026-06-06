import type { LogLevel } from "./config.js";

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Secret values (e.g. the PAT) that must never appear in output. */
  secrets?: Array<string | undefined>;
  /** Output sink. Defaults to stderr (stdout is reserved for the MCP protocol). */
  sink?: (line: string) => void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const defaultSink = (line: string): void => {
  process.stderr.write(line + "\n");
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const threshold = ORDER[level];
  const sink = options.sink ?? defaultSink;
  const secrets = (options.secrets ?? []).filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );

  const redact = (text: string): string => {
    let out = text;
    for (const secret of secrets) {
      out = out.split(secret).join("***");
    }
    return out;
  };

  const emit = (msgLevel: LogLevel, message: string, meta?: unknown): void => {
    if (ORDER[msgLevel] < threshold) return;
    const parts = [`[${new Date().toISOString()}]`, msgLevel.toUpperCase(), message];
    if (meta !== undefined) {
      parts.push(safeStringify(meta));
    }
    sink(redact(parts.join(" ")));
  };

  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
