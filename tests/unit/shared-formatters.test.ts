import { describe, it, expect } from "vitest";
import { asCompactText, asTicketList, truncateField } from "../../src/tools/_shared.js";

describe("asCompactText", () => {
  it("emits JSON without pretty-print indentation", () => {
    const { content } = asCompactText({ a: 1, b: { c: 2 } });
    expect(content[0]!.text).toBe('{"a":1,"b":{"c":2}}');
    expect(content[0]!.text).not.toContain("\n");
  });
});

describe("truncateField", () => {
  it("leaves short strings untouched", () => {
    expect(truncateField("hello", 10)).toBe("hello");
  });
  it("truncates long strings with a marker stating the dropped count", () => {
    const out = truncateField("x".repeat(100), 10) as string;
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out).toContain("truncated 90 chars");
  });
  it("passes non-strings through unchanged", () => {
    expect(truncateField(42, 10)).toBe(42);
  });
});

describe("asTicketList", () => {
  const items = [
    {
      id: 5,
      fields: {
        "System.Title": "Fix login",
        "System.State": "Active",
        "System.WorkItemType": "Bug",
        "System.AssignedTo": { displayName: "Jane Doe" },
      },
    },
  ];

  it("renders one compact line per ticket plus a count line", () => {
    const { content } = asTicketList(items);
    const lines = content[0]!.text.split("\n");
    expect(lines[0]).toBe("Showing 1 work item.");
    expect(lines[1]).toBe("#5 [Bug] Fix login — Active · Jane Doe");
  });

  it("signals capping when total exceeds shown", () => {
    const { content } = asTicketList(items, { total: 42 });
    expect(content[0]!.text).toContain("Showing 1 of 42 work items");
    expect(content[0]!.text).toContain("refine your filter");
  });

  it("falls back to 'Unassigned' when no assignee", () => {
    const { content } = asTicketList([{ id: 1, fields: { "System.Title": "x" } }]);
    expect(content[0]!.text).toContain("· Unassigned");
  });

  it("reports zero matches", () => {
    const { content } = asTicketList([], { total: 0 });
    expect(content[0]!.text).toBe("Showing 0 work items.");
  });
});
