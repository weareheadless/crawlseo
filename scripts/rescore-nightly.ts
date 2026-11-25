/**
 * Re-score every live board from its stored inputs. The nightly backstop.
 *
 *   npx tsx scripts/rescore-nightly.ts --dry-run
 *   npx tsx scripts/rescore-nightly.ts --apply
 *   npx tsx scripts/rescore-nightly.ts --apply --site <siteId>
 *
 * Why this exists, given the pipeline already re-scores after drafting: not every
 * change to a row's evidence comes from the pipeline. A GSC sync, a crawl, a manual
 * repair and a backfill all change inputs without drafting anything, and those rows
 * would otherwise keep the score they had when first written. The pipeline covers "the
 * evidence changed because we ran"; this covers "the evidence changed".
 *
 * It buys nothing, calls no provider and reads no crawl. Every input is already on the
 * row; this applies `computeScore` again. Idempotent: a second run in a row reports
 * every row unchanged, which is what makes "did anything change?" answerable.
 *
 * It does not touch accepted, in-progress or delivered rows unless `--include-human-owned`
 * is passed. A person chose that work at its current priority.
 */

import { PrismaClient } from "@prisma/client";
import { loadEnvConfig } from "@next/env";

if (!process.env.DATABASE_URL) loadEnvConfig(process.cwd());

import { rescoreAllProjects, rescoreProjectOpportunities } from "@/lib/funnel/rescore";

type Args = {
  apply: boolean;
  includeHumanOwned: boolean;
  siteId: string | null;
};

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const siteIndex = argv.indexOf("--site");
  return {
    apply: flags.has("--apply"),
    includeHumanOwned: flags.has("--include-human-owned"),
    siteId: siteIndex >= 0 ? (argv[siteIndex + 1] ?? null) : null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();
  const dryRun = !args.apply;

  if (args.siteId) {
    const site = await db.site.findUnique({ where: { id: args.siteId }, select: { domain: true, projectId: true } });
    if (!site?.projectId) {
      console.error(`site ${args.siteId} is missing or has no project`);
      process.exit(2);
    }
    const result = await rescoreProjectOpportunities(db, {
      projectId: site.projectId,
      includeHumanOwned: args.includeHumanOwned,
      dryRun,
    });
    report(site.domain, result, dryRun);
  } else {
    const sites = await db.site.findMany({
      where: { retiredAt: null, projectId: { not: null } },
      select: { domain: true, projectId: true },
    });
    const domainByProject = new Map<string, string>();
    for (const site of sites) if (site.projectId) domainByProject.set(site.projectId, site.domain);

    const byProject = await rescoreAllProjects(db, { includeHumanOwned: args.includeHumanOwned, dryRun });
    let changed = 0;
    let unchanged = 0;
    let humanOwned = 0;
    let unscorable = 0;
    for (const [projectId, result] of byProject) {
      changed += result.changed;
      unchanged += result.unchanged;
      humanOwned += result.humanOwned;
      unscorable += result.unscorable;
      report(domainByProject.get(projectId) ?? projectId, result, dryRun);
    }
    console.log(
      `\n${dryRun ? "would re-score" : "re-scored"}: ${changed} changed, ${unchanged} unchanged, ${humanOwned} human-owned skipped, ${unscorable} unscorable`
    );
    if (dryRun) console.log("re-run with --apply to write");
  }

  await db.$disconnect();
}

function report(
  label: string,
  result: { changed: number; unchanged: number; humanOwned: number; unscorable: number; movements: { title: string; from: number | null; to: number; delta: number }[] },
  dryRun: boolean
): void {
  console.log(
    `${label.padEnd(28)} ${dryRun ? "would change" : "changed"}=${String(result.changed).padStart(3)} unchanged=${String(result.unchanged).padStart(4)} human-owned=${String(result.humanOwned).padStart(3)} unscorable=${result.unscorable}`
  );
  for (const movement of result.movements.slice(0, 3)) {
    const delta = `${movement.delta > 0 ? "+" : ""}${movement.delta}`;
    console.log(`    ${String(movement.from ?? "-").padStart(3)} -> ${String(movement.to).padStart(3)} (${delta.padStart(4)})  ${movement.title.slice(0, 56)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
