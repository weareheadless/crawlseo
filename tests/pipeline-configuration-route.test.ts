import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { db, tx } = vi.hoisted(() => {
  const tx = {
    researchPolicy: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    siteProfile: { findUnique: vi.fn(), upsert: vi.fn() },
    site: { findUnique: vi.fn() },
  };
  return { db: { $transaction: vi.fn((fn: (client: typeof tx) => unknown, options?: unknown) => { void options; return fn(tx); }) }, tx };
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
    db.$transaction.mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx));
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

  it("accepts explicit clears, mirrors empty arrays, and preserves null audience semantics", async () => {
    const result = await saveConfigurationSection("site-1", "business", { audience: "", goals: [], services: [] }, 3, "2026-01-01T00:00:00.000Z");
    expect(tx.siteProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ audience: expect.anything(), services: [], constraints: expect.objectContaining({ goals: [] }) }) }));
    expect(tx.researchPolicy.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ goals: [] }) }));
    expect(result).toMatchObject({ policyRevision: 4 });
  });

  it("creates a missing operations policy at revision zero without defaults", async () => {
    tx.researchPolicy.findUnique.mockResolvedValue(null);
    await saveConfigurationSection("site-1", "operations", { cadence: "weekly" }, 0);
    expect(tx.researchPolicy.create).toHaveBeenCalledWith({ data: expect.objectContaining({ siteId: "site-1", cadence: "weekly", revision: 1 }) });
    expect(tx.researchPolicy.create.mock.calls[0][0].data).not.toHaveProperty("enabled");
    expect(db.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: "Serializable" });
  });

  it("creates absent policy and profile for a mirrored exclusions save without applying defaults", async () => {
    tx.researchPolicy.findUnique.mockResolvedValue(null); tx.siteProfile.findUnique.mockResolvedValue(null);
    await saveConfigurationSection("site-1", "research", { exclusions: [] }, 0, null);
    expect(tx.researchPolicy.create).toHaveBeenCalledWith({ data: expect.objectContaining({ siteId: "site-1", exclusions: [], revision: 1 }) });
    expect(tx.siteProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ constraints: { exclusions: [] } }) }));
    expect(tx.researchPolicy.create.mock.calls[0][0].data).not.toHaveProperty("enabled");
  });

  it("rejects a stale profile timestamp before any write", async () => {
    await expect(saveConfigurationSection("site-1", "business", { audience: "new" }, undefined, "2025-01-01T00:00:00.000Z")).rejects.toBeInstanceOf(ConfigurationConflict);
    expect(tx.siteProfile.upsert).not.toHaveBeenCalled();
  });

  it("retries only P2034 and rereads unknown constraints before applying a mirror", async () => {
    const concurrent = { hidden: "new", external: true, exclusions: ["before"] };
    tx.siteProfile.findUnique.mockResolvedValueOnce({ updatedAt: new Date("2026-01-01"), constraints: { hidden: "old" } }).mockResolvedValueOnce({ updatedAt: new Date("2026-01-01"), constraints: concurrent });
    const serialization = new Prisma.PrismaClientKnownRequestError("serialization", { code: "P2034", clientVersion: "test" });
    db.$transaction.mockImplementationOnce(async (fn: (client: typeof tx) => unknown) => { await fn(tx); throw serialization; }).mockImplementationOnce((fn: (client: typeof tx) => unknown) => fn(tx));
    await saveConfigurationSection("site-1", "research", { exclusions: [] }, 3, "2026-01-01T00:00:00.000Z");
    expect(tx.siteProfile.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: expect.objectContaining({ constraints: { ...concurrent, exclusions: [] } }) }));
  });

  it.each(["P2002", "P2025"])("maps %s races to a safe conflict", async (code) => {
    const error = new Prisma.PrismaClientKnownRequestError("db details", { code, clientVersion: "test" });
    tx.researchPolicy.update.mockRejectedValue(error);
    await expect(saveConfigurationSection("site-1", "operations", { cadence: "daily" }, 3)).rejects.toBeInstanceOf(ConfigurationConflict);
  });

  it("does not retry unexpected errors and returns safe conflict after serialization exhaustion", async () => {
    const unexpected = new Error("unexpected"); tx.researchPolicy.update.mockRejectedValue(unexpected);
    await expect(saveConfigurationSection("site-1", "operations", { cadence: "daily" }, 3)).rejects.toBe(unexpected);
    db.$transaction.mockClear();
    const serialization = new Prisma.PrismaClientKnownRequestError("serialization", { code: "P2034", clientVersion: "test" });
    db.$transaction.mockImplementation(async () => { throw serialization; });
    await expect(saveConfigurationSection("site-1", "operations", { cadence: "daily" }, 3)).rejects.toBeInstanceOf(ConfigurationConflict);
    expect(db.$transaction).toHaveBeenCalledTimes(3);
  });

  it("returns fresh tokens so consecutive saves can use the new revision", async () => {
    const first = await saveConfigurationSection("site-1", "operations", { cadence: "daily" }, 3);
    tx.researchPolicy.findUnique.mockResolvedValue({ revision: 4 });
    const second = await saveConfigurationSection("site-1", "operations", { cadence: "monthly" }, first.policyRevision);
    expect(second.policyRevision).toBe(5);
  });

  it("returns a fresh profile timestamp for a second consecutive Business save", async () => {
    const updatedAt = new Date("2026-02-01T00:00:00.000Z");
    tx.siteProfile.upsert.mockResolvedValue({ updatedAt });
    const first = await saveConfigurationSection("site-1", "business", { audience: "first" }, undefined, "2026-01-01T00:00:00.000Z");
    tx.siteProfile.findUnique.mockResolvedValue({ updatedAt, constraints: { hidden: "keep" } });
    const second = await saveConfigurationSection("site-1", "business", { market: "West" }, undefined, first.profileUpdatedAt);
    expect(second.profileUpdatedAt).toBe(updatedAt.toISOString());
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
  it("returns the section save result and covers malformed, wrong-owner, missing and stale preconditions", async () => {
    routeMocks.user.mockResolvedValue("user-1"); routeMocks.owns.mockResolvedValue(true);
    tx.researchPolicy.findUnique.mockResolvedValue({ revision: 3 }); tx.siteProfile.findUnique.mockResolvedValue({ updatedAt: new Date("2026-01-01"), constraints: {} });
    const ctx = { params: Promise.resolve({ siteId: "site-1" }) };
    const call = (body: string) => PATCH(new Request("http://local", { method: "PATCH", headers: { "Content-Type": "application/json" }, body }), ctx);
    expect((await call("{")).status).toBe(400);
    expect((await call(JSON.stringify({ section: "research", values: { cadence: "weekly" }, expectedPolicyRevision: 3 }))).status).toBe(400);
    expect((await call(JSON.stringify({ section: "research", values: { exclusions: [] } }))).status).toBe(428);
    expect((await call(JSON.stringify({ section: "research", values: { exclusions: [] }, expectedPolicyRevision: 2, expectedProfileUpdatedAt: "2026-01-01T00:00:00.000Z" }))).status).toBe(409);
    expect((await call(JSON.stringify({ section: "research", values: { exclusions: [] }, expectedPolicyRevision: 3, expectedProfileUpdatedAt: "no-date" }))).status).toBe(400);
    const success = await call(JSON.stringify({ section: "research", values: { exclusions: [] }, expectedPolicyRevision: 3, expectedProfileUpdatedAt: "2026-01-01T00:00:00.000Z" }));
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ policyRevision: 4 });
  });
});
