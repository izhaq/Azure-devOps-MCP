import { describe, it, expect } from "vitest";
import { buildWorkItemQuery } from "../../src/shared/wiql.js";

describe("buildWorkItemQuery", () => {
  it("uses @Me for mine and excludes closed states by default", () => {
    const q = buildWorkItemQuery({ mine: true });
    expect(q).toContain("[System.AssignedTo] = @Me");
    expect(q).toContain("[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved', 'Completed')");
    expect(q).toContain("ORDER BY [System.ChangedDate] DESC");
  });

  it("defaults a named assignee to CONTAINS, never strict equality", () => {
    const q = buildWorkItemQuery({ assignedTo: { value: "Jane" } });
    expect(q).toContain("[System.AssignedTo] CONTAINS 'Jane'");
    expect(q).not.toContain("[System.AssignedTo] =");
  });

  it("supports explicit equals when the caller opts in", () => {
    const q = buildWorkItemQuery({ assignedTo: { value: "Jane Doe", match: "equals" } });
    expect(q).toContain("[System.AssignedTo] = 'Jane Doe'");
  });

  it("mine wins over assignedTo", () => {
    const q = buildWorkItemQuery({ mine: true, assignedTo: { value: "Jane" } });
    expect(q).toContain("@Me");
    expect(q).not.toContain("Jane");
  });

  it("renders explicit states as an IN set", () => {
    const q = buildWorkItemQuery({ states: ["Active", "New"] });
    expect(q).toContain("[System.State] IN ('Active', 'New')");
  });

  it("omits the state filter when allStates is set", () => {
    const q = buildWorkItemQuery({ allStates: true });
    expect(q).not.toContain("[System.State]");
  });

  it("matches title by substring", () => {
    const q = buildWorkItemQuery({ titleContains: "login" });
    expect(q).toContain("[System.Title] CONTAINS 'login'");
  });

  it("escapes single quotes in values", () => {
    const q = buildWorkItemQuery({ assignedTo: { value: "O'Brien" } });
    expect(q).toContain("CONTAINS 'O''Brien'");
  });
});
