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
  supersededSiteIds,
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
    mockDb.site.findUnique.mockResolvedValue({ id: "site-1", projectId: "project-1", domain: "oceanicvibes.com",
      connectorBinding: { status: "ACTIVE", executor: "helloada" } });
    await expect(isSupersededByExternalAuthority("site-1")).resolves.toBe(false);
    expect(mockDb.site.findMany).not.toHaveBeenCalled();
  });

  it("marks an unbound site as superseded by a bound sibling on the same domain", async () => {
    mockDb.site.findUnique.mockResolvedValue({ id: "site-legacy", projectId: "project-1", domain: "https://www.oceanicvibes.com/",
      connectorBinding: null });
    mockDb.site.findMany.mockResolvedValue([
      { projectId: "project-1", domain: "other.example", connectorBinding: { status: "ACTIVE", executor: "helloada" } },
      { projectId: "project-1", domain: "oceanicvibes.com", connectorBinding: { status: "ACTIVE", executor: "helloada" } },
    ]);
    await expect(isSupersededByExternalAuthority("site-legacy")).resolves.toBe(true);
  });

  it("ignores an inactive sibling binding and a different domain", async () => {
    mockDb.site.findUnique.mockResolvedValue({ id: "site-legacy", projectId: "project-1", domain: "oceanicvibes.com",
      connectorBinding: null });
    mockDb.site.findMany.mockResolvedValue([
      { projectId: "project-1", domain: "oceanicvibes.com", connectorBinding: { status: "INACTIVE", executor: "helloada" } },
      { projectId: "project-1", domain: "other.example", connectorBinding: { status: "ACTIVE", executor: "helloada" } },
    ]);
    await expect(isSupersededByExternalAuthority("site-legacy")).resolves.toBe(false);
  });

  it("resolves a duplicate site's authority to the bound sibling for its domain", async () => {
    mockDb.site.findUnique.mockResolvedValue({
      id: "site-legacy", projectId: "project-1", domain: "https://www.oceanicvibes.com/",
      connectorBinding: null,
      connectorContext: null,
    });
    mockDb.site.findMany.mockResolvedValue([
      { projectId: "project-1", domain: "oceanicvibes.com", connectorBinding: { status: "ACTIVE", executor: "helloada" },
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
        id: "site-1", projectId: "project-1", domain: "oceanicvibes.com",
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

describe("superseded duplicate sites", () => {
  const local = (id: string, domain: string, projectId = "project-1") => ({ id, domain, projectId, connectorBinding: null });
  const bound = (id: string, domain: string) => ({
    id,
    projectId: "project-1",
    domain,
    connectorBinding: { status: "ACTIVE", executor: "helloada" },
  });

  it("supersedes every same-domain local row when an external binding exists", () => {
    const superseded = supersededSiteIds([
      local("legacy", "https://www.oceanicvibes.com/"),
      bound("canonical", "oceanicvibes.com"),
      local("unrelated", "example.com"),
    ]);
    expect([...superseded]).toEqual(["legacy"]);
  });

  it("keeps rows when no binding exists or when the binding is local", () => {
    expect(supersededSiteIds([
      local("a", "oceanicvibes.com"),
      { id: "b", domain: "oceanicvibes.com", connectorBinding: { status: "ACTIVE", executor: "crawlseo-agent" } },
      { id: "c", domain: "oceanicvibes.com", connectorBinding: { status: "INACTIVE", executor: "helloada" } },
    ]).size).toBe(0);
  });

  it("does not pick a winner between two externally bound rows", () => {
    expect(supersededSiteIds([
      bound("one", "oceanicvibes.com"),
      bound("two", "oceanicvibes.com"),
    ]).size).toBe(0);
  });

  it("keeps same-domain businesses in different projects independent", () => {
    const sites = [
      local("project-one-local", "https://www.shared.example/", "project-one"),
      { id: "project-two-bound", projectId: "project-two", domain: "shared.example",
        connectorBinding: { status: "ACTIVE", executor: "helloada" } },
    ];
    expect(supersededSiteIds(sites)).toEqual(new Set());
  });
});
