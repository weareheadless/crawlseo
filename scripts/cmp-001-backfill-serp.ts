/**
 * CMP-001 backfill: re-sample the queries that already hold a `serp_snapshot`.
 *
 * Existing rows are evidence with provenance and are never rewritten. Their
 * payloads predate attribution, so most carry a `google.com/goto` wrapper as
 * `topUrl` and a `competitorCovered` that was never true. This buys a fresh
 * sample for exactly those queries, which the collector now stores correctly, and
 * leaves the old rows in place as history.
 *
 * It deliberately does NOT go through the monthly bundle: three of the five sites
 * already hold more snapshots than the bundle's hard cap of 10 SERPs per site per
 * month (`DEFAULT_BUNDLE_CAPS.serpQueries`). A one-off repair is not a monthly
 * cadence, so it reserves and settles against the project allowance directly and
 * prints its own receipt.
 *
 *   npx tsx scripts/cmp-001-backfill-serp.ts --site <siteId> [--limit 10] [--dry-run]
 *   npx tsx scripts/cmp-001-backfill-serp.ts --all [--limit 10] [--dry-run]
 */

import { loadEnvConfig } from "@next/env";

import { PrismaClient } from "@prisma/client";

// tsx does not load `.env.local` the way Next.js does, and the DataForSEO
// credential is encrypted with a key that lives there.
loadEnvConfig(process.cwd());

import { collectSerpSnapshots } from "@/lib/dataforseo/collection";
import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    if (arg === "--all" || arg === "--dry-run") {
      flags.add(arg);
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values.set(arg.slice(2), value);
    i += 1;
  }
  return {
    siteId: values.get("site") ?? null,
    all: flags.has("--all"),
    dryRun: flags.has("--dry-run"),
    limit: Math.max(1, Math.min(Number(values.get("limit") ?? 10), 50)),
  };
}

type Target = { siteId: string; projectId: string; domain: string; locales: string[]; queries: string[] };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.siteId && !args.all) throw new Error("--site <siteId> or --all is required");
  const db = new PrismaClient();

  const sites = await db.site.findMany({
    where: args.siteId ? { id: args.siteId } : { projectId: { not: null } },
    select: { id: true, projectId: true, domain: true },
    orderBy: { domain: "asc" },
  });

  const targets: Target[] = [];
  for (const site of sites) {
    if (!site.projectId) continue;
    // Exactly the queries that hold a snapshot today, with the locale each was
    // sampled in, so the refresh answers the same question the old row did.
    const rows = await db.evidenceRecord.findMany({
      where: { siteId: site.id, kind: "serp_snapshot" },
      select: { dimensions: true },
      distinct: ["dimensions"],
    });
    const queries = [...new Set(
      rows.map((row) => (row.dimensions as { query?: unknown })?.query)
        .filter((query): query is string => typeof query === "string" && query.trim() !== "")
    )].sort();
    const locales = [...new Set(
      rows.map((row) => (row.dimensions as { locale?: unknown })?.locale)
        .filter((locale): locale is string => typeof locale === "string" && locale.includes(":"))
    )];
    if (queries.length === 0) continue;
    targets.push({
      siteId: site.id,
      projectId: site.projectId,
      domain: site.domain,
      locales: locales.length > 0 ? locales : [`fr:2250`],
      queries: queries.slice(0, args.limit),
    });
  }

  if (targets.length === 0) {
    process.stdout.write("nothing to backfill: no site holds a serp_snapshot\n");
    await db.$disconnect();
    return;
  }

  let totalSpent = 0;
  const report: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    const [languageCode = "fr", locationCode = "2250"] = (target.locales[0] ?? "fr:2250").split(":");
    if (args.dryRun) {
      report.push({
        domain: target.domain,
        queries: target.queries.length,
        locale: `${languageCode}:${locationCode}`,
        dryRun: true,
      });
      continue;
    }
    try {
      const locale = await resolveDataForSeoLocale(target.projectId, languageCode === "fr" ? "fr" : "en", "FR").catch(() => null);
      const out = await collectSerpSnapshots(db as never, {
        projectId: target.projectId,
        siteId: target.siteId,
        queries: target.queries,
        languageCode: locale?.languageCode ?? languageCode,
        locationCode: locale?.locationCode ?? Number(locationCode),
        domain: target.domain,
      });
      totalSpent += out.spentMicros;
      report.push({
        domain: target.domain,
        sampled: out.evidence.length,
        queries: target.queries.length,
        costUsd: Number((out.spentMicros / 1_000_000).toFixed(4)),
        covered: out.evidence.filter((row) => (row.dimensions as { competitorCovered?: unknown }).competitorCovered === "true").length,
        unobserved: out.evidence.filter((row) => (row.dimensions as { competitorCovered?: unknown }).competitorCovered == null).length,
      });
    } catch (error) {
      // One site failing must not hide the others' receipts.
      report.push({ domain: target.domain, error: String((error as Error).message).slice(0, 200) });
    }
  }

  process.stdout.write(`${JSON.stringify({ spentUsd: Number((totalSpent / 1_000_000).toFixed(4)), sites: report }, null, 2)}\n`);
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`${String((error as Error).message).slice(0, 400)}\n`);
  process.exitCode = 1;
});
