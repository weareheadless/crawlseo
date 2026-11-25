/**
 * Record where each row's business-value judgement came from, and re-score it.
 *
 *   npx tsx scripts/business-value-source-backfill.ts --all --dry-run
 *   npx tsx scripts/business-value-source-backfill.ts --all --apply
 *
 * Why this exists: `computeScore` damps a row without a `businessValueSource` to
 * 0.25, and `proposalScoreInputs` never set one. Measured 2026-11-25: 1,654 of
 * 1,965 rows carried no source, and **every one of the 102 open rows** was in that
 * set — so nearly the whole board was multiplied by a penalty meant for rows with
 * no business judgement behind them. The apnea article on inmersionfreediving
 * scored 7 instead of 22.
 *
 * What it writes, and why each value is defensible from stored data only:
 *
 *  - `cluster` — the row is attached to a topic the model rated `high`/`medium`/
 *    `low` from the site's own knowledge facts and pages. The rating is a judgement
 *    about *this* business, so it earns full relevance.
 *  - `knowledge` — the row already said so. Left alone.
 *  - `unknown` — no cluster, or a cluster with no rating. Damped as before, but now
 *    as its own recorded state rather than as the default for everything.
 *
 * It buys nothing and computes nothing new: the rating is already stored on the
 * cluster, and the value already sits in `scoreInputs.worth.businessValue`.
 *
 * It does not touch accepted, in-progress or delivered work unless
 * `--include-accepted` is passed: a person accepted that row at its current
 * priority, and moving it silently would be a change under their feet.
 */

import { PrismaClient } from "@prisma/client";
import { loadEnvConfig } from "@next/env";

if (!process.env.DATABASE_URL) loadEnvConfig(process.cwd());

import { computeScore } from "@/lib/funnel/scoring";

type Args = {
  all: boolean;
  apply: boolean;
  includeAccepted: boolean;
  siteId: string | null;
};

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const siteIndex = argv.indexOf("--site");
  return {
    all: flags.has("--all"),
    apply: flags.has("--apply"),
    includeAccepted: flags.has("--include-accepted"),
    siteId: siteIndex >= 0 ? (argv[siteIndex + 1] ?? null) : null,
  };
}

const STATUSES_DEFAULT = ["detected", "parked"] as const;
const STATUSES_WITH_ACCEPTED = ["detected", "parked", "accepted", "in_progress", "delivered"] as const;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.all && !args.siteId) {
    console.error("pass --all or --site <siteId>");
    process.exit(2);
  }
  const db = new PrismaClient();

  const sites = args.siteId
    ? await db.site.findMany({ where: { id: args.siteId }, select: { id: true, domain: true, projectId: true } })
    : await db.site.findMany({ where: { retiredAt: null, projectId: { not: null } }, select: { id: true, domain: true, projectId: true } });

  const statuses = args.includeAccepted ? [...STATUSES_WITH_ACCEPTED] : [...STATUSES_DEFAULT];
  let totalScanned = 0;
  let totalChanged = 0;
  let totalUnchanged = 0;

  for (const site of sites) {
    const rows = await db.opportunity.findMany({
      where: {
        projectId: site.projectId!,
        status: { in: statuses as never },
      },
      select: { id: true, title: true, scoreValue: true, scoreInputs: true, clusterId: true },
    });
    const clusterIds = [...new Set(rows.map((row) => row.clusterId).filter((id): id is string => id != null))];
    const clusters = clusterIds.length
      ? await db.demandMapCluster.findMany({
          where: { id: { in: clusterIds } },
          select: { id: true, businessRelevance: true },
        })
      : [];
    // The model's rating is stored inside the cluster's `businessRelevance` JSON, as a
    // top-level `relevance` key. Measured 2026-11-25 across 113 live clusters:
    // high=85, medium=23, low=5.
    const relevanceById = new Map(
      clusters.map((cluster) => {
        const blob = cluster.businessRelevance as { relevance?: unknown } | null;
        const rating = typeof blob?.relevance === "string" ? blob.relevance : null;
        return [cluster.id, rating] as const;
      })
    );

    let changed = 0;
    let unchanged = 0;
    for (const row of rows) {
      totalScanned += 1;
      const inputs = row.scoreInputs as { worth?: Record<string, unknown> } | null;
      const worth = inputs?.worth;
      // A row with no scoreInputs is not repaired here: it needs a producer run, not
      // a guessed source.
      if (!inputs || !worth) { unchanged += 1; continue; }
      if (worth.businessValueSource != null) { unchanged += 1; continue; }

      const relevance = row.clusterId ? relevanceById.get(row.clusterId) : undefined;
      const source = relevance === "high" || relevance === "medium" || relevance === "low" ? "cluster" : "unknown";
      const nextInputs = { ...inputs, worth: { ...worth, businessValueSource: source } };
      const nextScore = computeScore(nextInputs as never).scoreValue;

      changed += 1;
      if (args.apply) {
        await db.opportunity.update({
          where: { id: row.id },
          data: {
            scoreInputs: nextInputs as never,
            scoreValue: nextScore,
            lastScoredAt: new Date(),
          },
        });
      }
    }
    totalChanged += changed;
    totalUnchanged += unchanged;
    console.log(`${site.domain.padEnd(28)} scanned=${String(rows.length).padStart(4)} sourced=${String(changed).padStart(4)} already-set=${String(unchanged).padStart(4)}${args.apply ? "" : "  (dry run)"}`);
  }

  console.log(`\n${args.apply ? "applied" : "would apply"}: ${totalChanged} of ${totalScanned} rows; ${totalUnchanged} left alone`);
  if (!args.apply) console.log("re-run with --apply to write");
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
