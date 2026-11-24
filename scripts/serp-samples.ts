/**
 * CMP-004: the monthly SERP watch list.
 *
 *   npx tsx scripts/serp-samples.ts --site <siteId> --month 2026-11 --dry-run
 *   npx tsx scripts/serp-samples.ts --site <siteId> --month 2026-11 --apply
 *
 * What it does, and does not do:
 *  - It buys nothing on `--dry-run`: it prints the exact watch list and the
 *    estimated cost, which is the receipt the issue asks for.
 *  - It spends the bundle's *existing* SERP cap (10 per site per month). It is not
 *    a second collector; it chooses which queries the cap is spent on, so the
 *    declared grid and the queries with live work get sampled first.
 *  - It is idempotent by month: a second run in the same month buys nothing,
 *    because the month's `serp_snapshot` rows are read as already-sampled.
 *  - The free weekly trend is not touched by any of this.
 */

import { PrismaClient } from "@prisma/client";
import { loadEnvConfig } from "@next/env";

if (!process.env.DATABASE_URL) loadEnvConfig(process.cwd());

import { BUNDLE_COST_ESTIMATES } from "@/lib/research/monthly-bundle";
import { collectSerpSnapshots } from "@/lib/dataforseo/collection";
import { readWatchList } from "@/lib/funnel/serp-watch-list";
import { resolveSiteContext, providerCountry } from "@/lib/site/context";
import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";

type Args = { siteId: string; month: string; apply: boolean; cap?: number };

function parseArgs(argv: string[]): Args {
  const args: Args = { siteId: "", month: "", apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--site") args.siteId = argv[++index] ?? "";
    else if (flag === "--month") args.month = argv[++index] ?? "";
    else if (flag === "--cap") args.cap = Number(argv[++index]);
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--dry-run") args.apply = false;
  }
  return args;
}

function monthBounds(month: string): { start: Date; end: Date } {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1));
  const end = new Date(Date.UTC(year, monthNumber, 1));
  return { start, end };
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

    const { start } = monthBounds(month);
    const perCallMicros = BUNDLE_COST_ESTIMATES.serpPerQueryMicros;

    const watch = await readWatchList(db, {
      projectId: site.projectId,
      monthStart: start,
      perCallMicros,
      cap: args.cap,
    });

    process.stdout.write(`site: ${site.domain}\n`);
    process.stdout.write(`month: ${month}\n`);
    process.stdout.write(`cap: ${watch.cap} SERPs (the monthly bundle's own cap)\n`);
    process.stdout.write(`watch list: ${watch.selected.length} queries\n`);
    for (const query of watch.selected) process.stdout.write(`  - ${query}\n`);
    process.stdout.write(`already sampled this month: ${watch.reused}\n`);
    process.stdout.write(`omitted by cap: ${watch.omitted}${watch.capReached ? " (cap reached)" : ""}\n`);
    process.stdout.write(`unusable rows: ${watch.invalid}\n`);
    process.stdout.write(
      `estimated cost: $${(watch.estimatedMicros / 1_000_000).toFixed(4)} ` +
        `(${watch.estimatedMicros} micros @ $${(perCallMicros / 1_000_000).toFixed(4)}/SERP)\n`
    );

    if (!args.apply) {
      process.stdout.write("dry run: bought nothing\n");
      return;
    }
    if (watch.selected.length === 0) {
      process.stdout.write("nothing to buy\n");
      return;
    }

    const context = await resolveSiteContext(db as never, site.id);
    const country = providerCountry(context);
    if (!country) throw new Error(`${site.domain} has no audience market or country: refusing to buy a SERP for a market nobody named`);
    // The bundle resolves the market through the provider's own locale catalog, so
    // a sampled SERP is measured in the same market the keyword data came from.
    const resolved = await resolveDataForSeoLocale(site.projectId, context.language ?? "en", country);
    const result = await collectSerpSnapshots(db, {
      projectId: site.projectId,
      siteId: site.id,
      domain: site.domain,
      queries: watch.selected,
      languageCode: resolved.languageCode,
      locationCode: resolved.locationCode,
      device: "desktop",
    });
    process.stdout.write(`bought ${result.evidence.length} SERPs for ${result.spentMicros} micros\n`);
    for (const row of result.evidence) {
      const dims = row.dimensions as { query?: string };
      const metrics = row.metrics as Record<string, { value: number | null }>;
      const position = metrics["provider:position"]?.value ?? null;
      process.stdout.write(`  ${dims.query ?? "?"}: ${position == null ? "not in top results" : `#${position}`}\n`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
