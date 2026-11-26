#!/usr/bin/env node
/**
 * Undo the rows a `dryRun` detector run parked.
 *
 * `runDetectors` guarded only `applyDecisionSuppression` behind `dryRun`, so the three other
 * sweeps wrote on every "shadow" comparison. Fleet measurement taken on 2026-11-25 to decide
 * whether turning the detectors back on was safe parked **129 live rows across all 8 tenants** —
 * 76 of them the topic map's own `O3_content_gap` rows, reached because `clusterPlayDetector`
 * emits that type from outside the ownership-filtered detector loop.
 *
 * `superseded` is deliberately absent from `RESTORABLE_PARK_REASONS`, so nothing would have
 * brought them back on its own.
 *
 * Rows are matched on the writer a bare `runDetectors` call uses: production always passes an
 * explicit `detectedBy` (`funnel-refresh`, `tenant-analysis`, ...), so `funnel-detectors`
 * identifies script and measurement runs only. Restore, then run a real refresh per tenant: the
 * fixed code re-decides each row, so genuinely stale ones park again and the ones that were only
 * casualties of the measurement come back.
 *
 *   npx tsx scripts/restore-dryrun-parked.ts --dry-run
 *   npx tsx scripts/restore-dryrun-parked.ts --apply --since-hours 6
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { PrismaClient } from "@prisma/client";

/** The writer a `runDetectors` call falls back to when no producer is named. */
const SCRIPT_WRITER = "funnel-detectors";
const PARK_REASON = "superseded";

async function main() {
  const apply = process.argv.includes("--apply");
  const sinceArg = process.argv.find((arg) => arg.startsWith("--since-hours="));
  const sinceHours = sinceArg ? Number(sinceArg.split("=")[1]) : 6;
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

  const db = new PrismaClient();
  const rows = await db.opportunity.findMany({
    where: { decidedBy: SCRIPT_WRITER, parkReason: PARK_REASON, decidedAt: { gte: since } },
    select: { id: true, type: true, projectId: true, scoreValue: true, title: true },
  });

  const sites = await db.site.findMany({ select: { domain: true, projectId: true } });
  const domainOf = new Map(sites.filter((site) => site.projectId).map((site) => [site.projectId, site.domain]));

  const byTenant = new Map<string, { rows: number; highValue: number }>();
  for (const row of rows) {
    const domain = domainOf.get(row.projectId) ?? "(unknown project)";
    const entry = byTenant.get(domain) ?? { rows: 0, highValue: 0 };
    entry.rows += 1;
    if ((row.scoreValue ?? 0) >= 10) entry.highValue += 1;
    byTenant.set(domain, entry);
  }

  console.log(`rows parked by dry runs in the last ${sinceHours}h: ${rows.length}`);
  for (const [domain, entry] of [...byTenant].sort((a, b) => b[1].rows - a[1].rows)) {
    console.log(`  ${domain.padEnd(26)} ${String(entry.rows).padStart(4)} rows, ${entry.highValue} scoring 10+`);
  }

  if (rows.length === 0) {
    console.log("nothing to restore");
    await db.$disconnect();
    return;
  }
  if (!apply) {
    console.log("\ndry run; re-run with --apply to restore, then refresh each tenant so the fixed code re-decides");
    await db.$disconnect();
    return;
  }

  const result = await db.opportunity.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: { status: "detected", parkReason: null, decidedBy: null, decidedAt: null },
  });
  console.log(`\nrestored: ${result.count}`);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
