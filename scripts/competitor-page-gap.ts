/**
 * CMP-006: read the pages that are beating us, for the queries we have work on.
 *
 *   npx tsx scripts/competitor-page-gap.ts --site <siteId> --dry-run
 *   npx tsx scripts/competitor-page-gap.ts --site <siteId> --apply --limit 20
 *
 * What it does:
 *  - reads the competitor URLs already stored by CMP-003 for queries with a live
 *    opportunity (never every query),
 *  - fetches the page, extracts the same profile the site crawl extracts, and stores
 *    it as `onpage_crawl` with `scope: "competitor"` so a second opportunity on the
 *    same query reuses it,
 *  - caches for 30 days, including failures, so a 404 is not retried every run,
 *  - reports fetched / cached / unreadable / skipped, so a cap is visible.
 *
 * HTTP only. No provider call, no credential, no cost. Nothing is copied into our
 * pages: the profile is evidence.
 */

import { PrismaClient } from "@prisma/client";
import { loadEnvConfig } from "@next/env";

if (!process.env.DATABASE_URL) loadEnvConfig(process.cwd());

import { competitorPageGap, competitorReferences, ourPageProfile, storeCompetitorProfile } from "@/lib/funnel/competitor-page-gap";
import { queryFromDedupKey } from "@/lib/funnel/cluster-resolver";
import type { PageProfile } from "@/lib/funnel/page-gap";

type Args = { siteId: string; apply: boolean; limit: number; maxPages: number };

function parseArgs(argv: string[]): Args {
  const args: Args = { siteId: "", apply: false, limit: 20, maxPages: 60 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--site") args.siteId = argv[++index] ?? "";
    else if (flag === "--limit") args.limit = Number(argv[++index]);
    else if (flag === "--max-pages") args.maxPages = Number(argv[++index]);
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--dry-run") args.apply = false;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.siteId) throw new Error("--site is required");

  const db = new PrismaClient();
  try {
    const site = await db.site.findUnique({
      where: { id: args.siteId },
      select: { id: true, domain: true, projectId: true },
    });
    if (!site || !site.projectId) throw new Error(`no site with a project for ${args.siteId}`);

    // Only queries that already have a live opportunity, per the issue's boundary.
    // The dedup key is not the only place a query can come from: a CMP-003
    // competitor row names both the query and the page, so it is a stronger source
    // for this purpose. Both are used, and a query nobody has work on is not fetched.
    const opportunities = await db.opportunity.findMany({
      where: { projectId: site.projectId, status: { in: ["detected", "accepted", "in_progress"] } },
      select: { dedupKey: true, clusterId: true },
      orderBy: { scoreValue: "desc" },
      take: args.limit,
    });

    const queries: string[] = [];
    const seen = new Set<string>();
    for (const row of opportunities) {
      const query = queryFromDedupKey(row.dedupKey);
      if (!query) continue;
      const key = query.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push(query);
    }

    // The queries a competitor row names are queries with pages above us, which is
    // exactly what this stage needs. Restricted to clusters that hold live work when
    // any exist, so the boundary still holds.
    const competitorQueryRows = await db.evidenceRecord.findMany({
      where: { projectId: site.projectId, kind: "competitor_rank", supersededById: null },
      select: { dimensions: true },
    });
    const liveClusterSlugs = new Set<string>();
    for (const row of opportunities) {
      if (!row.clusterId) continue;
      const cluster = await db.demandMapCluster.findUnique({
        where: { id: row.clusterId },
        select: { slug: true },
      });
      if (cluster?.slug) liveClusterSlugs.add(cluster.slug);
    }
    for (const row of competitorQueryRows) {
      const dims = (row.dimensions ?? {}) as { query?: string; cluster?: string; url?: string };
      if (typeof dims.query !== "string" || !dims.query.trim()) continue;
      if (!dims.url) continue;
      if (liveClusterSlugs.size > 0 && dims.cluster && !liveClusterSlugs.has(dims.cluster)) continue;
      const key = dims.query.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push(dims.query);
    }

    process.stdout.write(`site: ${site.domain}\n`);
    process.stdout.write(`live opportunities: ${opportunities.length} -> ${queries.length} distinct queries\n`);

    if (queries.length === 0) {
      process.stdout.write("no query resolves from a live opportunity; nothing to compare\n");
      return;
    }

    // Our own page profile, when a crawl recorded one. The comparison needs both
    // sides; without ours the script still reads competitors but claims no deficit.
    let remaining = args.maxPages;
    let totalFetched = 0;
    let totalCached = 0;
    let totalUnreadable = 0;
    let totalSkipped = 0;
    let withDeficit = 0;
    let withoutDeficit = 0;
    const samples: string[] = [];

    for (const query of queries) {
      const references = await competitorReferences(db, { projectId: site.projectId, query });
      if (references.length === 0) continue;

      // Both sides of the comparison: our crawled page and the pages above it.
      const ours = await ourPageProfile(db, { projectId: site.projectId, query });
      const result = await competitorPageGap(db, {
        projectId: site.projectId,
        siteId: site.id,
        query,
        ours: ours?.profile ?? null,
        remaining,
        apply: args.apply,
        store: async (profile: PageProfile) =>
          storeCompetitorProfile(db, { projectId: site.projectId!, siteId: site.id, query, profile }),
      });

      remaining -= result.fetch.fetched;
      totalFetched += result.fetch.fetched;
      totalCached += result.fetch.cached;
      totalUnreadable += result.fetch.unreadable;
      totalSkipped += result.fetch.skipped;
      if (result.gap.deficits.length > 0) withDeficit += 1;
      else if (result.gap.readable.length > 0) withoutDeficit += 1;

      if (samples.length < 6) {
        samples.push(
          `  ${query.slice(0, 34).padEnd(36)} ${result.gap.readable.length} readable · ${result.gap.deficits.length} deficit(s)` +
            (result.gap.deficits.length > 0 ? ` · ${result.gap.deficits[0].sentence}` : "")
        );
      }
    }

    for (const line of samples) process.stdout.write(`${line}\n`);
    process.stdout.write(`\nfetched: ${totalFetched}\n`);
    process.stdout.write(`cached: ${totalCached}\n`);
    process.stdout.write(`unreadable: ${totalUnreadable}\n`);
    process.stdout.write(`skipped (cap reached): ${totalSkipped}\n`);
    process.stdout.write(`queries with a concrete deficit: ${withDeficit}\n`);
    process.stdout.write(`queries with no measurable deficit: ${withoutDeficit}\n`);
    if (!args.apply) process.stdout.write("dry run: fetched nothing, wrote nothing\n");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
