/**
 * Execute join follow-ups for one site (plan §2.3).
 *
 * `computeFollowUps` names the one-legged opportunities and the collection that
 * would join them. This runs that collection and attaches the evidence.
 *
 * The why leg costs nothing (business knowledge is already stored). The how leg
 * is a paid provider call, so it only runs when an explicit spend ceiling is
 * given; with `--max-spend-micros 0` the runner does the free joins and reports
 * what it would have collected.
 *
 *   npx tsx scripts/run-join-followups.ts --site <siteId> [--max-spend-micros 0] [--dry-run]
 */

import { PrismaClient } from "@prisma/client";

import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";
import { resolveSiteContext } from "@/lib/site/context";
import {
  collectAiVisibility,
  collectDerivedKeywordMetrics,
  collectKeywordMetrics,
  collectSerpSnapshots,
} from "@/lib/dataforseo/collection";
import { runJoinFollowUps } from "@/lib/funnel/join-runner";

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
    maxSpendMicros: Math.max(0, Number(values.get("max-spend-micros") ?? 0)),
    language: values.get("language") ?? null,
    country: values.get("country") ?? null,
    dryRun,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();
  const site = await db.site.findUniqueOrThrow({
    where: { id: args.siteId },
    select: { id: true, domain: true, projectId: true },
  });
  if (!site.projectId) throw new Error("site is not attached to a project");
  // Explicit flags win; otherwise the site's own context answers, so this script
  // is not a French script that happens to work on other sites.
  const context = await resolveSiteContext(db as never, site.id);
  const locale = await resolveDataForSeoLocale(
    site.projectId,
    args.language ?? context.language,
    args.country ?? context.country
  );

  if (args.dryRun) {
    const { computeFollowUps } = await import("@/lib/funnel/join");
    const requests = await computeFollowUps(db as never, site.projectId);
    process.stdout.write(`${JSON.stringify({ requests: requests.length, requestsDetail: requests.slice(0, 20) }, null, 1)}\n`);
    await db.$disconnect();
    return;
  }

  const result = await runJoinFollowUps(db as never, {
    projectId: site.projectId,
    siteId: site.id,
    maxSpendMicros: args.maxSpendMicros,
    collectors: {
      // A gap finding names a phrase Labs may not know ("retapisser un siège
      // soi-même"). Ask for the keywords people actually search around it, and
      // only fall back to the exact phrase when derivation finds nothing.
      keywordMetrics: async (input) => {
        const seed = input.queries[0];
        if (!seed) return { evidence: [], spentMicros: 0 };
        const derived = await collectDerivedKeywordMetrics(db as never, {
          projectId: input.projectId,
          siteId: input.siteId,
          seed,
          languageCode: locale.languageCode,
          locationCode: locale.locationCode,
        });
        if (derived.evidence.length > 0) return derived;
        const exact = await collectKeywordMetrics(db as never, {
          ...input,
          languageCode: locale.languageCode,
          locationCode: locale.locationCode,
        });
        return { evidence: exact.evidence, spentMicros: derived.spentMicros + exact.spentMicros };
      },
      serpSnapshots: (input) =>
        collectSerpSnapshots(db as never, {
          ...input,
          languageCode: locale.languageCode,
          locationCode: locale.locationCode,
          domain: site.domain,
        }),
      aiVisibility: (input) =>
        collectAiVisibility(db as never, {
          ...input,
          languageCode: locale.languageCode,
          locationCode: locale.locationCode,
          domain: site.domain,
        }),
    },
  });

  process.stdout.write(
    JSON.stringify(
      {
        requests: result.requests,
        joined: result.joined,
        skipped: result.skipped,
        spentUsd: result.spentMicros / 1_000_000,
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
