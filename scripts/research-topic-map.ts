/**
 * Phase 2 topic map for one site/month.
 *
 *   npx tsx scripts/research-topic-map.ts --site <siteId> --month 2026-11 --dry-run
 *   npx tsx scripts/research-topic-map.ts --site <siteId> --month 2026-11 \
 *     --execute --approval <reference> [--ai] [--refresh] [--refresh-job-map]
 *
 * One semantic pass: the job map decides the jobs, their markets, pages and
 * topic fields. The taxonomy is projected from it and the map is built from
 * both. A stored job map is reused; `--refresh-job-map` proposes a new one, and
 * a missing or pre-contract map is proposed automatically. `--ai` adds one
 * synthesis review of the finished map; it cannot add queries or pages.
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
import {
  projectTopicTaxonomy,
  saveTopicTaxonomy,
} from "@/lib/research/topic-taxonomy";
import {
  loadJobMap,
  proposeJobMap,
  saveJobMap,
  type JobMap,
} from "@/lib/research/job-map";
import { providerCountry } from "@/lib/site/context";
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
  refreshJobMap: boolean;
  out?: string;
  json: boolean;
};

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string" && inner.trim()) return inner.trim();
    if (Array.isArray(inner)) return inner.filter((entry): entry is string => typeof entry === "string").join("; ") || null;
  }
  return null;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  const text = asString(value);
  if (!text) return [];
  return text.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean);
}

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
    refreshJobMap: flags.has("refresh-job-map"),
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
    // The job map is the only semantic pass. The topic taxonomy is a
    // projection of it: one job, one topic, owner = job page. There is no
    // second taxonomy proposal and no reconciliation between two models.
    let jobMap: JobMap | null = await loadJobMap(db, site.id);
    const rawData = await loadTopicMapData(db, site.id, month, null);
    if (!jobMap || args.refreshJobMap) {
      const proposedJobMap = await proposeJobMap({
        domain: site.domain,
        language: rawData.context.language,
        country: providerCountry(rawData.context),
        market: rawData.context.market,
        audienceMarket: rawData.context.audienceMarket,
        audienceCountry: rawData.context.audienceCountry,
        audienceCountries: rawData.context.audienceCountries,
        audienceLanguages: rawData.context.audienceLanguages,
        business: {
          name: rawData.fields.businessName ? String((rawData.fields.businessName as { value?: unknown }).value ?? "") || null : null,
          services: asStringList(rawData.fields.services),
          location: asString(rawData.fields.location),
          serviceArea: asStringList(rawData.fields.serviceArea),
          audience: rawData.context.audience ?? asString(rawData.fields.audienceMotivations),
          audienceMotivations: asStringList(rawData.fields.audienceMotivations),
          differentiators: asStringList(rawData.fields.differentiators),
          concerns: asStringList(rawData.fields.concerns),
        },
        offers: rawData.marketScope.offers,
        pages: [...rawData.pages]
          .sort((a, b) => b.wordCount - a.wordCount)
          .map((page) => ({ path: page.path, title: page.title, h1: page.h1, wordCount: page.wordCount })),
        queries: rawData.queries.map((query) => ({ query: query.query, impressions: query.impressions, volume: query.volume })),
        previous: jobMap,
      });
      if (!proposedJobMap.jobMap) {
        throw new CliError(`could not propose a job map for ${site.domain}: ${proposedJobMap.error ?? "unknown error"}`, 4);
      }
      jobMap = proposedJobMap.jobMap;
      for (const row of proposedJobMap.rejected) process.stderr.write(`job map row skipped: ${row.title} — ${row.reason}\n`);
      if (proposedJobMap.unassigned.length > 0) {
        process.stderr.write(
          `job map left ${proposedJobMap.unassigned.length} tranche queries unassigned: ${proposedJobMap.unassigned.slice(0, 10).join(", ")}${proposedJobMap.unassigned.length > 10 ? ", …" : ""}\n`
        );
      }
      const jobMapPath = path.join("docs", `${site.domain.replace(/[^a-z0-9.-]+/gi, "-")}-job-map-${month}.json`);
      await writeFile(jobMapPath, JSON.stringify(jobMap, null, 2), "utf8");
      if (args.mode === "execute") await saveJobMap(db, site.id, jobMap);
      process.stderr.write(`job map: ${jobMap.jobs.length} jobs, ${jobMap.counts.assigned}/${jobMap.counts.sent} tranche queries assigned, ${jobMap.counts.unassigned} unassigned, ${jobMap.counts.deferred} deferred; written to ${jobMapPath}\n`);
    }
    if (!jobMap) throw new CliError(`no job map for ${site.domain}`, 4);

    const taxonomy = projectTopicTaxonomy(jobMap);
    const taxonomyPath = path.join("docs", `${site.domain.replace(/[^a-z0-9.-]+/gi, "-")}-taxonomy-${month}.json`);
    await writeFile(taxonomyPath, JSON.stringify(taxonomy, null, 2), "utf8");
    if (args.mode === "execute") await saveTopicTaxonomy(db, site.id, taxonomy);

    const data = await loadTopicMapData(db, site.id, month, taxonomy);
    const map = buildTopicMap(data, taxonomy.topics, undefined, jobMap);
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
        taxonomy: "stored-v1",
        ai: args.ai,
        approvalReference: approval,
      } as never,
      topics: map.clusters.map((cluster) => cluster.name) as never,
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
