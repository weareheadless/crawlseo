/**
 * Shadow comparison (plan P9).
 *
 *   npx tsx scripts/shadow-analysis.ts [--site <siteId>] [--json <path>]
 *
 * Projects the board from the evidence that is already stored and diffs it against
 * what is published. It **never** creates or updates an opportunity, a task or a
 * delivery, and by default it does not write evidence either: rebuilding evidence
 * changes what the next detection sees, which is an indirect write to the board.
 *
 * `--rebuild` opts into rebuilding evidence first, for a deliberate review.
 *
 * The diff is the review artefact: what the new model would add, drop, or reorder.
 */
import { writeFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { refreshEvidenceForSite } from "@/lib/funnel/backfill";
import { brandTermsFromDomain, runDetectors } from "@/lib/funnel/detectors";

/** One site per project: a preview mirror must not be analysed as a second tenant. */
function dedupeByProject<T extends { projectId: string | null; domain: string }>(sites: T[]): T[] {
  const byProject = new Map<string, T>();
  for (const site of sites) {
    if (!site.projectId) continue;
    const existing = byProject.get(site.projectId);
    if (!existing) {
      byProject.set(site.projectId, site);
      continue;
    }
    // Prefer the real domain over a workers.dev preview mirror.
    if (existing.domain.includes("workers.dev") && !site.domain.includes("workers.dev")) {
      byProject.set(site.projectId, site);
    }
  }
  return [...byProject.values()];
}

function value(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

type BoardRow = { dedupKey: string; type: string; title: string; scoreValue: number | null };

async function main() {
  const db = new PrismaClient();
  const siteId = value("--site");
  const jsonPath = value("--json");
  const rebuild = process.argv.includes("--rebuild");

  const sites = dedupeByProject(await db.site.findMany({
    where: { retiredAt: null, ...(siteId ? { id: siteId } : {}) },
    select: { id: true, domain: true, projectId: true },
    orderBy: { createdAt: "asc" },
  }));

  const report: Array<Record<string, unknown>> = [];
  for (const site of sites) {
    if (!site.projectId) continue;
    if (rebuild) {
      process.stdout.write(`  ! rebuilding evidence for ${site.domain} (writes observations)\n`);
      await refreshEvidenceForSite(db, site.id, { projectId: site.projectId });
    }
    const dry = await runDetectors(db, site.projectId, {
      detectedBy: "shadow",
      dryRun: true,
      brandTerms: brandTermsFromDomain(site.domain),
    });
    const published = (await db.opportunity.findMany({
      where: { projectId: site.projectId, status: "detected" },
      select: { dedupKey: true, type: true, title: true, scoreValue: true },
    })) as BoardRow[];

    const before = new Map(published.map((row) => [row.dedupKey, row]));
    const after = new Map((dry.candidates ?? []).map((row) => [row.dedupKey, row]));

    const added = [...after.keys()].filter((key) => !before.has(key));
    const dropped = [...before.keys()].filter((key) => !after.has(key));
    const kept = [...after.keys()].filter((key) => before.has(key));

    report.push({
      domain: site.domain,
      published: published.length,
      shadow: after.size,
      added: added.length,
      dropped: dropped.length,
      kept: kept.length,
      disabled: dry.disabled,
      addedSamples: added.slice(0, 10).map((key) => after.get(key)?.title ?? key),
      droppedSamples: dropped.slice(0, 10).map((key) => before.get(key)?.title ?? key),
    });

    process.stdout.write(
      `\n${site.domain}  published ${published.length} → shadow ${after.size}  (+${added.length} / -${dropped.length})\n`
    );
    for (const key of added.slice(0, 5)) process.stdout.write(`  + ${after.get(key)?.title ?? key}\n`);
    for (const key of dropped.slice(0, 5)) process.stdout.write(`  - ${before.get(key)?.title ?? key}\n`);
    for (const disabled of dry.disabled) {
      process.stdout.write(`  ! disabled ${disabled.type} (missing ${disabled.missing.join(", ")})\n`);
    }
  }

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    process.stdout.write(`\nwrote ${jsonPath}\n`);
  }
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
