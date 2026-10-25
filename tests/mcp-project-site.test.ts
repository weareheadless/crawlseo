import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({ site: { findFirst: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { projectSite } from "@/lib/projects/project-site";

describe("MCP project site resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefers the externally bound tenant site over the oldest project site", async () => {
    const bound = { id: "test-site", domain: "atelier-harmonie.weareheadless.workers.dev", gscProperty: null, userId: null };
    mockDb.site.findFirst.mockResolvedValueOnce(bound);
    await expect(projectSite("project-1")).resolves.toEqual(bound);
    expect(mockDb.site.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: "project-1", connectorBinding: { is: { status: "ACTIVE" } } },
    }));
    expect(mockDb.site.findFirst).toHaveBeenCalledTimes(1);
  });

  it("falls back to the oldest site when no site is bound", async () => {
    const oldest = { id: "prod", domain: "atelier-harmonie.com", gscProperty: "https://www.atelier-harmonie.com/", userId: null };
    mockDb.site.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(oldest);
    await expect(projectSite("project-1")).resolves.toEqual(oldest);
    expect(mockDb.site.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { projectId: "project-1" },
    }));
  });

  it("fails explicitly when the project has no site", async () => {
    mockDb.site.findFirst.mockResolvedValue(null);
    await expect(projectSite("empty")).rejects.toThrow("Project has no site");
  });
});
