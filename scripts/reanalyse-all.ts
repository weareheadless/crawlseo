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
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { refreshFunnelForSite } from "@/lib/funnel/backfill";

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

type SnapshotRow = {
  id: string;
  dedupKey: string;
  type: string;
  title: string;
  scoreValue: number | null;
  evidenceCompleteness: string;
  status: string;
  assessmentVersion: number;
};

type Snapshot = {
  takenAt: string;
  sites: Array<{ siteId: string; domain: string; opportunities: SnapshotRow[] }>;
};

async function takeSnapshot(db: PrismaClient, path: string) {
  const sites = await db.site.findMany({
    where: { retiredAt: null, projectId: { not: null } },
    select: { id: true, domain: true, projectId: true },
  });
  const snapshot: Snapshot = { takenAt: new Date().toISOString(), sites: [] };
  for (const site of sites) {
    const opportunities = await db.opportunity.findMany({
      where: { projectId: site.projectId! },
      select: { id: true, dedupKey: true, type: true, title: true, scoreValue: true, evidenceCompleteness: true, status: true, assessmentVersion: true },
    });
    snapshot.sites.push({ siteId: site.id, domain: site.domain, opportunities });
  }
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

async function restore(db: PrismaClient, path: string) {
  if (!existsSync(path)) throw new Error(`snapshot not found: ${path}`);
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  let restored = 0;
  for (const site of snapshot.sites) {
    for (const row of site.opportunities) {
      await db.opportunity.update({
        where: { id: row.id },
        data: {
          title: row.title,
          scoreValue: row.scoreValue,
          evidenceCompleteness: row.evidenceCompleteness as never,
          assessmentVersion: row.assessmentVersion,
        },
      }).then(() => { restored += 1; }).catch(() => undefined);
    }
  }
  process.stdout.write(`restored ${restored} opportunity row(s) from ${path}\n`);
}

async function main() {
  const db = new PrismaClient();
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  const restorePath = value("--restore");
  const snapshotPath = value("--snapshot");
  const onlySite = value("--site");

  if (restorePath) {
    await restore(db, restorePath);
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
    const snapshot = await takeSnapshot(db, snapshotPath);
    process.stdout.write(`snapshot: ${snapshot.sites.reduce((sum, site) => sum + site.opportunities.length, 0)} row(s) → ${snapshotPath}\n`);
  }

  for (const site of sites) {
    if (dryRun) {
      const before = await db.opportunity.count({ where: { projectId: site.projectId!, status: "detected" } });
      process.stdout.write(`${site.domain}: ${before} published (dry run, no writes)\n`);
      continue;
    }
    const result = await refreshFunnelForSite(db, site.id, { detectedBy: "batch-reanalysis" });
    const after = await db.opportunity.count({ where: { projectId: site.projectId!, status: "detected" } });
    process.stdout.write(
      `${site.domain}: window ${result.window?.days ?? 0}d, rank ${result.rankEvidence}, crawl ${result.crawlEvidence}, detected ${after} (created ${result.created}, updated ${result.updated})\n`
    );
    for (const skipped of result.skipped) process.stdout.write(`  ! ${skipped}\n`);
  }

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
