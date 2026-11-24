/**
 * CMP-008: measure and store share of voice per cluster, per week, per domain.
 *
 *   npx tsx scripts/share-of-voice.ts --site <siteId> --dry-run
 *   npx tsx scripts/share-of-voice.ts --site <siteId> --apply
 *
 * It buys nothing. Every number comes from `serp_snapshot` and `competitor_rank` rows
 * that were already paid for, so this pass is free to run as often as the scoreboard
 * needs to be current.
 *
 * What it refuses to do:
 *  - **write a row for an unobserved week.** An absence is not a zero.
 *  - **invent a competitor's share.** Only domains a snapshot attributed receive credit.
 *  - **hide a thin sample.** Each row carries how many queries it rests on.
 */

import { PrismaClient } from "@prisma/client";
import { loadEnvConfig } from "@next/env";

if (!process.env.DATABASE_URL) loadEnvConfig(process.cwd());

import {
  clusterStatus,
  observedWeeks,
  shareOfVoice,
  storeShareOfVoice,
  type ClusterShareOfVoice,
} from "@/lib/funnel/share-of-voice";

type Args = { siteId: string; apply: boolean; cluster?: string };

function parseArgs(argv: string[]): Args {
  const args: Args = { siteId: "", apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--site") args.siteId = argv[++index] ?? "";
    else if (flag === "--cluster") args.cluster = argv[++index];
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--dry-run") args.apply = false;
  }
  return args;
}

const pct = (value: number | null) => (value == null ? "unknown" : `${(value * 100).toFixed(1)}%`);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.siteId) throw new Error("--site is required");

  const db = new PrismaClient();
  try {
    const site = await db.site.findUnique({
      where: { id: args.siteId },
      select: { id: true, domain: true, projectId: true },
    });
    if (!site || !site.projectId) throw new Error(`no site with a project for ${args.siteId}`);

    const clusters = await db.demandMapCluster.findMany({
      where: {
        projectId: site.projectId,
        supersededAt: null,
        ...(args.cluster ? { slug: args.cluster } : {}),
      },
      select: { slug: true },
      orderBy: { slug: "asc" },
    });

    process.stdout.write(`site: ${site.domain}\n`);
    process.stdout.write(`clusters: ${clusters.length}\n\n`);

    let totalRows = 0;
    let unobserved = 0;

    for (const cluster of clusters) {
      const weeks = await observedWeeks(db, { projectId: site.projectId, clusterSlug: cluster.slug });
      if (weeks.length === 0) {
        unobserved += 1;
        process.stdout.write(`${cluster.slug.padEnd(32)} unobserved — no sample\n`);
        continue;
      }

      const samples: ClusterShareOfVoice[] = [];
      let rowsForCluster = 0;
      for (const week of weeks) {
        const sample = await shareOfVoice(db, {
          projectId: site.projectId,
          clusterSlug: cluster.slug,
          week,
          domain: site.domain,
        });
        samples.push(sample);
        if (args.apply) {
          const stored = await storeShareOfVoice(db, { projectId: site.projectId, siteId: site.id, sample });
          rowsForCluster += stored.written;
        }
        totalRows += sample.domains.length;
      }

      const standing = clusterStatus({ samples });
      const latest = samples[samples.length - 1];
      process.stdout.write(
        `${cluster.slug.padEnd(32)} ${String(weeks.length).padStart(2)} week(s) · ${standing.status.padEnd(11)} ` +
          `our share ${pct(latest.ourShare)} · leader ${latest.domains[0]?.domain ?? "—"} ` +
          `(${latest.queriesObserved} queries)\n`
      );
      if (standing.status !== "unobserved") process.stdout.write(`  ${standing.reason}\n`);
      if (args.apply) process.stdout.write(`  rows written: ${rowsForCluster}\n`);
    }

    process.stdout.write(`\nclusters with a sample: ${clusters.length - unobserved}\n`);
    process.stdout.write(`clusters unobserved: ${unobserved}\n`);
    if (!args.apply) {
      process.stdout.write(`share_of_voice rows that would be written: ${totalRows}\n`);
      process.stdout.write("dry run: wrote nothing\n");
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
