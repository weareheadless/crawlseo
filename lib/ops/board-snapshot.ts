import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Board snapshot and rollback (brief §6).
 *
 * A reanalysis changes what the board says, so it must be reversible without
 * deleting evidence or accepted work. Three properties matter:
 *
 *  - the snapshot captures the whole published state, not a few scores;
 *  - a restore does not overwrite a human decision made after the snapshot;
 *  - restoring the active evidence selection is atomic and cannot leave both the
 *    snapshot row and its post-snapshot replacement active.
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

export type SnapshotEvidenceRow = {
  id: string;
  supersededById: string | null;
  observedAt: string;
  /** Creation time is the post-snapshot guard; observedAt can be backfilled. */
  createdAt: string;
  /** Compare-and-swap guard for concurrent evidence edits. */
  updatedAt: string;
};

export type SnapshotScope = {
  /** Present when the snapshot covers exactly one project. */
  projectId?: string;
  /** Present when the snapshot covers exactly one site. */
  siteId?: string;
  /** The authorised analysis run this snapshot belongs to, when known. */
  runId?: string;
  /** An explicit all-sites snapshot. Restore still requires `{ all: true }`. */
  all?: boolean;
};

export type BoardSnapshot = {
  takenAt: string;
  checksum: string;
  scope: SnapshotScope;
  sites: Array<{
    siteId: string;
    projectId: string;
    domain: string;
    opportunities: SnapshotRow[];
    /** Active/superseded selection for research evidence at snapshot time. */
    evidence: SnapshotEvidenceRow[];
  }>;
};

export type SnapshotDb = Pick<PrismaClient, "site" | "opportunity" | "evidenceRecord"> & {
  $transaction?: PrismaClient["$transaction"];
};

function checksumOf(snapshot: BoardSnapshot): string {
  const body = JSON.stringify({ ...snapshot, checksum: undefined });
  return createHash("sha256").update(body).digest("hex");
}

export async function takeBoardSnapshot(
  db: SnapshotDb,
  path: string,
  scope: SnapshotScope = {}
): Promise<BoardSnapshot> {
  const scoped = Boolean(scope.projectId || scope.siteId);
  const sites = await db.site.findMany({
    where: {
      retiredAt: null,
      projectId: { not: null },
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      ...(scope.siteId ? { id: scope.siteId } : {}),
    },
    select: { id: true, domain: true, projectId: true },
  });
  const snapshot: BoardSnapshot = {
    takenAt: new Date().toISOString(),
    checksum: "",
    scope: scope.all
      ? { all: true }
      : scoped
        ? { projectId: scope.projectId, siteId: scope.siteId, runId: scope.runId }
        : { all: true },
    sites: [],
  };
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
    const evidence = await db.evidenceRecord.findMany({
      where: { projectId: site.projectId!, kind: "research_finding" },
      select: { id: true, supersededById: true, observedAt: true, createdAt: true, updatedAt: true },
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
      evidence: evidence.map((row) => ({
        id: row.id,
        supersededById: row.supersededById,
        observedAt: row.observedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
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
  /** Snapshot sites that the requested scope excluded and left untouched. */
  skipped: string[];
};

export type RestoreScope = {
  projectId?: string;
  siteId?: string;
  runId?: string;
  /** Explicitly restore every site in the snapshot. */
  all?: boolean;
};

/**
 * Restore the published state, preserving newer human decisions.
 *
 * The whole restore is one transaction. Opportunity writes use an updatedAt
 * compare-and-swap; evidence writes use the same guard. A post-snapshot evidence
 * row is deactivated only when it is not used by preserved accepted work.
 */
export async function restoreBoardSnapshot(
  db: SnapshotDb,
  path: string,
  opts: RestoreScope = {}
): Promise<RestoreResult> {
  if (!existsSync(path)) throw new Error(`snapshot not found: ${path}`);
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as BoardSnapshot;
  if (!snapshot.checksum) throw new Error("snapshot has no checksum; refusing to restore it");
  if (checksumOf(snapshot) !== snapshot.checksum) {
    throw new Error("snapshot checksum does not match its contents");
  }
  const transaction = db.$transaction;
  if (!transaction) throw new Error("board restore requires a transaction-capable database client");

  const snapshotScope = snapshot.scope ?? { all: true };
  const explicitScope = Boolean(opts.projectId || opts.siteId);
  if (!opts.all && !explicitScope) {
    throw new Error("restore requires an explicit project/site scope or all: true");
  }
  if (opts.runId && snapshotScope.runId && opts.runId !== snapshotScope.runId) {
    throw new Error("snapshot belongs to a different analysis run");
  }
  if (snapshotScope.projectId && opts.projectId && snapshotScope.projectId !== opts.projectId) {
    throw new Error("snapshot belongs to a different project");
  }
  if (snapshotScope.siteId && opts.siteId && snapshotScope.siteId !== opts.siteId) {
    throw new Error("snapshot belongs to a different site");
  }

  const inScope = snapshot.sites.filter((site) => {
    if (opts.all) return true;
    if (opts.projectId && site.projectId !== opts.projectId) return false;
    if (opts.siteId && site.siteId !== opts.siteId) return false;
    return true;
  });
  if (inScope.length === 0) throw new Error("snapshot has no sites in the requested restore scope");
  const skipped = snapshot.sites
    .filter((site) => !inScope.includes(site))
    .map((site) => `${site.domain}: outside the requested restore scope and left unchanged`);

  const takenAt = new Date(snapshot.takenAt).getTime();
  return transaction(async (tx) => {
    let restored = 0;
    const conflicts: string[] = [];
    for (const site of inScope) {
      const preservedEvidence = new Set<string>();

      for (const row of site.opportunities) {
        const current = await tx.opportunity.findUnique({
          where: { id: row.id },
          select: { decidedAt: true, updatedAt: true, status: true, recommendationEvidenceId: true },
        });
        if (!current) continue;
        const decidedAfter = current.decidedAt ? current.decidedAt.getTime() > takenAt : false;
        const humanProgressed =
          (current.status === "accepted" || current.status === "in_progress") &&
          row.status !== current.status;
        if (decidedAfter || humanProgressed) {
          conflicts.push(`${site.domain}: ${row.dedupKey} was decided after the snapshot and was preserved`);
          if (current.recommendationEvidenceId) preservedEvidence.add(current.recommendationEvidenceId);
          continue;
        }
        // Compare-and-swap: a row changed between the read and this write is a
        // concurrent edit, not a row to overwrite.
        const updated = await tx.opportunity.updateMany({
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
      // unless a human has already accepted or progressed it. Older snapshots have no
      // projectId; refuse to guess rather than park another project's rows.
      if (!site.projectId) {
        conflicts.push(`${site.domain}: snapshot has no project id, so new rows were not reconciled`);
        continue;
      }
      const snapshotIds = new Set(site.opportunities.map((row) => row.id));
      const createdAfter = await tx.opportunity.findMany({
        where: { projectId: site.projectId, status: "detected" },
        select: { id: true, dedupKey: true },
      });
      for (const row of createdAfter) {
        if (snapshotIds.has(row.id)) continue;
        const parked = await tx.opportunity.updateMany({
          where: { id: row.id, status: "detected" },
          data: { status: "parked", parkReason: "rollback_new_row", decidedBy: "board-restore", decidedAt: new Date() },
        });
        if (parked.count === 0) {
          conflicts.push(`${site.domain}: ${row.dedupKey} changed concurrently and was not parked`);
        } else {
          conflicts.push(`${site.domain}: ${row.dedupKey} was created after the snapshot and was parked`);
        }
      }

      // Restore which research evidence was active. A record created after the
      // snapshot is newer history; it is deactivated unless preserved work uses it.
      // Human work that exists now and was accepted/progressed after the snapshot
      // keeps its evidence active even when the opportunity was created later.
      const humanWork = await tx.opportunity.findMany({
        where: {
          projectId: site.projectId,
          OR: [
            { decidedAt: { gt: new Date(takenAt) } },
            { status: { in: ["accepted", "in_progress"] } },
          ],
        },
        select: { recommendationEvidenceId: true },
      });
      for (const row of humanWork) {
        if (row.recommendationEvidenceId) preservedEvidence.add(row.recommendationEvidenceId);
      }

      const snapshotEvidenceIds = new Set(site.evidence.map((row) => row.id));
      const activeAnchor =
        site.evidence.find((row) => row.supersededById == null)?.id ?? site.evidence[0]?.id ?? null;

      for (const row of site.evidence ?? []) {
        const current = await tx.evidenceRecord.findUnique({
          where: { id: row.id },
          select: { updatedAt: true, createdAt: true, supersededById: true },
        });
        if (!current) {
          conflicts.push(`${site.domain}: evidence ${row.id} no longer exists`);
          continue;
        }
        if (current.supersededById && preservedEvidence.has(current.supersededById)) {
          conflicts.push(`${site.domain}: evidence ${row.id} remains superseded by preserved newer work`);
          continue;
        }
        const updated = await tx.evidenceRecord.updateMany({
          where: { id: row.id, updatedAt: current.updatedAt },
          data: { supersededById: row.supersededById ?? null },
        });
        if (updated.count === 0) {
          conflicts.push(`${site.domain}: evidence ${row.id} changed concurrently`);
        }
      }

      const postSnapshot = await tx.evidenceRecord.findMany({
        where: {
          projectId: site.projectId,
          kind: "research_finding",
          createdAt: { gt: new Date(takenAt) },
        },
        select: { id: true, observedAt: true, createdAt: true, supersededById: true },
      });
      for (const row of postSnapshot) {
        if (snapshotEvidenceIds.has(row.id)) continue;
        if (preservedEvidence.has(row.id)) {
          conflicts.push(`${site.domain}: evidence ${row.id} is used by preserved newer work and was left active`);
          continue;
        }
        if (row.supersededById) continue;
        if (!activeAnchor) {
          conflicts.push(`${site.domain}: evidence ${row.id} is newer than the snapshot but there is no snapshot anchor to deactivate it`);
          continue;
        }
        const deactivated = await tx.evidenceRecord.updateMany({
          where: { id: row.id, supersededById: null },
          data: { supersededById: activeAnchor },
        });
        if (deactivated.count === 0) {
          conflicts.push(`${site.domain}: evidence ${row.id} changed concurrently and was not deactivated`);
        } else {
          conflicts.push(`${site.domain}: evidence ${row.id} was created after the snapshot and was deactivated`);
        }
      }
    }
    return { restored, conflicts, skipped };
  });
}
