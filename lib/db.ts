import { PrismaClient } from "@prisma/client";

import { withFrozenLegacyFunnel } from "@/lib/funnel/legacy-freeze";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

/**
 * Pool size per process.
 *
 * Prisma defaults to `cpus * 2 + 1` connections, which is 13 on this box, but a
 * Next server runs several processes (`CRAWLSEO_WEB_WORKERS`) and every page
 * render issues its queries concurrently. When the pool is full a request waits
 * for a free connection and the wait compounds: twenty concurrent board
 * renders went from 0.5 s to 9.4 s, and the queue surfaced as
 * "Timed out fetching a new connection from the connection pool" 500s.
 *
 * Postgres here allows 100 connections and serves a 250 MB database, so each
 * web worker gets a pool sized for the pages it serves rather than for the
 * core count. Set CRAWLSEO_DB_POOL to override.
 */
function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  const pool = process.env.CRAWLSEO_DB_POOL?.trim();
  if (!pool || !/^\d+$/.test(pool)) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("connection_limit", pool);
  // A busy pool must queue briefly rather than fail the page.
  parsed.searchParams.set("pool_timeout", "20");
  return parsed.toString();
}

/**
 * Only pass `datasources` when there is a URL to override.
 *
 * Prisma rejects an explicit `url: undefined` in the constructor, and ES module
 * imports are evaluated before the script body runs, so a script that calls
 * `loadEnvConfig()` and then imports this module was constructed with no
 * `DATABASE_URL` yet and threw before it could do anything. That is how the
 * daily GSC sync cron died on 2026-11-25: it imported `db`, `loadEnvConfig`
 * ran too late, and every run since failed at module load. With no override,
 * Prisma reads `DATABASE_URL` when it connects, which is also what makes the
 * ordering irrelevant.
 */
const override = databaseUrl();
const rawClient =
  globalForPrisma.prisma ||
  new PrismaClient({
    ...(override ? { datasources: { db: { url: override } } } : {}),
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
