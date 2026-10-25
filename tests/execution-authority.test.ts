import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  site: { findUnique: vi.fn(), findMany: vi.fn() },
  researchAction: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import {
  executionAuthority,
  getActionExecutionAuthority,
  getSiteExecutionAuthority,
  isExternallyManaged,
  isSupersededByExternalAuthority,
  normalizeSiteDomain,
} from "@/lib/research/execution-authority";

describe("external execution authority", () => {
  beforeEach(() => vi.clearAllMocks());

  it("treats only the local executor as locally executable", () => {
    expect(isExternallyManaged(null)).toBe(false);
    expect(isExternallyManaged({ status: "ACTIVE", executor: "crawlseo-agent" })).toBe(false);
    expect(isExternallyManaged({ status: "INACTIVE", executor: "helloada" })).toBe(false);
    expect(isExternallyManaged({ status: "ACTIVE", executor: "helloada" })).toBe(true);
  });

  it("normalizes scheme, www, path, port and case to one host identity", () => {
    expect(normalizeSiteDomain("https://www.OceanicVibes.com/some/path")).toBe("oceanicvibes.com");
    expect(normalizeSiteDomain("//oceanicvibes.com:443/")).toBe("oceanicvibes.com");
    expect(normalizeSiteDomain("oceanicvibes.com.")).toBe("oceanicvibes.com");
    expect(normalizeSiteDomain("")).toBe("");
  });

  it("surfaces the review origin only for an externally managed binding", () => {
    expect(executionAuthority({ status: "ACTIVE", executor: "helloada" }, {
      reviewOrigin: "https://helloada.example/admin/review/1",
    })).toEqual({
      managed: true,
      executor: "helloada",
      reviewOrigin: "https://helloada.example/admin/review/1",
    });
    expect(executionAuthority({ status: "ACTIVE", executor: "crawlseo-agent" }, {
      reviewOrigin: "https://helloada.example/admin/review/1",
    })).toEqual({ managed: false, executor: "crawlseo-agent", reviewOrigin: null });
  });

  it("does not treat an externally managed site as superseded by itself", async () => {
    mockDb.site.findUnique.mockResolvedValue({ id: "site-1", domain: "oceanicvibes.com",
      connectorBinding: { status: "ACTIVE", executor: "helloada" } });
    await expect(isSupersededByExternalAuthority("site-1")).resolves.toBe(false);
    expect(mockDb.site.findMany).not.toHaveBeenCalled();
  });

  it("marks an unbound site as superseded by a bound sibling on the same domain", async () => {
    mockDb.site.findUnique.mockResolvedValue({ id: "site-legacy", domain: "https://www.oceanicvibes.com/",
      connectorBinding: null });
    mockDb.site.findMany.mockResolvedValue([
      { domain: "other.example", connectorBinding: { status: "ACTIVE", executor: "helloada" } },
      { domain: "oceanicvibes.com", connectorBinding: { status: "ACTIVE", executor: "helloada" } },
    ]);
    await expect(isSupersededByExternalAuthority("site-legacy")).resolves.toBe(true);
  });

  it("ignores an inactive sibling binding and a different domain", async () => {
    mockDb.site.findUnique.mockResolvedValue({ id: "site-legacy", domain: "oceanicvibes.com",
      connectorBinding: null });
    mockDb.site.findMany.mockResolvedValue([
      { domain: "oceanicvibes.com", connectorBinding: { status: "INACTIVE", executor: "helloada" } },
      { domain: "other.example", connectorBinding: { status: "ACTIVE", executor: "helloada" } },
    ]);
    await expect(isSupersededByExternalAuthority("site-legacy")).resolves.toBe(false);
  });

  it("resolves a duplicate site's authority to the bound sibling for its domain", async () => {
    mockDb.site.findUnique.mockResolvedValue({
      id: "site-legacy", domain: "https://www.oceanicvibes.com/",
      connectorBinding: null,
      connectorContext: null,
    });
    mockDb.site.findMany.mockResolvedValue([
      { domain: "oceanicvibes.com", connectorBinding: { status: "ACTIVE", executor: "helloada" },
        connectorContext: { capabilities: { reviewOrigin: "https://helloada.example/admin" } } },
    ]);
    await expect(getSiteExecutionAuthority("site-legacy")).resolves.toEqual({
      managed: true,
      executor: "helloada",
      reviewOrigin: "https://helloada.example/admin",
    });
  });

  it("resolves action-level authority from the owning site", async () => {
    mockDb.researchAction.findUnique.mockResolvedValue({
      site: {
        id: "site-1", domain: "oceanicvibes.com",
        connectorBinding: { status: "ACTIVE", executor: "helloada" },
        connectorContext: { capabilities: { reviewOrigin: "https://helloada.example/review/9" } },
      },
    });
    await expect(getActionExecutionAuthority("action-1")).resolves.toEqual({
      managed: true,
      executor: "helloada",
      reviewOrigin: "https://helloada.example/review/9",
    });
    mockDb.researchAction.findUnique.mockResolvedValue(null);
    await expect(getActionExecutionAuthority("missing")).resolves.toBeNull();
  });
});
