/**
 * Phase 5 weekly refresh for one site.
 *
 *   npx tsx scripts/research-weekly.ts --site <siteId> --dry-run
 *   npx tsx scripts/research-weekly.ts --site <siteId> --execute [--refresh]
 *
 * Free weekly work: project the latest crawl and Search Console window into
 * evidence, refresh business knowledge/question coverage, run a bounded Google
 * News RSS sweep, and raise a timely proposal only when a source is current.
 * It does not call DataForSEO, does not re-run the monthly bundle, and does not
 * create a task.
 */

import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  renderWeeklyReport,
  runWeeklyRefresh,
  type WeeklyRefreshResult,
} from "@/lib/research/weekly-refresh";

loadEnvConfig(process.cwd());

type Args = {
  siteId: string;
  week?: string;
  mode: "dry-run" | "execute";
  approval?: string;
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
    week: values.get("week"),
    mode: execute ? "execute" : "dry-run",
    approval: values.get("approval"),
    refresh: flags.has("refresh"),
    out: values.get("out"),
    json: flags.has("json"),
  };
}

function printResult(result: WeeklyRefreshResult): void {
  process.stdout.write(`week ${result.week} · status ${result.status}\n`);
  process.stdout.write(`evidence: crawl ${result.evidence.crawl}, gsc ${result.evidence.gsc}, knowledge ${result.evidence.knowledge}, question coverage ${result.evidence.questionCoverage}\n`);
  process.stdout.write(`news: fetched ${result.news.fetched}, stored ${result.news.stored}\n`);
  if (result.timely.proposals.length === 0) {
    process.stdout.write(`timely: none — ${result.timely.reason ?? "no current source"}\n`);
  } else {
    process.stdout.write(`timely: ${result.timely.proposals.length} proposal(s), ${result.timely.stored} stored\n`);
    for (const proposal of result.timely.proposals) process.stdout.write(`- ${proposal.title} · expires ${proposal.expiresAt?.slice(0, 10) ?? "?"}\n`);
    for (const row of result.timely.rejected ?? []) process.stdout.write(`  not stored: ${row.title} — ${row.reason}\n`);
  }
  for (const query of result.queries) process.stdout.write(`query: ${query}\n`);
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

    const result = await runWeeklyRefresh(db, {
      siteId: site.id,
      week: args.week,
      mode: args.mode,
      refresh: args.refresh,
      approval: args.approval,
    });
    const outPath = args.out ?? path.join("docs", `${site.domain.replace(/[^a-z0-9.-]+/gi, "-")}-weekly-${result.week}.md`);
    await writeFile(outPath, renderWeeklyReport(result, site.domain), "utf8");

    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      printResult(result);
      process.stdout.write(`report: ${outPath}\n`);
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
