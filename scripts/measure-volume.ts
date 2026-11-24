/**
 * CMP-005: measure the search volume of the tracked grid.
 *
 *   npx tsx scripts/measure-volume.ts --site <siteId> --month 2026-11 --dry-run
 *   npx tsx scripts/measure-volume.ts --site <siteId> --month 2026-11 --apply
 *
 * It buys nothing on `--dry-run`: it prints the grid, the queries it would
 * measure, the batches, the cost, and everything it would not send. That is the
 * report the issue requires before anything is spent.
 *
 * It measures only the queries a person declared as the grid (CMP-004), reuses
 * anything already measured this month, and reports every query the provider
 * returned nothing for as "not measured" rather than inventing a number.
 */

import { PrismaClient } from "@prisma/client";
import { loadEnvConfig } from "@next/env";

if (!process.env.DATABASE_URL) loadEnvConfig(process.cwd());

import { measureGridVolume } from "@/lib/funnel/volume-measurement";
import { providerCountry, resolveSiteContext } from "@/lib/site/context";
import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";

type Args = { siteId: string; month: string; apply: boolean; capMicros?: number };

function parseArgs(argv: string[]): Args {
  const args: Args = { siteId: "", month: "", apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--site") args.siteId = argv[++index] ?? "";
    else if (flag === "--month") args.month = argv[++index] ?? "";
    else if (flag === "--cap-micros") args.capMicros = Number(argv[++index]);
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--dry-run") args.apply = false;
  }
  return args;
}

function monthStart(month: string): Date {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.siteId) throw new Error("--site is required");
  const month = args.month || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`--month must be YYYY-MM, got "${month}"`);

  const db = new PrismaClient();
  try {
    const site = await db.site.findUnique({
      where: { id: args.siteId },
      select: { id: true, domain: true, projectId: true },
    });
    if (!site || !site.projectId) throw new Error(`no site with a project for ${args.siteId}`);

    const context = await resolveSiteContext(db as never, site.id);
    const country = providerCountry(context);
    if (!country) throw new Error(`${site.domain} has no audience market or country: refusing to buy a volume for a market nobody named`);
    const resolved = await resolveDataForSeoLocale(site.projectId, context.language ?? "en", country);

    const { plan, result } = await measureGridVolume(db, {
      projectId: site.projectId,
      siteId: site.id,
      monthStart: monthStart(month),
      languageCode: resolved.languageCode,
      locationCode: resolved.locationCode,
      apply: args.apply,
      capMicros: args.capMicros,
    });

    process.stdout.write(`site: ${site.domain}\n`);
    process.stdout.write(`month: ${month}\n`);
    process.stdout.write(`grid: ${plan.toMeasure.length + plan.reused.length} tracked queries\n`);
    process.stdout.write(`already measured this month: ${plan.reused.length}\n`);
    process.stdout.write(`to measure: ${plan.toMeasure.length} in ${plan.batches.length} batches of up to ${plan.batchSize}\n`);
    for (const batch of plan.batches) {
      process.stdout.write(`  batch of ${batch.queries.length}: $${(batch.estimatedMicros / 1_000_000).toFixed(4)}\n`);
    }
    process.stdout.write(`estimated cost: $${(plan.estimatedMicros / 1_000_000).toFixed(4)}\n`);

    if (!args.apply) {
      process.stdout.write("dry run: bought nothing\n");
      return;
    }

    process.stdout.write(`\nmeasured: ${result.measured.length}\n`);
    for (const row of result.measured) process.stdout.write(`  ${row.query}: ${row.volume}/mo\n`);
    if (result.unmeasured.length > 0) {
      process.stdout.write(`not measured (the provider returned no volume): ${result.unmeasured.length}\n`);
      for (const query of result.unmeasured) process.stdout.write(`  ${query}\n`);
    }
    if (result.truncations.count > 0) {
      process.stdout.write(`not sent (cap reached): ${result.truncations.count}\n`);
    }
    process.stdout.write(`spent: ${result.spentMicros} micros over ${result.batches} batches\n`);
    if (result.error) process.stdout.write(`error: ${result.error}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
