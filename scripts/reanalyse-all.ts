/**
 * Batch reanalysis with a rollback snapshot (plan P9).
 *
 *   npx tsx scripts/reanalyse-all.ts --dry-run
 *   npx tsx scripts/reanalyse-all.ts --apply --snapshot .releases/board-<ts>.json
 *   npx tsx scripts/reanalyse-all.ts --restore .releases/board-<ts>.json
 *
 * Rebuilding the projection changes what the board says. This runs it for every
 * live tenant, in one idempotent pass, and writes a snapshot of the published
 * board first so the change can be reversed without deleting evidence or touching
 * accepted work.
 *
 * It is an operational tool, not a per-tenant repair: there is no site-specific
 * branch anywhere in it.
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { refreshFunnelForSite } from "@/lib/funnel/backfill";
import { restoreBoardSnapshot, takeBoardSnapshot } from "@/lib/ops/board-snapshot";
import { reassessProjectRecommendations } from "@/lib/recommendation/reassess";

/** One site per project: a preview mirror must not be analysed as a second tenant. */
function dedupeByProject<T extends { projectId: string | null; domain: string }>(sites: T[]): T[] {
  const byProject = new Map<string, T>();
  for (const site of sites) {
    if (!site.projectId) continue;
    const existing = byProject.get(site.projectId);
    if (!existing) {
      byProject.set(site.projectId, site);
      continue;
    }
    // Prefer the real domain over a workers.dev preview mirror.
    if (existing.domain.includes("workers.dev") && !site.domain.includes("workers.dev")) {
      byProject.set(site.projectId, site);
    }
  }
  return [...byProject.values()];
}

function value(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main() {
  const db = new PrismaClient();
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  const restorePath = value("--restore");
  const snapshotPath = value("--snapshot");
  const onlySite = value("--site");

  if (restorePath) {
    const result = await restoreBoardSnapshot(db, restorePath);
    process.stdout.write(`restored ${result.restored} opportunity row(s) from ${restorePath}\n`);
    if (result.conflicts.length > 0) {
      process.stdout.write(`\n${result.conflicts.length} row(s) kept their newer human decision:\n`);
      for (const conflict of result.conflicts) process.stdout.write(`  ! ${conflict}\n`);
    }
    await db.$disconnect();
    return;
  }
  if (!dryRun && !apply) throw new Error("--dry-run, --apply or --restore <path> is required");

  const sites = dedupeByProject(await db.site.findMany({
    where: { retiredAt: null, projectId: { not: null }, ...(onlySite ? { id: onlySite } : {}) },
    select: { id: true, domain: true, projectId: true },
    orderBy: { createdAt: "asc" },
  }));

  if (apply && snapshotPath) {
    const snapshot = await takeBoardSnapshot(db, snapshotPath);
    process.stdout.write(`snapshot: ${snapshot.sites.reduce((sum, site) => sum + site.opportunities.length, 0)} row(s) → ${snapshotPath}\n`);
  }

  for (const site of sites) {
    if (dryRun) {
      const before = await db.opportunity.count({ where: { projectId: site.projectId!, status: "detected" } });
      const rec = await reassessProjectRecommendations(db, {
        projectId: site.projectId!,
        siteId: site.id,
        dryRun: true,
      });
      process.stdout.write(
        `${site.domain}: ${before} published (dry run, no writes); recommendations ${rec.current} current, ${rec.stale} stale, ${rec.missing} missing\n`
      );
      continue;
    }
    const result = await refreshFunnelForSite(db, site.id, { detectedBy: "batch-reanalysis" });
    const rec = await reassessProjectRecommendations(db, {
      projectId: site.projectId!,
      siteId: site.id,
      maxAssessments: 6,
    });
    const after = await db.opportunity.count({ where: { projectId: site.projectId!, status: "detected" } });
    process.stdout.write(
      `${site.domain}: window ${result.window?.days ?? 0}d, rank ${result.rankEvidence}, crawl ${result.crawlEvidence}, detected ${after} (created ${result.created}, updated ${result.updated}); recommendations ${rec.assessed} assessed, ${rec.reused} reused, ${rec.failed} failed, ${rec.skipped} skipped\n`
    );
    for (const skipped of result.skipped) process.stdout.write(`  ! ${skipped}\n`);
  }

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
