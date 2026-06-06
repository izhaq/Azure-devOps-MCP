import { describe, it, expect } from "vitest";
import { createLogger } from "../../src/logger.js";

function capture() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe("createLogger", () => {
  it("writes log lines to the provided sink", () => {
    const { lines, sink } = capture();
    const log = createLogger({ level: "info", sink });
    log.info("hello world");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("hello world");
  });

  it("suppresses messages below the configured level", () => {
    const { lines, sink } = capture();
    const log = createLogger({ level: "warn", sink });
    log.debug("noisy");
    log.info("also noisy");
    log.warn("important");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("important");
  });

  it("redacts the PAT when it appears in a message", () => {
    const { lines, sink } = capture();
    const log = createLogger({ level: "info", sink, secrets: ["super-secret-pat"] });
    log.info("connecting with token super-secret-pat to server");
    expect(lines[0]).not.toContain("super-secret-pat");
    expect(lines[0]).toContain("***");
  });

  it("redacts the PAT when it appears in structured metadata", () => {
    const { lines, sink } = capture();
    const log = createLogger({ level: "info", sink, secrets: ["super-secret-pat"] });
    log.info("request", { authorization: "Basic super-secret-pat" });
    expect(lines[0]).not.toContain("super-secret-pat");
  });

  it("ignores empty secret values when redacting", () => {
    const { lines, sink } = capture();
    const log = createLogger({ level: "info", sink, secrets: ["", undefined] });
    log.info("plain message");
    expect(lines[0]).toContain("plain message");
    expect(lines[0]).not.toContain("***");
  });
});
