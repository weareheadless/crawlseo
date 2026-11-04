import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Board snapshot and rollback (brief §6).
 *
 * A reanalysis changes what the board says, so it must be reversible without
 * deleting evidence or accepted work. Two properties matter and both were missing:
 *
 *  - the snapshot must capture the whole published state, not a few scores;
 *  - a restore must not overwrite a human decision made after the snapshot.
 */

export type SnapshotRow = {
  id: string;
  dedupKey: string;
  type: string;
  title: string;
  summary: string;
  scoreValue: number | null;
  scoreInputs: unknown;
  recommendationDecision: unknown;
  recommendationVersion: string | null;
  recommendationFingerprint: string | null;
  recommendationEvidenceId: string | null;
  evidenceCompleteness: string;
  status: string;
  parkReason: string | null;
  assessmentVersion: number;
  decidedBy: string | null;
  decidedAt: string | null;
  updatedAt: string;
};

export type BoardSnapshot = {
  takenAt: string;
  checksum: string;
  sites: Array<{ siteId: string; projectId: string; domain: string; opportunities: SnapshotRow[] }>;
};

export type SnapshotDb = Pick<PrismaClient, "site" | "opportunity">;

function checksumOf(snapshot: BoardSnapshot): string {
  const body = JSON.stringify({ ...snapshot, checksum: undefined });
  return createHash("sha256").update(body).digest("hex");
}

export async function takeBoardSnapshot(db: SnapshotDb, path: string): Promise<BoardSnapshot> {
  const sites = await db.site.findMany({
    where: { retiredAt: null, projectId: { not: null } },
    select: { id: true, domain: true, projectId: true },
  });
  const snapshot: BoardSnapshot = { takenAt: new Date().toISOString(), checksum: "", sites: [] };
  for (const site of sites) {
    const opportunities = await db.opportunity.findMany({
      where: { projectId: site.projectId! },
      select: {
        id: true, dedupKey: true, type: true, title: true, summary: true, scoreValue: true,
        scoreInputs: true, recommendationDecision: true, recommendationVersion: true,
        recommendationFingerprint: true, recommendationEvidenceId: true,
        evidenceCompleteness: true, status: true, parkReason: true,
        assessmentVersion: true, decidedBy: true, decidedAt: true, updatedAt: true,
      },
    });
    snapshot.sites.push({
      siteId: site.id,
      projectId: site.projectId!,
      domain: site.domain,
      opportunities: opportunities.map((row) => ({
        ...row,
        decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  }
  snapshot.checksum = checksumOf(snapshot);
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

export type RestoreResult = {
  restored: number;
  conflicts: string[];
};

/**
 * Restore the published state, preserving newer human decisions.
 *
 * A snapshot that does not match its checksum is refused: restoring a truncated
 * board is worse than not restoring it.
 */
export async function restoreBoardSnapshot(db: SnapshotDb, path: string): Promise<RestoreResult> {
  if (!existsSync(path)) throw new Error(`snapshot not found: ${path}`);
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as BoardSnapshot;
  if (!snapshot.checksum) throw new Error("snapshot has no checksum; refusing to restore it");
  if (checksumOf(snapshot) !== snapshot.checksum) {
    throw new Error("snapshot checksum does not match its contents");
  }

  const takenAt = new Date(snapshot.takenAt).getTime();
  let restored = 0;
  const conflicts: string[] = [];
  for (const site of snapshot.sites) {
    for (const row of site.opportunities) {
      const current = await db.opportunity.findUnique({
        where: { id: row.id },
        select: { decidedAt: true, updatedAt: true },
      });
      if (!current) continue;
      if (current.decidedAt && current.decidedAt.getTime() > takenAt) {
        conflicts.push(`${site.domain}: ${row.dedupKey} was decided after the snapshot`);
        continue;
      }
      // Compare-and-swap: a row changed between the read and this write is a
      // concurrent edit, not a row to overwrite.
      const updated = await db.opportunity.updateMany({
        where: { id: row.id, updatedAt: current.updatedAt },
        data: {
          title: row.title,
          summary: row.summary,
          scoreValue: row.scoreValue,
          scoreInputs: row.scoreInputs as never,
          recommendationDecision: row.recommendationDecision == null ? Prisma.DbNull : (row.recommendationDecision as never),
          recommendationVersion: row.recommendationVersion,
          recommendationFingerprint: row.recommendationFingerprint,
          recommendationEvidenceId: row.recommendationEvidenceId,
          evidenceCompleteness: row.evidenceCompleteness as never,
          status: row.status as never,
          parkReason: row.parkReason,
          assessmentVersion: row.assessmentVersion,
        },
      });
      if (updated.count === 0) {
        conflicts.push(`${site.domain}: ${row.dedupKey} changed concurrently`);
        continue;
      }
      restored += 1;
    }

    // A row created after the snapshot was not part of the reviewed state. Park it
    // unless a human has already accepted or progressed it.
    const snapshotIds = new Set(site.opportunities.map((row) => row.id));
    const createdAfter = await db.opportunity.findMany({
      where: { projectId: site.projectId, status: "detected" },
      select: { id: true, dedupKey: true },
    });
    for (const row of createdAfter) {
      if (snapshotIds.has(row.id)) continue;
      await db.opportunity.updateMany({
        where: { id: row.id, status: "detected" },
        data: { status: "parked", parkReason: "rollback_new_row", decidedBy: "board-restore", decidedAt: new Date() },
      });
      conflicts.push(`${site.domain}: ${row.dedupKey} was created after the snapshot and was parked`);
    }
  }
  return { restored, conflicts };
}
