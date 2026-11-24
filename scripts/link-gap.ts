/**
 * CMP-007: measure the link-target gap and write it where O9 reads it.
 *
 *   npx tsx scripts/link-gap.ts --site <siteId> --dry-run
 *   npx tsx scripts/link-gap.ts --site <siteId> --apply --cap 4
 *
 * What it buys, per period, with the existing DataForSEO budget path:
 *  - our own referring domains (the subtrahend — a summary *count* cannot be
 *    subtracted from a set),
 *  - one referring-domains call per competitor, capped per run.
 *
 * Everything it writes carries its raw response and its cost. Run twice in a period
 * and it buys nothing the second time: the set is identified by (`scope`, `domain`)
 * and the newest one inside the period is reused.
 *
 * The output is a list of link targets with their provider rank. It is not an
 * outreach system.
 */

import { PrismaClient } from "@prisma/client";
import { loadEnvConfig } from "@next/env";

if (!process.env.DATABASE_URL) loadEnvConfig(process.cwd());

import { runLinkGapPass, storeOwnDomainGap, DEFAULT_COMPETITOR_CALL_CAP } from "@/lib/funnel/link-gap-pass";
import { backlinkGap, normalizeDomain, type ReferringDomain } from "@/lib/funnel/backlink-gap";

type Args = { siteId: string; apply: boolean; cap: number; limit?: number; competitors: string[] };

function parseArgs(argv: string[]): Args {
  const args: Args = { siteId: "", apply: false, cap: DEFAULT_COMPETITOR_CALL_CAP, competitors: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--site") args.siteId = argv[++index] ?? "";
    else if (flag === "--cap") args.cap = Number(argv[++index]);
    else if (flag === "--limit") args.limit = Number(argv[++index]);
    else if (flag === "--competitor") args.competitors.push(argv[++index] ?? "");
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--dry-run") args.apply = false;
  }
  return args;
}

/**
 * The competitor set to measure.
 *
 * The declared list is used first — a person named those domains. When there is
 * none, the domains a sampled SERP actually ranked above us (CMP-003) are the
 * measured answer, ordered by how many of our queries they hold. Never a
 * domain-shaped guess.
 */
async function chooseCompetitors(
  db: PrismaClient,
  input: { projectId: string; siteId: string; explicit: string[]; limit: number }
): Promise<{ domains: string[]; source: "declared" | "ranked" | "none" }> {
  if (input.explicit.length > 0) {
    return { domains: input.explicit.map(normalizeDomain).filter(Boolean).slice(0, input.limit), source: "declared" };
  }
  const profile = await db.siteProfile.findUnique({ where: { siteId: input.siteId }, select: { competitors: true } });
  const declared = Array.isArray(profile?.competitors)
    ? (profile.competitors as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  if (declared.length > 0) {
    return { domains: declared.map(normalizeDomain).filter(Boolean).slice(0, input.limit), source: "declared" };
  }

  const rows = await db.evidenceRecord.findMany({
    where: { projectId: input.projectId, kind: "competitor_rank", supersededById: null },
    select: { dimensions: true },
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    const dims = (row.dimensions ?? {}) as { domain?: string };
    if (typeof dims.domain !== "string") continue;
    const domain = normalizeDomain(dims.domain);
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const ordered = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([domain]) => domain);
  return { domains: ordered.slice(0, input.limit), source: ordered.length > 0 ? "ranked" : "none" };
}

function periodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

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

    const now = new Date();
    const chosen = await chooseCompetitors(db, {
      projectId: site.projectId,
      siteId: site.id,
      explicit: args.competitors,
      limit: args.cap,
    });

    process.stdout.write(`site: ${site.domain}\n`);
    process.stdout.write(`period: ${periodStart(now).toISOString().slice(0, 7)}\n`);
    process.stdout.write(`competitors (${chosen.source}): ${chosen.domains.length}\n`);
    for (const domain of chosen.domains) process.stdout.write(`  ${domain}\n`);
    if (chosen.domains.length === 0) {
      process.stdout.write(
        "no competitor is named by a declared list or a sampled SERP, so there is nothing to compare\n"
      );
      return;
    }

    const result = await runLinkGapPass(db, {
      projectId: site.projectId,
      siteId: site.id,
      domain: site.domain,
      competitors: chosen.domains,
      periodStart: periodStart(now),
      apply: args.apply,
      cap: args.cap,
      limit: args.limit,
      now,
    });

    process.stdout.write(`\nsummary: ${result.summary}\n`);
    process.stdout.write(`calls: ${result.calls.length} (${result.calls.map((row) => `${row.role}:${row.target}`).join(", ") || "none"})\n`);
    process.stdout.write(`reused this period: ${result.reused.length}\n`);
    process.stdout.write(`skipped (cap): ${result.skipped.length}${result.skipped.length > 0 ? ` — ${result.skipped.join(", ")}` : ""}\n`);
    if (result.notAttempted.length > 0) {
      process.stdout.write(`not attempted (dry run): ${result.notAttempted.length} — ${result.notAttempted.join(", ")}\n`);
    }
    process.stdout.write(`missing (no data): ${result.missing.length}${result.missing.length > 0 ? ` — ${result.missing.join(", ")}` : ""}\n`);
    process.stdout.write(`spent: ${result.spentMicros} micros\n`);
    process.stdout.write(
      `our referring domains: ${result.gap.ourDomainCount ?? "not measured"}\n` +
        `competitors measured: ${result.gap.competitorDomainCount}\n` +
        `shared domains: ${result.gap.shared.length}\n` +
        `link targets (gap): ${result.gap.gap}\n`
    );
    for (const target of result.gap.targets.slice(0, 15)) {
      process.stdout.write(
        `  ${target.domain.padEnd(34)} rank=${String(target.rank ?? "—").padStart(4)} linksTo=${target.competitorsLinking} competitor(s)\n`
      );
    }
    if (result.gap.targets.length > 15) {
      process.stdout.write(`  … ${result.gap.targets.length - 15} more\n`);
    }

    if (!args.apply) {
      process.stdout.write("\ndry run: bought nothing, wrote no gap row\n");
      return;
    }
    if (result.rawResponseId == null) {
      process.stdout.write(
        "\nnot written: our own referring set has no paid receipt this period, so the gap has no provenance\n"
      );
      return;
    }

    const stored = await storeOwnDomainGap(db, {
      projectId: site.projectId,
      siteId: site.id,
      domain: site.domain,
      gap: result.gap,
      rawResponseId: result.rawResponseId,
      // The competitor profiles the subtraction read, so O9 names both sides.
      competitorEvidenceIds: result.evidenceIds.filter((id) => id !== result.evidenceIds[0]),
    });
    process.stdout.write(`\nwrote the gap on the own-domain profile: ${stored}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
