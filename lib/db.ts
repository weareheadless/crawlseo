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

// Legacy funnel tables are frozen read-only only once their producers are gone:
// see `FROZEN_NOW` / `FROZEN_CREATES` in `lib/funnel/legacy-freeze.ts`, which are
// both empty today because every table in that file still has a live writer.
// `FROZEN_FUNNEL_MODELS` is the audit list, NOT the set of frozen tables — reading
// it as the freeze set is what once made this comment claim a cutover was safe.
// Enabling this flag while a producer still runs breaks that producer, so it is
// gated and off everywhere.
export const db =
  process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE === "strict"
    ? withFrozenLegacyFunnel(rawClient)
    : rawClient;

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
