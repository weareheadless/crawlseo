import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The freeze has two halves that can drift apart: the guard in
 * `lib/funnel/legacy-freeze.ts`, and the wiring in `lib/db.ts` that decides
 * whether the shared client is wrapped at all.
 *
 * The wiring is the half that failed in production: the flag was in `.env`, but
 * the worker release carried no `.env` and the web start script never sourced
 * one, so the client was never wrapped. These tests assert the wiring itself, not
 * just the helper.
 */

const writes = vi.hoisted(() => ({
  researchAction: {
    create: vi.fn().mockResolvedValue({ id: "new" }),
    update: vi.fn().mockResolvedValue({ id: "existing" }),
    findMany: vi.fn().mockResolvedValue([]),
  },
  rankSnapshot: { create: vi.fn().mockResolvedValue({ id: "snap" }) },
  evidenceRecord: { create: vi.fn().mockResolvedValue({ id: "ev" }) },
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      return writes;
    }
  },
}));

const original = process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete (globalThis as { prisma?: unknown }).prisma;
});

afterEach(() => {
  if (original === undefined) delete process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE;
  else process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE = original;
  delete (globalThis as { prisma?: unknown }).prisma;
});

describe("the shared db client applies the freeze when the flag is set", () => {
  it("blocks legacy creates when CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict", async () => {
    process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE = "strict";
    const { db } = await import("@/lib/db");
    expect(() => db.researchAction.create({ data: {} as never })).toThrow(/frozen read-only/);
    expect(writes.researchAction.create).not.toHaveBeenCalled();
  });

  it("still allows lifecycle updates so in-flight work can close", async () => {
    process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE = "strict";
    const { db } = await import("@/lib/db");
    await expect(db.researchAction.update({ where: { id: "x" }, data: {} as never })).resolves.toEqual({ id: "existing" });
  });

  it("leaves non-legacy tables untouched", async () => {
    process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE = "strict";
    const { db } = await import("@/lib/db");
    await expect(db.evidenceRecord.create({ data: {} as never })).resolves.toEqual({ id: "ev" });
  });

  it("does not wrap the client when the flag is absent", async () => {
    delete process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE;
    const { db } = await import("@/lib/db");
    // Unwrapped: the create reaches the (mocked) client instead of throwing.
    await expect(db.researchAction.create({ data: {} as never })).resolves.toEqual({ id: "new" });
    expect(writes.researchAction.create).toHaveBeenCalledTimes(1);
  });

  it("does not wrap the client for a value other than strict", async () => {
    process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE = "on";
    const { db } = await import("@/lib/db");
    await expect(db.researchAction.create({ data: {} as never })).resolves.toEqual({ id: "new" });
  });
});
