/**
 * Wave 0.5 collection for one site: the evidence §2.2 promises the detectors.
 *
 * Today this collects the two kinds that unlock O1/O3 and give O2 real volume:
 *   - `keyword_metrics` from DataForSEO Labs keyword_overview (volume, difficulty,
 *     cpc, competition) — the provider volume the board has never had;
 *   - `serp_snapshot` from the SERP API for the site's top queries, including
 *     whether a competitor covers the query we do not rank for.
 *
 * Every paid call stores a RawProviderResponse first; provider-sourced metrics are
 * refused without it (lib/funnel/evidence.ts). Costs are reported per kind.
 *
 *   npx tsx scripts/ds-wave05-collect.ts --site <siteId> [--queries 20] [--dry-run]
 */

import { PrismaClient } from "@prisma/client";

import { performDataForSeoOperation, executeDataForSeoKeywordOverview, executeDataForSeoOrganicSerp } from "@/lib/dataforseo/client";
import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";
import { storeEvidenceRecord } from "@/lib/funnel/evidence";
import { projectConnectorBudget } from "@/lib/connectors/service";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";

type Args = { siteId: string; queries: number; dryRun: boolean; language: string; country: string };

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "dry-run") { flags.add(name); continue; }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values.set(name, value);
    i += 1;
  }
  const siteId = values.get("site");
  if (!siteId) throw new Error("--site <siteId> is required");
  return {
    siteId,
    queries: Math.max(1, Math.min(Number(values.get("queries") ?? 20), 100)),
    dryRun: flags.has("dry-run"),
    language: values.get("language") ?? "fr",
    country: values.get("country") ?? "FR",
  };
}

const micros = (usd: number) => BigInt(Math.round(usd * 1_000_000));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();

  const site = await db.site.findUniqueOrThrow({
    where: { id: args.siteId },
    select: { id: true, domain: true, projectId: true },
  });
  if (!site.projectId) throw new Error("site is not attached to a project");

  const principal = { projectId: site.projectId } as ServicePrincipalContext;
  const budget = await projectConnectorBudget(principal);
  if (!budget.configured || !budget.allowanceMicros || budget.currency !== "USD") {
    throw new Error("paid collection requires an owner-configured USD allowance (DS-08)");
  }

  // Locale is passed explicitly: neither Site nor Project stores a market today.
  // atelier-harmonie is fr/FR; the defaults match it.
  const locale = await resolveDataForSeoLocale(site.projectId, args.language, args.country);

  // Queries worth paying for: the ones that already earn impressions, by demand.
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

  process.stdout.write(
    `${site.domain}: ${queries.length} queries, locale ${locale.languageCode}/${locale.locationCode}, budget ${budget.allowanceMicros} micros${args.dryRun ? " (dry run)" : ""}\n`
  );
  if (args.dryRun) {
    for (const query of queries) process.stdout.write(`  ${query}\n`);
    await db.$disconnect();
    return;
  }

  let volumeCostMicros = BigInt(0);
  let serpCostMicros = BigInt(0);
  let volumeRows = 0;
  let serpRows = 0;

  // 1. Volumes: one Labs call covers many keywords.
  const overview = await executeDataForSeoKeywordOverview({
    projectId: site.projectId,
    keywords: queries,
    languageCode: locale.languageCode,
    locationCode: locale.locationCode,
  });
  if (overview.costMicros != null) volumeCostMicros += BigInt(overview.costMicros);
  const rawVolumes = await db.rawProviderResponse.create({
    data: {
      provider: "dataforseo",
      product: "dataforseo_labs",
      endpoint: "keyword_overview/live",
      providerTaskId: overview.providerTaskId,
      locale: `${locale.languageCode}:${locale.locationCode}`,
      requestedAt: new Date(),
      deliveredAt: new Date(),
      costMicros: BigInt(overview.costMicros ?? 0),
      status: "succeeded",
      payload: overview.result as never,
    },
    select: { id: true },
  });
  for (const metric of overview.result) {
    if (!metric.keyword) continue;
    const metrics: Record<string, { value: number | null; unit: string; source: "provider" }> = {};
    if (typeof metric.volume === "number") metrics["provider:volume"] = { value: metric.volume, unit: "searches/month", source: "provider" };
    if (typeof metric.difficulty === "number") metrics["provider:difficulty"] = { value: metric.difficulty, unit: "score", source: "provider" };
    if (typeof metric.cpc === "number") metrics["provider:cpc"] = { value: metric.cpc, unit: "currency", source: "provider" };
    if (typeof metric.competition === "number") metrics["provider:competition"] = { value: metric.competition, unit: "score", source: "provider" };
    if (Object.keys(metrics).length === 0) continue;
    await storeEvidenceRecord(db as never, {
      projectId: site.projectId,
      siteId: site.id,
      kind: "keyword_metrics",
      observedAt: new Date(),
      producer: "dataforseo",
      rawResponseId: rawVolumes.id,
      dimensions: { query: metric.keyword },
      metrics,
    });
    volumeRows += 1;
  }

  // 2. SERP composition for the same queries. `competitorCovered` is what O3 reads:
  //    someone answers this query and we are not in the top ten.
  for (const query of queries) {
    const serp = await executeDataForSeoOrganicSerp({
      projectId: site.projectId,
      keyword: query,
      languageCode: locale.languageCode,
      locationCode: locale.locationCode,
    });
    if (serp.costMicros != null) serpCostMicros += BigInt(serp.costMicros);
    const raw = await db.rawProviderResponse.create({
      data: {
        provider: "dataforseo",
        product: "serp",
        endpoint: "google/organic/live/advanced",
        providerTaskId: serp.providerTaskId,
        locale: `${locale.languageCode}:${locale.locationCode}`,
        requestedAt: new Date(),
        deliveredAt: new Date(),
        costMicros: BigInt(serp.costMicros ?? 0),
        status: "succeeded",
        payload: serp.result as never,
      },
      select: { id: true },
    });
    const items = serp.result.organic ?? [];
    const ourPosition = items.findIndex((item) => (item.url ?? "").includes(site.domain.replace(/^www\./, ""))) + 1;
    const covered = ourPosition === 0 || ourPosition > 10;
    const metrics: Record<string, { value: number; unit: string; source: "provider" }> = {
      "provider:organicResults": { value: items.length, unit: "count", source: "provider" },
    };
    if (ourPosition > 0) metrics["provider:position"] = { value: ourPosition, unit: "rank", source: "provider" };
    await storeEvidenceRecord(db as never, {
      projectId: site.projectId,
      siteId: site.id,
      kind: "serp_snapshot",
      observedAt: new Date(),
      producer: "dataforseo",
      rawResponseId: raw.id,
      dimensions: {
        query,
        competitorCovered: covered ? "true" : "false",
        topUrl: items[0]?.url ?? null,
      },
      metrics,
    });
    serpRows += 1;
  }

  // 3. Backlinks: ours only for now; the competitor intersection needs the SERP
  //    competitor set, which the next run can derive from these snapshots.
  const backlinks = await performDataForSeoOperation(site.projectId, {
    kind: "BACKLINKS_OVERVIEW",
    domain: site.domain.replace(/^www\./, ""),
  });
  const rawBacklinks = await db.rawProviderResponse.create({
    data: {
      provider: "dataforseo",
      product: "backlinks",
      endpoint: "summary/live",
      providerTaskId: backlinks.providerTaskId,
      locale: null,
      requestedAt: new Date(),
      deliveredAt: new Date(),
      costMicros: BigInt(backlinks.costMicros ?? 0),
      status: "succeeded",
      payload: backlinks.result as never,
    },
    select: { id: true },
  });
  const backlinkMetrics: Record<string, { value: number; unit: string; source: "provider" }> = {};
  const bl = backlinks.result as Record<string, unknown>;
  for (const [key, unit] of [["totalBacklinks", "count"], ["referringDomains", "count"], ["referringIps", "count"], ["dofollow", "count"], ["nofollow", "count"]] as const) {
    if (typeof bl[key] === "number") backlinkMetrics[`provider:${key}`] = { value: bl[key] as number, unit, source: "provider" };
  }
  if (Object.keys(backlinkMetrics).length > 0) {
    await storeEvidenceRecord(db as never, {
      projectId: site.projectId,
      siteId: site.id,
      kind: "backlink_profile",
      observedAt: new Date(),
      producer: "dataforseo",
      rawResponseId: rawBacklinks.id,
      dimensions: { scope: "own_domain", domain: site.domain.replace(/^www\./, "") },
      metrics: backlinkMetrics,
    });
  }

  const totalMicros = volumeCostMicros + serpCostMicros + BigInt(backlinks.costMicros ?? 0);
  process.stdout.write(
    JSON.stringify({
      queries: queries.length,
      keywordMetrics: volumeRows,
      serpSnapshots: serpRows,
      backlinks: Object.keys(backlinkMetrics).length,
      costUsd: Number(totalMicros) / 1_000_000,
    }, null, 1) + "\n"
  );
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`${String(error).slice(0, 500)}\n`);
  process.exitCode = 1;
});
