import { describe, it, expect } from "vitest";
import { buildBasicAuthHeader } from "../../src/azure/auth.js";

describe("buildBasicAuthHeader", () => {
  it("builds Basic auth with an empty username and the PAT (on-prem convention)", () => {
    // ":abc" base64-encoded is "OmFiYw=="
    expect(buildBasicAuthHeader("abc")).toBe("Basic OmFiYw==");
  });

  it("encodes the colon separator so the username is empty", () => {
    const header = buildBasicAuthHeader("my-token");
    const decoded = Buffer.from(header.replace("Basic ", ""), "base64").toString("utf8");
    expect(decoded).toBe(":my-token");
  });
});
