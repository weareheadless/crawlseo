import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { restoreBoardSnapshot, takeBoardSnapshot, type SnapshotDb } from "@/lib/ops/board-snapshot";

const at = new Date("2026-11-04T00:00:00.000Z");

function snapshotFile() {
  return join(mkdtempSync(join(tmpdir(), "board-snapshot-unit-")), "board.json");
}

function snapshotDb(over: Partial<Record<string, unknown>> = {}) {
  const opportunity = {
    id: "op1",
    dedupKey: "O13:1",
    type: "O13_user_pain_point",
    title: "Before",
    summary: "Before",
    scoreValue: 1,
    scoreInputs: {},
    recommendationDecision: { schemaVersion: "test" },
    recommendationVersion: "test/1",
    recommendationFingerprint: "fp",
    recommendationEvidenceId: null,
    evidenceCompleteness: "none",
    status: "detected",
    parkReason: null,
    assessmentVersion: 1,
    decidedBy: null,
    decidedAt: null,
    updatedAt: at,
  };
  const db = {
    site: {
      findMany: vi.fn(async () => [{ id: "s1", domain: "site.test", projectId: "p1" }]),
    },
    opportunity: {
      findMany: vi.fn(async () => [opportunity]),
    },
    evidenceRecord: {
      findMany: vi.fn(async () => []),
    },
    ...over,
  };
  return { db: db as unknown as SnapshotDb, opportunity };
}

describe("board snapshot rollback guards", () => {
  it("reports a concurrent opportunity change instead of claiming it was restored", async () => {
    const { db } = snapshotDb();
    const path = snapshotFile();
    await takeBoardSnapshot(db, path);

    const tx = {
      opportunity: {
        findUnique: vi.fn(async () => ({
          decidedAt: null,
          updatedAt: new Date(at.getTime() + 1_000),
          status: "detected",
          recommendationEvidenceId: null,
        })),
        updateMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
      evidenceRecord: {
        findUnique: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    const restoreDb = {
      ...db,
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as SnapshotDb;
    const result = await restoreBoardSnapshot(restoreDb, path, { all: true });
    expect(result.restored).toBe(0);
    expect(result.conflicts.join(" ")).toContain("changed concurrently");
  });

  it("does not report new-row parking when the parking update matched zero rows", async () => {
    const { db } = snapshotDb();
    const path = snapshotFile();
    await takeBoardSnapshot(db, path);

    const tx = {
      opportunity: {
        findUnique: vi.fn(async () => ({
          decidedAt: null,
          updatedAt: at,
          status: "detected",
          recommendationEvidenceId: null,
        })),
        updateMany: vi
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
        findMany: vi.fn(async () => [{ id: "new-row", dedupKey: "O13:new" }]),
      },
      evidenceRecord: {
        findUnique: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    const restoreDb = {
      ...db,
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as SnapshotDb;
    const result = await restoreBoardSnapshot(restoreDb, path, { all: true });
    expect(result.conflicts.join(" ")).toContain("changed concurrently and was not parked");
    expect(result.conflicts.join(" ")).not.toContain("created after the snapshot and was parked");
  });

  it("scopes a snapshot and a restore to one project", async () => {
    const opportunity = (projectId: string) => ({
      id: `op-${projectId}`,
      dedupKey: `O13:${projectId}`,
      type: "O13_user_pain_point",
      title: "Before",
      summary: "Before",
      scoreValue: 1,
      scoreInputs: {},
      recommendationDecision: null,
      recommendationVersion: null,
      recommendationFingerprint: null,
      recommendationEvidenceId: null,
      evidenceCompleteness: "none",
      status: "detected",
      parkReason: null,
      assessmentVersion: 1,
      decidedBy: null,
      decidedAt: null,
      updatedAt: at,
    });
    const db = {
      site: {
        findMany: vi.fn(async () => [
          { id: "s1", domain: "one.test", projectId: "p1" },
          { id: "s2", domain: "two.test", projectId: "p2" },
        ]),
      },
      opportunity: {
        findMany: vi.fn(async (args: { where: { projectId: string } }) => [opportunity(args.where.projectId)]),
      },
      evidenceRecord: { findMany: vi.fn(async () => []) },
    } as unknown as SnapshotDb;
    const path = snapshotFile();
    await takeBoardSnapshot(db, path);

    const tx = {
      opportunity: {
        findUnique: vi.fn(async () => ({
          decidedAt: null,
          updatedAt: at,
          status: "detected",
          recommendationEvidenceId: null,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
      },
      evidenceRecord: {
        findUnique: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    const restoreDb = {
      ...db,
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as SnapshotDb;

    await expect(restoreBoardSnapshot(restoreDb, path)).rejects.toThrow(/explicit project\/site scope/);
    const result = await restoreBoardSnapshot(restoreDb, path, { projectId: "p1" });
    expect(result.restored).toBe(1);
    expect(result.skipped.join(" ")).toContain("two.test");
    expect(tx.opportunity.updateMany).toHaveBeenCalledTimes(1);
  });

  it("propagates a transaction failure and restores nothing", async () => {
    const { db } = snapshotDb();
    const path = snapshotFile();
    await takeBoardSnapshot(db, path);
    const restoreDb = {
      ...db,
      $transaction: vi.fn(async () => {
        throw new Error("transaction failed");
      }),
    } as unknown as SnapshotDb;
    await expect(restoreBoardSnapshot(restoreDb, path, { all: true })).rejects.toThrow(/transaction failed/);
  });
});
