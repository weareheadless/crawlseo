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
 *
 * The work lives in `lib/research/topic-map-run.ts` so the site cycle runs the
 * same function. This wrapper only parses flags, writes the review artefacts to
 * `docs/`, and prints.
 */

import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { runTopicMap, TopicMapRunError } from "@/lib/research/topic-map-run";
import { renderTopicMapMarkdown, type TopicMap } from "@/lib/research/topic-map";

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
  if (args.mode === "execute" && !args.approval?.trim()) {
    throw new CliError("--execute requires --approval <reference>", 2);
  }
  const db = new PrismaClient();
  try {
    const result = await runTopicMap(db, {
      siteId: args.siteId,
      month: args.month,
      mode: args.mode,
      approval: args.approval?.trim() || null,
      ai: args.ai,
      refresh: args.refresh,
      refreshJobMap: args.refreshJobMap,
    });

    for (const warning of result.warnings) process.stderr.write(`${warning}\n`);

    if (result.status === "existing") {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ status: "existing", runId: result.runId, report: result.report }, null, 2)}\n`);
      } else {
        process.stdout.write(`existing topic map: ${result.runId} (use --refresh to rebuild)\n`);
      }
      return;
    }

    const stem = result.site.domain.replace(/[^a-z0-9.-]+/gi, "-");
    if (result.jobMap) {
      const jobMapPath = path.join("docs", `${stem}-job-map-${result.month}.json`);
      await writeFile(jobMapPath, JSON.stringify(result.jobMap, null, 2), "utf8");
      process.stderr.write(
        `job map: ${result.jobMap.jobs.length} jobs, ${result.jobMap.counts.assigned}/${result.jobMap.counts.sent} tranche queries assigned, ${result.jobMap.counts.judged}/${result.jobMap.counts.queries} judged so far (${result.jobMap.counts.carried} carried), ${result.jobMap.counts.deferred} unjudged; written to ${jobMapPath}\n`
      );
    }
    if (result.taxonomy) {
      const taxonomyPath = path.join("docs", `${stem}-taxonomy-${result.month}.json`);
      await writeFile(taxonomyPath, JSON.stringify(result.taxonomy, null, 2), "utf8");
    }
    if (result.map) {
      const outPath = args.out ?? path.join("docs", `${stem}-topic-map-${result.month}.md`);
      await writeFile(outPath, renderTopicMapMarkdown(result.map), "utf8");
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ status: result.status, runId: result.runId, report: result.report }, null, 2)}\n`);
      } else {
        printMap(result.map);
        if (result.stored) {
          process.stdout.write(`stored: ${result.stored.created} created, ${result.stored.updated} updated, ${result.stored.superseded} superseded, ${result.stored.memberships} memberships\n`);
        }
        process.stdout.write(`run: ${result.runId}\napproval: ${result.approvalReference ?? "none"}\nreport: ${outPath}\n`);
      }
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof CliError || error instanceof TopicMapRunError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
