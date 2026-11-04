/**
 * Queue the monthly cycle for every site, or report what it would queue.
 *
 *   npx tsx scripts/monthly-cycle.ts [--dry-run] [--site <siteId>]
 *
 * The worker runs the same function on a timer; this exists for operators and for
 * a manual backfill of a month that was missed. Nothing about it is per-tenant.
 */
import { PrismaClient } from "@prisma/client";

import { runMonthlyCycle } from "@/lib/jobs/monthly-cycle";

function value(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main() {
  const db = new PrismaClient();
  const dryRun = process.argv.includes("--dry-run");
  const siteId = value("--site");
  const results = await runMonthlyCycle(db, {
    dryRun,
    siteIds: siteId ? [siteId] : undefined,
  });

  for (const site of results) {
    process.stdout.write(`\n${site.domain}  ${site.month}\n`);
    for (const stage of site.stages) {
      process.stdout.write(`  ${stage.status.padEnd(8)} ${stage.stage.padEnd(15)} ${stage.detail}\n`);
    }
  }
  const queued = results.flatMap((site) => site.stages).filter((stage) => stage.status === "queued").length;
  const failed = results.flatMap((site) => site.stages).filter((stage) => stage.status === "failed").length;
  process.stdout.write(`\n${results.length} site(s), ${queued} queued, ${failed} failed${dryRun ? " (dry run)" : ""}\n`);
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`${String(error).slice(0, 500)}\n`);
  process.exitCode = 1;
});
