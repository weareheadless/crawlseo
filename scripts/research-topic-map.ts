/**
 * Phase 2 topic map for one site/month.
 *
 *   npx tsx scripts/research-topic-map.ts --site <siteId> --month 2026-11 --dry-run
 *   npx tsx scripts/research-topic-map.ts --site <siteId> --month 2026-11 \
 *     --execute --approval <reference> [--ai] [--refresh] [--refresh-job-map]
 *
 * This is a thin wrapper. The stage itself lives in
 * `lib/research/topic-map-stage.ts` so that this script and the pipeline
 * (`scripts/research-pipeline.ts`) cannot drift into two implementations of
 * "build the map for this site and month". What is left here is argument
 * parsing, progress output and where the report file goes.
 *
 * One semantic pass: the job map decides the jobs, their markets, pages and
 * topic fields. The taxonomy is projected from it and the map is built from
 * both. A stored job map is reused; `--refresh-job-map` proposes a new one, and
 * a missing or pre-contract map is proposed automatically. `--ai` adds one
 * synthesis review of the finished map; it cannot add queries or pages.
 */

import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { runTopicMapStage } from "@/lib/research/topic-map-stage";
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

function printMap(map: TopicMap, reportPath: string | null): void {
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
  if (reportPath) process.stdout.write(`report: ${reportPath}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();
  try {
    const month = args.month?.trim() || new Date().toISOString().slice(0, 7);
    const site = await db.site.findUnique({ where: { id: args.siteId }, select: { domain: true } });
    const slug = (site?.domain ?? args.siteId).replace(/[^a-z0-9.-]+/gi, "-");
    const outPath = args.out ?? path.join("docs", `${slug}-topic-map-${month}.md`);

    const result = await runTopicMapStage(db, {
      siteId: args.siteId,
      month,
      mode: args.mode,
      approval: args.approval,
      ai: args.ai,
      refresh: args.refresh,
      refreshJobMap: args.refreshJobMap,
      onNote: (message) => process.stderr.write(`${message}\n`),
      reports: {
        write: async (name, body) => {
          // The stage names each report by the site and month; only the map's
          // markdown follows `--out`, which is the file an operator opens.
          const target = name.endsWith(`-topic-map-${month}.md`) ? outPath : path.join("docs", name);
          await writeFile(target, body, "utf8");
        },
      },
    });

    if (result.status === "failed") {
      if (args.json) process.stdout.write(`${JSON.stringify({ status: "failed", detail: result.detail }, null, 2)}\n`);
      else process.stderr.write(`${result.detail}\n`);
      process.exitCode = 4;
      return;
    }

    if (result.status === "skipped") {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ status: "existing", runId: result.runId }, null, 2)}\n`);
      } else {
        process.stdout.write(`existing topic map: ${result.runId}; ${result.detail}\n`);
      }
      process.exitCode = 0;
      return;
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ status: "completed", runId: result.runId, map: result.map, detail: result.detail }, null, 2)}\n`);
    } else if (result.map) {
      printMap(result.map, args.mode === "dry-run" ? outPath : null);
      process.stdout.write(`${result.detail}\nrun: ${result.runId}\n`);
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
