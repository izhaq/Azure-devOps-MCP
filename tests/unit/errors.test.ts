import { describe, it, expect } from "vitest";
import { adoErrorFromResponse, AdoApiError } from "../../src/azure/errors.js";

describe("adoErrorFromResponse", () => {
  it("extracts the message from a JSON error body", () => {
    const err = adoErrorFromResponse(404, JSON.stringify({ message: "not found" }));
    expect(err).toBeInstanceOf(AdoApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Azure DevOps API error 404: not found");
  });

  it("falls back to the raw text when the body is not JSON", () => {
    const err = adoErrorFromResponse(500, "boom");
    expect(err.message).toContain("boom");
  });

  it("appends a remediation hint for a known TF error code", () => {
    const err = adoErrorFromResponse(
      400,
      JSON.stringify({ message: "TF401495: bad iteration path" }),
    );
    expect(err.message).toContain("TF401495");
    expect(err.message).toContain("Hint:");
    expect(err.message).toContain("work_list_iterations");
  });

  it("maps an access-denied code (VS402335) to a permission hint", () => {
    const err = adoErrorFromResponse(403, JSON.stringify({ message: "VS402335: denied" }));
    expect(err.message).toContain("Access denied");
  });

  it("does not append a hint for an unknown error code", () => {
    const err = adoErrorFromResponse(400, JSON.stringify({ message: "TF999999: mystery" }));
    expect(err.message).not.toContain("Hint:");
  });
});
