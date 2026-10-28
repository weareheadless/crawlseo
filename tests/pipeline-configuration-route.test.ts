import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, tx } = vi.hoisted(() => {
  const tx = {
    researchPolicy: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    siteProfile: { findUnique: vi.fn(), upsert: vi.fn() },
    site: { findUnique: vi.fn() },
  };
  return { db: { $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)) }, tx };
});
vi.mock("@/lib/db", () => ({ db }));

import { saveConfigurationSection, InvalidConfigurationSection, ConfigurationConflict, ConfigurationPreconditionRequired } from "@/lib/research/configuration-sections";

const routeMocks = vi.hoisted(() => ({ user: vi.fn(), owns: vi.fn(), get: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/session-helper", () => ({ getUserIdFromCookies: routeMocks.user }));
vi.mock("@/lib/auth/research-action-access", () => ({ userOwnsSite: routeMocks.owns }));
vi.mock("@/lib/research/policy", () => ({ DEFAULT_RESEARCH_CADENCE: "weekly", getResearchConfig: routeMocks.get, saveResearchConfig: routeMocks.save }));
import { PATCH, PUT } from "@/app/api/sites/[siteId]/research-policy/route";

describe("section configuration transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.site.findUnique.mockResolvedValue({ id: "site-1", projectId: "project-1" });
    tx.researchPolicy.findUnique.mockResolvedValue({ revision: 3, goals: ["old"], exclusions: ["old"] });
    tx.siteProfile.findUnique.mockResolvedValue({ updatedAt: new Date("2026-01-01"), constraints: { hidden: "keep", goals: ["old"], exclusions: ["old"] } });
    tx.researchPolicy.update.mockResolvedValue({});
    tx.siteProfile.upsert.mockResolvedValue({});
  });

  it("mirrors Business goals and preserves hidden constraints transactionally", async () => {
    await saveConfigurationSection("site-1", "business", { goals: ["new goal"] }, 3, "2026-01-01T00:00:00.000Z");
    expect(tx.researchPolicy.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ goals: ["new goal"] }) }));
    expect(tx.siteProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ constraints: expect.objectContaining({ hidden: "keep", goals: ["new goal"] }) }) }));
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("mirrors Research exclusions into constraints in the same transaction", async () => {
    await saveConfigurationSection("site-1", "research", { exclusions: ["competitor brand"] }, 3, "2026-01-01T00:00:00.000Z");
    expect(tx.researchPolicy.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ exclusions: ["competitor brand"] }) }));
    expect(tx.siteProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ constraints: expect.objectContaining({ hidden: "keep", exclusions: ["competitor brand"] }) }) }));
  });

  it("requires preconditions for every affected record and detects stale revisions", async () => {
    await expect(saveConfigurationSection("site-1", "research", { exclusions: ["x"] }, 3)).rejects.toBeInstanceOf(ConfigurationPreconditionRequired);
    await expect(saveConfigurationSection("site-1", "business", { goals: ["x"] }, 2, "2026-01-01T00:00:00.000Z")).rejects.toBeInstanceOf(ConfigurationConflict);
  });

  it("rejects unsupported fields, providers, and invalid numeric bounds", async () => {
    await expect(saveConfigurationSection("site-1", "research", { providers: ["web"] }, 3)).rejects.toBeInstanceOf(InvalidConfigurationSection);
    await expect(saveConfigurationSection("site-1", "research", { maxSources: 0 }, 3)).rejects.toBeInstanceOf(InvalidConfigurationSection);
    await expect(saveConfigurationSection("site-1", "research", { cadence: "weekly" }, 3)).rejects.toBeInstanceOf(InvalidConfigurationSection);
  });

  it("does not substitute creation defaults when patching an absent profile", async () => {
    tx.siteProfile.findUnique.mockResolvedValue(null);
    await saveConfigurationSection("site-1", "business", { audience: "Local operators" }, undefined, null);
    const create = tx.siteProfile.upsert.mock.calls[0][0].create;
    expect(create).toMatchObject({ audience: "Local operators" });
    expect(create).not.toHaveProperty("topics");
    expect(create).not.toHaveProperty("language");
  });
});

describe("configuration route authorization and compatibility", () => {
  beforeEach(() => { routeMocks.user.mockReset(); routeMocks.owns.mockReset(); routeMocks.get.mockReset(); routeMocks.save.mockReset(); });
  it("denies unauthenticated and cross-site access", async () => {
    routeMocks.user.mockResolvedValueOnce(null).mockResolvedValueOnce("user-1");
    routeMocks.owns.mockResolvedValue(false);
    const ctx = { params: Promise.resolve({ siteId: "site-1" }) };
    expect((await PATCH(new Request("http://local", { method: "PATCH", body: "{}" }), ctx)).status).toBe(401);
    expect((await PATCH(new Request("http://local", { method: "PATCH", body: "{}" }), ctx)).status).toBe(404);
  });
  it("keeps legacy full-form PUT behavior", async () => {
    routeMocks.user.mockResolvedValue("user-1"); routeMocks.owns.mockResolvedValue(true); routeMocks.save.mockResolvedValue({ revision: 2 });
    const response = await PUT(new Request("http://local", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topics: ["topic"], language: "en", providers: ["reddit"], maxSources: 30, monthlyBudget: 9, autoDraft: false, autoAgent: false }) }), { params: Promise.resolve({ siteId: "site-1" }) });
    expect(response.status).toBe(200);
    expect(routeMocks.save).toHaveBeenCalledOnce();
  });
});
