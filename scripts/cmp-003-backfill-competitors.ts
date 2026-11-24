/**
 * CMP-003 backfill: turn SERPs we already paid for into `competitor_rank` rows.
 *
 *   npx tsx scripts/cmp-003-backfill-competitors.ts --site <siteId> --dry-run
 *   npx tsx scripts/cmp-003-backfill-competitors.ts --site <siteId> --apply
 *
 * Why this exists: 164 organic SERPs had been bought and stored in
 * `RawProviderResponse` before the writer produced competitor rows, so
 * `competitor_rank` held 0 rows while the payloads naming every competitor sat in
 * the database. Re-buying them would be paying twice for a fact we already own.
 *
 * The extraction is the same function the live collector uses, so a backfilled row
 * and a freshly written row are identical in shape and provenance: both point at
 * the `RawProviderResponse` they were derived from.
 *
 * This buys nothing. It reads stored payloads and writes evidence.
 */

import { PrismaClient } from "@prisma/client";
import { loadEnvConfig } from "@next/env";

if (!process.env.DATABASE_URL) loadEnvConfig(process.cwd());

import { extractSerpCompetitors } from "@/lib/dataforseo/serp-competitors";
import { storeEvidenceRecord } from "@/lib/funnel/evidence";

type Args = { siteId: string; apply: boolean; limit?: number };

function parseArgs(argv: string[]): Args {
  const args: Args = { siteId: "", apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--site") args.siteId = argv[++index] ?? "";
    else if (flag === "--limit") args.limit = Number(argv[++index]);
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--dry-run") args.apply = false;
  }
  return args;
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

    // The SERP payloads for this project, newest first. A snapshot row records the
    // query and locale the call was made for, so the payload is read with its own
    // dimensions rather than guessing them.
    const snapshots = await db.evidenceRecord.findMany({
      where: {
        projectId: site.projectId,
        kind: "serp_snapshot",
        supersededById: null,
        rawResponseId: { not: null },
      },
      select: { id: true, observedAt: true, dimensions: true, rawResponseId: true },
      orderBy: { observedAt: "desc" },
      ...(args.limit ? { take: args.limit } : {}),
    });

    // Which query/locale pairs already have competitor rows, so a second run is a
    // no-op rather than a duplicate.
    const existing = await db.evidenceRecord.findMany({
      where: { projectId: site.projectId, kind: "competitor_rank", supersededById: null },
      select: { dimensions: true },
    });
    const alreadyCovered = new Set<string>();
    for (const row of existing) {
      const dims = (row.dimensions ?? {}) as { query?: string; locale?: string; observedAt?: string };
      if (!dims.query) continue;
      alreadyCovered.add(`${dims.query}::${dims.locale ?? ""}::${dims.observedAt ?? ""}`);
    }

    // Cluster memberships, so a backfilled row carries the same cluster the live
    // writer would attach.
    const memberships = await db.evidenceRecord.findMany({
      where: { projectId: site.projectId, kind: "keyword_universe_membership", supersededById: null },
      select: { dimensions: true },
    });
    const clusterByQuery = new Map<string, string>();
    for (const row of memberships) {
      const dims = (row.dimensions ?? {}) as { query?: string; cluster?: string };
      if (dims.query && dims.cluster) clusterByQuery.set(dims.query, dims.cluster);
    }

    let snapshotsRead = 0;
    let rowsWritten = 0;
    let rowsSkipped = 0;
    let unattributable = 0;
    const perQuery: Array<{ query: string; competitors: number }> = [];

    for (const snapshot of snapshots) {
      const dims = (snapshot.dimensions ?? {}) as { query?: string; locale?: string; device?: string };
      const query = typeof dims.query === "string" ? dims.query : "";
      if (!query || !snapshot.rawResponseId) continue;
      const observedAtKey = snapshot.observedAt.toISOString().slice(0, 10);
      const key = `${query}::${dims.locale ?? ""}::${observedAtKey}`;
      if (alreadyCovered.has(key)) {
        rowsSkipped += 1;
        continue;
      }

      const raw = await db.rawProviderResponse.findUnique({
        where: { id: snapshot.rawResponseId },
        select: { payload: true },
      });
      const payload = (raw?.payload ?? null) as { organic?: unknown[] } | null;
      if (!payload || !Array.isArray(payload.organic)) continue;
      snapshotsRead += 1;

      const extraction = extractSerpCompetitors({
        organic: payload.organic as never,
        domain: site.domain,
      });
      unattributable += Math.max(0, payload.organic.length - extraction.attributable);
      perQuery.push({ query, competitors: extraction.competitors.length });
      // Counted for both modes: a dry run that reported 0 here would understate the
      // work by exactly the thing a person is deciding whether to do.
      rowsWritten += extraction.competitors.length;

      if (!args.apply) continue;
      for (const competitor of extraction.competitors) {
        const dimensions: Record<string, unknown> = {
          query,
          domain: competitor.domain,
          url: competitor.url,
          rankAbsolute: competitor.position,
          device: dims.device ?? "desktop",
          locale: dims.locale ?? "",
          observedAt: observedAtKey,
        };
        const cluster = clusterByQuery.get(query);
        if (cluster) dimensions.cluster = cluster;
        await storeEvidenceRecord(db, {
          projectId: site.projectId,
          siteId: site.id,
          kind: "competitor_rank",
          observedAt: snapshot.observedAt,
          producer: "dataforseo",
          rawResponseId: snapshot.rawResponseId,
          dimensions: dimensions as never,
          metrics: { "provider:position": { value: competitor.position, unit: "rank", source: "provider" } },
        });
      }
    }

    process.stdout.write(`site: ${site.domain}\n`);
    process.stdout.write(`snapshots with a stored payload: ${snapshots.length}\n`);
    process.stdout.write(`snapshots read: ${snapshotsRead}\n`);
    process.stdout.write(`snapshots skipped (already extracted): ${rowsSkipped}\n`);
    process.stdout.write(`unattributable organic items: ${unattributable}\n`);
    process.stdout.write(`competitor rows ${args.apply ? "written" : "would be written"}: ${rowsWritten}\n`);
    if (!args.apply) {
      const sample = perQuery.slice(0, 5);
      for (const row of sample) process.stdout.write(`  ${row.query}: ${row.competitors} competitors\n`);
      process.stdout.write("dry run: bought nothing, wrote nothing\n");
      return;
    }
    const total = await db.evidenceRecord.count({
      where: { projectId: site.projectId, kind: "competitor_rank" },
    });
    process.stdout.write(`competitor_rank rows now: ${total}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
