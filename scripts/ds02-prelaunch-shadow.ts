/**
 * DS-02 prelaunch cutover, step 1: backfill the project-scoped prelaunch runs into
 * `ResearchRun` as kind `PRELAUNCH`.
 *
 * Idempotent: re-running updates the same shadow row via the
 * (projectId, kind, idempotencyKey) unique key.
 *
 *   npx tsx scripts/ds02-prelaunch-shadow.ts [--dry-run]
 */

import { PrismaClient } from "@prisma/client";

import { syncPrelaunchRunToResearchRun } from "@/lib/dataforseo/run-shadow";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = new PrismaClient();

  const runs = await db.seoResearchRun.findMany({
    where: { siteId: null },
    select: {
      id: true,
      projectId: true,
      status: true,
      brief: true,
      taskLimit: true,
      taskCount: true,
      actualCostMicros: true,
      report: true,
      errorCode: true,
      periodStart: true,
      idempotencyKey: true,
      requestedAt: true,
      startedAt: true,
      completedAt: true,
    },
  });

  const results: Array<{ id: string; shadowId: string | null }> = [];
  for (const run of runs) {
    if (dryRun) {
      results.push({ id: run.id, shadowId: null });
      continue;
    }
    const shadow = await syncPrelaunchRunToResearchRun(db as never, run);
    results.push({ id: run.id, shadowId: shadow.id });
  }

  const shadows = await db.researchRun.count({ where: { kind: "PRELAUNCH" } });
  process.stdout.write(
    `${JSON.stringify({ dryRun, legacyRuns: runs.length, written: results.filter((r) => r.shadowId).length, prelaunchShadows: shadows }, null, 1)}\n`
  );
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`${String(error).slice(0, 400)}\n`);
  process.exitCode = 1;
});
