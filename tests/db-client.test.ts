import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => [] as unknown[]);

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor(options?: unknown) {
      constructed.push(options);
    }
    $queryRaw = vi.fn();
  },
}));

/**
 * The client must be constructible with no `DATABASE_URL` at module evaluation.
 *
 * ES module imports are evaluated before a script body runs, so every script
 * that does `import { db } from "@/lib/db"` and then `loadEnvConfig()` builds
 * this client before the env files are read. Passing `datasources: { db: { url:
 * undefined } }` makes Prisma throw at construction, which is how the daily GSC
 * sync cron and the delivery-outcome cron died on 2026-11-25 while the worker,
 * which reads the env files first, kept running.
 */
describe("db client", () => {
  // Outside production the module caches its client on `global`, so a reset
  // alone would hand the next case the previous client.
  const reset = () => {
    constructed.length = 0;
    delete (global as { prisma?: unknown }).prisma;
    vi.resetModules();
  };

  beforeEach(reset);

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CRAWLSEO_DB_POOL;
    reset();
  });

  it("constructs without a DATABASE_URL instead of throwing", async () => {
    delete process.env.DATABASE_URL;

    await expect(import("@/lib/db")).resolves.toBeDefined();
    expect(constructed).toHaveLength(1);
    // No override: Prisma resolves DATABASE_URL when it connects, which is
    // after the script has loaded its env files.
    expect(constructed[0]).not.toHaveProperty("datasources");
  });

  it("passes the pool overrides only when a URL exists", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.CRAWLSEO_DB_POOL = "12";

    await import("@/lib/db");

    const options = constructed[0] as { datasources?: { db?: { url?: string } } };
    const url = new URL(options.datasources?.db?.url ?? "");
    expect(url.searchParams.get("connection_limit")).toBe("12");
    expect(url.searchParams.get("pool_timeout")).toBe("20");
  });

  it("leaves the URL untouched when no pool size is set", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";

    await import("@/lib/db");

    const options = constructed[0] as { datasources?: { db?: { url?: string } } };
    expect(options.datasources?.db?.url).toBe("postgresql://user:pass@localhost:5432/db");
  });
});
