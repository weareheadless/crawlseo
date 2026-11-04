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
import { createHash } from "node:crypto";
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
  summary: string;
  scoreValue: number | null;
  scoreInputs: unknown;
  evidenceCompleteness: string;
  status: string;
  parkReason: string | null;
  assessmentVersion: number;
  decidedBy: string | null;
  decidedAt: string | null;
  updatedAt: string;
};

type Snapshot = {
  takenAt: string;
  checksum: string;
  sites: Array<{ siteId: string; domain: string; opportunities: SnapshotRow[] }>;
};

async function takeSnapshot(db: PrismaClient, path: string) {
  const sites = await db.site.findMany({
    where: { retiredAt: null, projectId: { not: null } },
    select: { id: true, domain: true, projectId: true },
  });
  const snapshot: Snapshot = { takenAt: new Date().toISOString(), checksum: "", sites: [] };
  for (const site of sites) {
    const opportunities = await db.opportunity.findMany({
      where: { projectId: site.projectId! },
      select: {
        id: true, dedupKey: true, type: true, title: true, summary: true, scoreValue: true,
        scoreInputs: true, evidenceCompleteness: true, status: true, parkReason: true,
        assessmentVersion: true, decidedBy: true, decidedAt: true, updatedAt: true,
      },
    });
    snapshot.sites.push({
      siteId: site.id,
      domain: site.domain,
      opportunities: opportunities.map((row) => ({
        ...row,
        decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  }
  // The published state is customer data: checksum it so a truncated or edited
  // snapshot fails loudly instead of restoring half a board.
  const body = JSON.stringify({ ...snapshot, checksum: undefined });
  snapshot.checksum = createHash("sha256").update(body).digest("hex");
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

async function restore(db: PrismaClient, path: string) {
  if (!existsSync(path)) throw new Error(`snapshot not found: ${path}`);
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  if (!snapshot.checksum) throw new Error("snapshot has no checksum; refusing to restore it");
  const body = JSON.stringify({ ...snapshot, checksum: undefined });
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== snapshot.checksum) throw new Error("snapshot checksum does not match its contents");

  const takenAt = new Date(snapshot.takenAt).getTime();
  let restored = 0;
  const conflicts: string[] = [];
  for (const site of snapshot.sites) {
    for (const row of site.opportunities) {
      const current = await db.opportunity.findUnique({
        where: { id: row.id },
        select: { updatedAt: true, decidedBy: true, decidedAt: true },
      });
      if (!current) continue;
      // Never overwrite a human decision made after the snapshot was taken.
      const decidedAfter = current.decidedAt ? current.decidedAt.getTime() > takenAt : false;
      if (decidedAfter) {
        conflicts.push(`${site.domain}: ${row.dedupKey} was decided after the snapshot`);
        continue;
      }
      await db.opportunity.update({
        where: { id: row.id },
        data: {
          title: row.title,
          summary: row.summary,
          scoreValue: row.scoreValue,
          scoreInputs: row.scoreInputs as never,
          evidenceCompleteness: row.evidenceCompleteness as never,
          status: row.status as never,
          parkReason: row.parkReason,
          assessmentVersion: row.assessmentVersion,
        },
      });
      restored += 1;
    }
  }
  process.stdout.write(`restored ${restored} opportunity row(s) from ${path}\n`);
  if (conflicts.length > 0) {
    process.stdout.write(`\n${conflicts.length} row(s) kept their newer human decision:\n`);
    for (const conflict of conflicts) process.stdout.write(`  ! ${conflict}\n`);
  }
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
