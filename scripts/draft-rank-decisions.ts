/**
 * Draft the editorial decisions for open rank-detector rows (O2 first).
 *
 *   npx tsx scripts/draft-rank-decisions.ts --dry-run --site <siteId-or-domain>
 *   npx tsx scripts/draft-rank-decisions.ts --apply --site <siteId-or-domain>
 *   npx tsx scripts/draft-rank-decisions.ts --apply --all
 *
 * Why this exists given the weekly refresh drafts the same decisions: the weekly
 * pass covers rows as they refresh; this runs the one implementation once over
 * the rows that already sit on the boards. Rollout is inheritance — the weekly
 * hook is the mechanism, this script is running it once for the fleet.
 *
 * It buys nothing: the model call is the content writer, and every fact it is
 * given is already stored (rank rows, the latest crawl, sampled competitors).
 * A row that already carries a decision is never re-drafted, so a second run
 * over the same board only reconsiders the rows that were declined. That is
 * deliberate: a decline is a judgement on current facts — a page restored, a
 * window with more impressions — and refreshed evidence should refresh the
 * judgement.
 *
 * The dry run is the review lane: it prints every drafted decision, decline and
 * rejection without writing, exactly as rescore-nightly's dry run does.
 */

import { PrismaClient } from "@prisma/client";
import { loadEnvConfig } from "@next/env";

if (!process.env.DATABASE_URL) loadEnvConfig(process.cwd());

import { draftRankDecisions } from "@/lib/research/rank-decision-drafting";

type Args = { apply: boolean; all: boolean; site: string | null };

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const siteIndex = argv.indexOf("--site");
  return {
    apply: flags.has("--apply"),
    all: flags.has("--all"),
    site: siteIndex >= 0 ? (argv[siteIndex + 1] ?? null) : null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.all && !args.site) {
    console.error("usage: --site <siteId-or-domain> | --all, plus --apply to write (default is a dry run)");
    process.exit(2);
  }
  const db = new PrismaClient();
  const mode = args.apply ? ("execute" as const) : ("dry-run" as const);
  let sites = await db.site.findMany({
    where: { retiredAt: null, projectId: { not: null } },
    select: { id: true, domain: true },
    orderBy: { domain: "asc" },
  });
  if (args.site) {
    const wanted = args.site;
    sites = sites.filter((site) => site.id === wanted || site.domain === wanted);
    if (sites.length === 0) {
      console.error(`site ${wanted} was not found, is retired, or has no project`);
      await db.$disconnect();
      process.exit(2);
    }
  }

  let storedTotal = 0;
  let draftedTotal = 0;
  for (const site of sites) {
    const result = await draftRankDecisions(db, {
      siteId: site.id,
      mode,
      onNote: (message) => console.log(`    ${message}`),
    });
    console.log(`${site.domain}: ${result.detail}`);
    for (const line of result.truncations) console.log(`  truncation: ${line}`);
    for (const error of result.errors) console.log(`  error: ${error}`);
    for (const drafted of result.decisions) {
      console.log(`  [${drafted.readiness}] ${drafted.title}`);
      console.log(`    action: ${drafted.action}`);
    }
    for (const row of result.declined) console.log(`  declined ${row.dedupKey.slice(0, 70)}: ${row.reason}`);
    for (const row of result.rejected) console.log(`  rejected ${row.dedupKey.slice(0, 70)}: ${row.reason}`);
    for (const row of result.skipped) console.log(`  skipped ${row.dedupKey.slice(0, 70)}: ${row.reason}`);
    storedTotal += result.stored;
    draftedTotal += result.drafted;
  }
  console.log(
    mode === "dry-run"
      ? `dry run: ${draftedTotal} decisions drafted, nothing stored (pass --apply to write)`
      : `stored ${storedTotal} of ${draftedTotal} drafted decisions`
  );
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
