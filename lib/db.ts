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

// Legacy funnel tables are frozen read-only (docs/seo-funnel-spine-plan.md §6).
// The shared client rejects writes to them; reads pass through for audits.
export const db = withFrozenLegacyFunnel(rawClient);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
