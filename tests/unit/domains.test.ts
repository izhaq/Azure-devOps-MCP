import { describe, it, expect } from "vitest";
import { Domain, ALL_DOMAINS, DomainsManager } from "../../src/shared/domains.js";

describe("DomainsManager", () => {
  it("enables all domains when none are requested", () => {
    const mgr = new DomainsManager();
    expect(mgr.list().sort()).toEqual([...ALL_DOMAINS].sort());
    expect(mgr.isEnabled(Domain.CORE)).toBe(true);
    expect(mgr.isEnabled(Domain.WIKI)).toBe(true);
  });

  it("enables all domains when an empty list is requested", () => {
    const mgr = new DomainsManager([]);
    expect(mgr.list().length).toBe(ALL_DOMAINS.length);
  });

  it("enables only the requested subset", () => {
    const mgr = new DomainsManager(["core", "work-items"]);
    expect(mgr.isEnabled(Domain.CORE)).toBe(true);
    expect(mgr.isEnabled(Domain.WORK_ITEMS)).toBe(true);
    expect(mgr.isEnabled(Domain.PIPELINES)).toBe(false);
  });

  it("throws on an unknown domain, listing valid options", () => {
    expect(() => new DomainsManager(["core", "bogus"])).toThrow(/bogus/);
    expect(() => new DomainsManager(["bogus"])).toThrow(/core/);
  });
});
