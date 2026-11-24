/**
 * CMP-012: re-resolve the winnability inputs on existing live rows, from stored facts.
 *
 *   npx tsx scripts/winnability-backfill.ts --all --dry-run
 *   npx tsx scripts/winnability-backfill.ts --all --apply
 *
 * Why this exists: the resolver runs inside the two producers (`runDetectors` and
 * `storeProposals`), so a row only gains measured inputs when its producer next runs. That
 * left 135 of 144 live rows still carrying the literal `0.5` — not because the fact is
 * missing, but because nothing had re-scored them since CMP-012 landed.
 *
 * It buys nothing. Every input is read from evidence already stored: the provider's
 * difficulty, CMP-007's referring sets, and the crawl's own page rows.
 *
 * It does not touch accepted or in-progress work by default: those rows carry a task and a
 * brief, and re-scoring them silently would move the priority under someone's feet. Pass
 * `--include-accepted` to include them.
 */

import { PrismaClient } from "@prisma/client";
import { loadEnvConfig } from "@next/env";

if (!process.env.DATABASE_URL) loadEnvConfig(process.cwd());

import { queryFromDedupKey } from "@/lib/funnel/cluster-resolver";
import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";
import { resolveWinProbability } from "@/lib/funnel/win-probability";

type Args = { siteId: string | null; all: boolean; apply: boolean; includeAccepted: boolean };

function parseArgs(argv: string[]): Args {
  return {
    siteId: argv.includes("--site") ? (argv[argv.indexOf("--site") + 1] ?? null) : null,
    all: argv.includes("--all"),
    apply: argv.includes("--apply"),
    includeAccepted: argv.includes("--include-accepted"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.siteId && !args.all) throw new Error("--site <siteId> or --all is required");

  const db = new PrismaClient();
  try {
    const sites = await db.site.findMany({
      where: args.siteId ? { id: args.siteId } : { projectId: { not: null }, retiredAt: null },
      select: { id: true, domain: true, projectId: true },
      orderBy: { domain: "asc" },
    });

    const statuses: Array<"detected" | "accepted" | "in_progress"> = args.includeAccepted
      ? ["detected", "accepted", "in_progress"]
      : ["detected"];

    let totalRows = 0;
    let gained = 0;

    for (const site of sites) {
      if (!site.projectId) continue;
      const rows = await db.opportunity.findMany({
        where: { projectId: site.projectId, status: { in: statuses } },
        select: {
          id: true,
          dedupKey: true,
          scoreValue: true,
          scoreInputs: true,
          evidenceCompleteness: true,
          recommendationDecision: true,
        },
      });
      if (rows.length === 0) continue;

      let measuredBefore = 0;
      let measuredAfter = 0;
      const moved: Array<{ title: string; from: number | null; to: number }> = [];

      for (const row of rows) {
        totalRows += 1;
        const previous = (row.scoreInputs ?? {}) as Partial<ScoreInputs> & {
          winProbabilitySource?: Record<string, string>;
          assessment?: unknown;
          assessmentVersion?: number;
        };
        const measurable = ["rankDistance", "authorityGap", "pageStrength", "serpCompetition"];
        const before = measurable.filter((key) => previous.winProbabilitySource?.[key] === "measured").length;
        if (before > 0) measuredBefore += 1;

        // The candidate's own score inputs, so volume, effort and the impact assessment are
        // untouched; only the winnability inputs are re-resolved.
        // The row's own stored inputs are the base. Rebuilding from the canonical decision
        // would start from nulls and discard the volume and impact assessment someone
        // already measured — this pass exists to add a measurement, not to remove one.
        const base = previous as Omit<ScoreInputs, "evidenceCompleteness">;
        if (!base?.winProbability) continue;

        const resolved = await resolveWinProbability(db, {
          projectId: site.projectId,
          siteId: site.id,
          query: queryFromDedupKey(row.dedupKey),
          rankDistance: base.winProbability.rankDistance ?? null,
          playTypeFactor: base.winProbability.playTypeFactor ?? 0.6,
        });

        const after = measurable.filter(
          (key) => resolved.winProbability[key as keyof typeof resolved.winProbability] != null
        ).length;
        if (resolved.entirelyAssumed) {
          // Nothing measured: keep whatever was there rather than flattening a row that
          // already had a real input from another path.
          if (before === 0) continue;
        }
        if (after > 0) measuredAfter += 1;

        const inputs: Omit<ScoreInputs, "evidenceCompleteness"> = {
          ...base,
          winProbability: resolved.winProbability,
          winProbabilitySource: resolved.provenance.source,
          winProbabilityObservedAt: Object.fromEntries(
            Object.entries(resolved.provenance.observedAt).map(([key, value]) => [key, (value as Date).toISOString()])
          ),
          winProbabilityMissing: resolved.provenance.missing,
        };
        const scored = computeScore({ ...inputs, evidenceCompleteness: row.evidenceCompleteness ?? "none" });
        if (after > before || scored.scoreValue !== row.scoreValue) {
          moved.push({ title: row.dedupKey.slice(0, 44), from: row.scoreValue, to: scored.scoreValue });
        }
        if (!args.apply) continue;

        await db.opportunity.update({
          where: { id: row.id },
          data: { scoreInputs: scored.inputs as never, scoreValue: scored.scoreValue },
        });
      }

      gained += measuredAfter;
      process.stdout.write(
        `${site.domain.padEnd(26)} live=${String(rows.length).padStart(3)} ` +
          `measured before=${String(measuredBefore).padStart(3)} after=${String(measuredAfter).padStart(3)} ` +
          `score moved=${moved.length}\n`
      );
      for (const row of moved.slice(0, 6)) {
        process.stdout.write(`  ${String(row.from).padStart(3)} -> ${String(row.to).padStart(3)}  ${row.title}\n`);
      }
    }

    process.stdout.write(
      `\n${totalRows} rows considered · ${gained} now carry at least one measured winnability input\n`
    );
    process.stdout.write(args.apply ? "applied\n" : "dry run: wrote nothing\n");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
