/**
 * Wave 0.5 collection for one site: the evidence §2.2 promises the detectors.
 *
 * Thin wrapper over `lib/dataforseo/collection.ts`, which the join runner uses
 * too. Every call reserves against the project's DS-08 allowance before it runs
 * and settles the actual cost after.
 *
 *   npx tsx scripts/ds-wave05-collect.ts --site <siteId> [--queries 20] [--dry-run]
 */

import { PrismaClient } from "@prisma/client";

import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";
import { collectBacklinkProfile, collectKeywordMetrics, collectSerpSnapshots } from "@/lib/dataforseo/collection";

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  const dryRun = argv.includes("--dry-run");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--dry-run") continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values.set(arg.slice(2), value);
    i += 1;
  }
  const siteId = values.get("site");
  if (!siteId) throw new Error("--site <siteId> is required");
  return {
    siteId,
    queries: Math.max(1, Math.min(Number(values.get("queries") ?? 20), 100)),
    language: values.get("language") ?? "fr",
    country: values.get("country") ?? "FR",
    dryRun,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();
  const site = await db.site.findUniqueOrThrow({ where: { id: args.siteId }, select: { id: true, domain: true, projectId: true } });
  if (!site.projectId) throw new Error("site is not attached to a project");
  const locale = await resolveDataForSeoLocale(site.projectId, args.language, args.country);

  const ranks = await db.evidenceRecord.findMany({
    where: { projectId: site.projectId, kind: "keyword_rank", supersededById: null },
    select: { dimensions: true, metrics: true },
  });
  const byQuery = new Map<string, number>();
  for (const row of ranks) {
    const query = (row.dimensions as { query?: string } | null)?.query;
    if (!query) continue;
    const impressions = Number((row.metrics as Record<string, { value?: number }> | null)?.["first_party:impressions"]?.value ?? 0);
    byQuery.set(query, (byQuery.get(query) ?? 0) + impressions);
  }
  const queries = [...byQuery.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.queries).map(([query]) => query);
  if (queries.length === 0) throw new Error("no Search Console queries to collect for");

  process.stdout.write(`${site.domain}: ${queries.length} queries, ${locale.languageCode}/${locale.locationCode}${args.dryRun ? " (dry run)" : ""}\n`);
  if (args.dryRun) {
    for (const query of queries) process.stdout.write(`  ${query}\n`);
    await db.$disconnect();
    return;
  }

  const volumes = await collectKeywordMetrics(db as never, {
    projectId: site.projectId,
    siteId: site.id,
    queries,
    languageCode: locale.languageCode,
    locationCode: locale.locationCode,
  });
  const serp = await collectSerpSnapshots(db as never, {
    projectId: site.projectId,
    siteId: site.id,
    queries,
    languageCode: locale.languageCode,
    locationCode: locale.locationCode,
    domain: site.domain,
  });
  const backlinks = await collectBacklinkProfile(db as never, {
    projectId: site.projectId,
    siteId: site.id,
    domain: site.domain,
  });

  process.stdout.write(
    JSON.stringify(
      {
        queries: queries.length,
        keywordMetrics: volumes.evidence.length,
        serpSnapshots: serp.evidence.length,
        backlinks: backlinks.evidence.length,
        costUsd: (volumes.spentMicros + serp.spentMicros + backlinks.spentMicros) / 1_000_000,
      },
      null,
      1
    ) + "\n"
  );
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`${String(error).slice(0, 500)}\n`);
  process.exitCode = 1;
});
