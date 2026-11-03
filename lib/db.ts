import { PrismaClient } from "@prisma/client";

import { withFrozenLegacyFunnel } from "@/lib/funnel/legacy-freeze";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

const rawClient =
  globalForPrisma.prisma ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
  });

// Legacy funnel tables are frozen read-only at CUTOVER, not before
// (docs/seo-funnel-spine-plan.md §6): legacy scheduled producers (crawl issue
// sync, research sync) still own writes to these tables until their funnel
// replacements exist. The global freeze is therefore gated and must be
// enabled only in the cutover release (CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict).
// The mechanism itself is implemented and tested in lib/funnel/legacy-freeze.ts.
export const db =
  process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE === "strict"
    ? withFrozenLegacyFunnel(rawClient)
    : rawClient;

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
