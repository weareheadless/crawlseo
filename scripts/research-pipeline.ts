/**
 * Run the monthly research pipeline for one site, in order.
 *
 *   npx tsx scripts/research-pipeline.ts --site <siteId> --month 2026-11 --dry-run
 *   npx tsx scripts/research-pipeline.ts --site <siteId> --month 2026-11 \
 *     --execute --approval <owner-reference> [--refresh] [--refresh-bundle] [--allow-partial]
 *
 * `--refresh` rebuilds the topic map and the proposals, which costs a model
 * call. `--refresh-bundle` re-buys the paid evidence, which costs money. They
 * are separate on purpose: repairing a map that was built before its data must
 * not buy the data again.
 *
 * The pipeline is three stages in the order the data requires: the paid bundle,
 * the topic map built from it, then the proposals drafted from the map. Until
 * this script existed, nothing sequenced them, and a map could be built before
 * the bundle it was supposed to read.
 *
 * `--dry-run` builds the bundle plan and reports the later stages without
 * starting them, because both cost a model call. `--execute` requires an
 * approval reference: without it the bundle is reported `blocked` and no paid
 * call is made.
 */

import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

import { runResearchPipeline } from "@/lib/research/pipeline";

loadEnvConfig(process.cwd());

type Args = {
  siteId: string;
  month?: string;
  mode: "dry-run" | "execute";
  approval?: string;
  refresh: boolean;
  refreshBundle: boolean;
  country?: string;
  language?: string;
  allowPartial: boolean;
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
    refresh: flags.has("refresh"),
    refreshBundle: flags.has("refresh-bundle"),
    country: values.get("country"),
    language: values.get("language"),
    allowPartial: flags.has("allow-partial"),
    json: flags.has("json"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();
  try {
    const result = await runResearchPipeline(db, {
      siteId: args.siteId,
      month: args.month,
      mode: args.mode,
      approval: args.approval,
      refresh: args.refresh,
      refreshBundle: args.refreshBundle,
      country: args.country,
      language: args.language,
      allowPartial: args.allowPartial,
      onNote: (message) => process.stderr.write(`${message}\n`),
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const site = await db.site.findUnique({ where: { id: result.siteId }, select: { domain: true } });
      process.stdout.write(`${site?.domain ?? result.siteId} — research pipeline ${result.month} (${result.mode})\n`);
      for (const stage of result.stages) {
        process.stdout.write(`  ${stage.status.padEnd(9)} ${stage.stage.padEnd(14)} ${stage.runId ?? "-"}\n`);
        process.stdout.write(`            ${stage.detail}\n`);
      }
      if (result.blockedBy) process.stdout.write(`\nstopped at: ${result.blockedBy}\n`);
    }

    // Exit codes match the bundle's own convention: a blocked or incomplete
    // stage is not success, so a scheduled caller can tell the difference.
    const statuses = result.stages.map((stage) => stage.status);
    process.exitCode = statuses.includes("failed") || statuses.includes("blocked") ? 5 : statuses.includes("partial") ? 5 : 0;
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
