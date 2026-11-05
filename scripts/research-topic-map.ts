/**
 * Phase 2 topic map for one site/month.
 *
 *   npx tsx scripts/research-topic-map.ts --site <siteId> --month 2026-11 --dry-run
 *   npx tsx scripts/research-topic-map.ts --site <siteId> --month 2026-11 \
 *     --execute --approval <reference> [--ai] [--refresh]
 *
 * Dry run is read-only: it builds the deterministic map and prints/writes the
 * report. Execute stores the clusters and memberships in the existing demand-map
 * tables. `--ai` additionally runs one context-synthesis review; it cannot add
 * queries or pages.
 */

import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

import {
  buildTopicMap,
  loadTopicMapData,
  renderTopicMapMarkdown,
  storeTopicMap,
  synthesizeTopicMap,
  topicMapChecksum,
  topicMapKey,
  type TopicMap,
} from "@/lib/research/topic-map";
import { taxonomyForDomain } from "@/lib/research/topic-taxonomy";
import { writeFile } from "node:fs/promises";
import path from "node:path";

loadEnvConfig(process.cwd());

type Args = {
  siteId: string;
  month?: string;
  mode: "dry-run" | "execute";
  approval?: string;
  ai: boolean;
  refresh: boolean;
  out?: string;
  json: boolean;
};

class CliError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = "CliError";
  }
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new CliError(`unexpected argument ${arg}`, 2);
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      values.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(name);
      continue;
    }
    values.set(name, next);
    index += 1;
  }
  const siteId = values.get("site");
  if (!siteId) throw new CliError("--site <siteId> is required", 2);
  const dryRun = flags.has("dry-run");
  const execute = flags.has("execute");
  if (dryRun === execute) throw new CliError("choose exactly one of --dry-run or --execute", 2);
  return {
    siteId,
    month: values.get("month"),
    mode: execute ? "execute" : "dry-run",
    approval: values.get("approval"),
    ai: flags.has("ai"),
    refresh: flags.has("refresh"),
    out: values.get("out"),
    json: flags.has("json"),
  };
}

function printMap(map: TopicMap): void {
  process.stdout.write(`${map.domain} — topic map ${map.month}\n`);
  process.stdout.write(
    `queries ${map.counts.queries} · clustered ${map.counts.clusteredQueries} · unmapped ${map.counts.unmappedQueries} · pages ${map.counts.pages} · news ${map.counts.news}\n`
  );
  process.stdout.write(`AI: ${map.ai.available ? `available (${map.ai.model})` : `not run${map.ai.error ? ` (${map.ai.error})` : ""}`}\n\n`);
  for (const cluster of map.clusters) {
    process.stdout.write(
      `- ${cluster.name} [${cluster.slug}] · ${cluster.intent} · ${cluster.relevance} · scope ${cluster.marketScope.scope} · q ${cluster.metrics.queries} · imp ${cluster.metrics.impressions} · vol ${cluster.metrics.volume} · coverage ${cluster.coverage}\n`
    );
    if (cluster.pages[0]) process.stdout.write(`    page: ${cluster.pages[0].url}\n`);
    for (const gap of cluster.gaps.slice(0, 2)) process.stdout.write(`    gap: ${gap}\n`);
  }
  if (map.unmapped.length > 0) {
    process.stdout.write("\nUnmapped demand:\n");
    for (const query of map.unmapped.slice(0, 10)) {
      process.stdout.write(`- ${query.query} (${query.impressions} impressions) — ${query.reason}\n`);
    }
  }
  process.stdout.write("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();
  try {
    const site = await db.site.findUnique({
      where: { id: args.siteId },
      select: { id: true, domain: true, projectId: true, retiredAt: true },
    });
    if (!site) throw new CliError(`site ${args.siteId} not found`, 2);
    if (site.retiredAt) throw new CliError(`site ${site.domain} is retired`, 2);
    if (!site.projectId) throw new CliError(`site ${site.domain} is not attached to a project`, 2);
    const month = args.month?.trim() || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new CliError("--month must be YYYY-MM", 2);
    const taxonomy = taxonomyForDomain(site.domain);
    if (taxonomy.length === 0) throw new CliError(`no topic taxonomy is configured for ${site.domain}`, 2);

    const data = await loadTopicMapData(db, site.id, month);
    const map = buildTopicMap(data, taxonomy);
    const outPath = args.out ?? path.join("docs", `${site.domain.replace(/[^a-z0-9.-]+/gi, "-")}-topic-map-${month}.md`);

    if (args.mode === "dry-run") {
      await writeFile(outPath, renderTopicMapMarkdown(map), "utf8");
      if (args.json) process.stdout.write(`${JSON.stringify(map, null, 2)}\n`);
      else {
        printMap(map);
        process.stdout.write(`report: ${outPath}\n`);
      }
      process.exitCode = 0;
      return;
    }

    const approval = args.approval?.trim();
    if (!approval) throw new CliError("--execute requires --approval <reference>", 2);

    const key = topicMapKey(site.id, month);
    const existing = await db.researchRun.findFirst({ where: { siteId: site.id, idempotencyKey: key } });
    if (existing && existing.status === "COMPLETED" && !args.refresh) {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ status: "existing", runId: existing.id, report: existing.report }, null, 2)}\n`);
      } else {
        process.stdout.write(`existing topic map: ${existing.id} (${existing.status}); use --refresh to rebuild\n`);
      }
      process.exitCode = 0;
      return;
    }

    if (args.ai) {
      map.ai = await synthesizeTopicMap(map, map.business);
      if (!map.ai.available) {
        process.stderr.write(`AI review unavailable: ${map.ai.error ?? "unknown error"}\n`);
      }
    }

    const stored = await storeTopicMap(db, map);
    const checksum = topicMapChecksum(map);
    const report = {
      version: 1,
      map,
      checksum,
      stored,
      approvalReference: approval,
      ai: map.ai,
      note: map.ai.available
        ? "One context-synthesis review was run. The provider does not report token usage to this client, so no AI cost is recorded against the DataForSEO budget."
        : "No AI review was run; the deterministic map is stored as-is.",
    };
    const runData = {
      siteId: site.id,
      projectId: site.projectId,
      kind: "SEO" as const,
      trigger: "MANUAL" as const,
      status: "COMPLETED" as const,
      title: `Topic map — ${month}`,
      brief: {
        month,
        taxonomy: "atelier-v1",
        ai: args.ai,
        approvalReference: approval,
      } as never,
      topics: map.clusters.map((cluster) => cluster.name).slice(0, 12) as never,
      recencyDays: 31,
      promptVersion: "topic-map-v1",
      idempotencyKey: key,
      requestedBy: "research-topic-map-cli",
      startedAt: new Date(),
      completedAt: new Date(),
      report: report as never,
      sourceCount: map.counts.news,
      findingCount: 0,
      actionCount: 0,
      costMicros: 0,
    };
    let runId: string;
    if (existing) {
      const updated = await db.researchRun.update({
        where: { id: existing.id },
        data: { ...runData, status: "COMPLETED" },
        select: { id: true },
      });
      runId = updated.id;
    } else {
      const created = await db.researchRun.create({ data: runData, select: { id: true } });
      runId = created.id;
    }

    await writeFile(outPath, renderTopicMapMarkdown(map), "utf8");
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ status: "completed", runId, report }, null, 2)}\n`);
    } else {
      printMap(map);
      process.stdout.write(`stored: ${stored.created} created, ${stored.updated} updated, ${stored.superseded} superseded, ${stored.memberships} memberships\n`);
      process.stdout.write(`run: ${runId}\nreport: ${outPath}\n`);
    }
    process.exitCode = 0;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
