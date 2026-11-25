/**
 * Phase 3 opportunity proposals for one site/month.
 *
 *   npx tsx scripts/research-opportunities.ts --site <siteId> --month 2026-11 --dry-run
 *   npx tsx scripts/research-opportunities.ts --site <siteId> --month 2026-11 \
 *     --execute --approval <reference> [--ai] [--refresh]
 *
 * This is a thin wrapper. The stage itself lives in
 * `lib/research/opportunities-stage.ts` so this script and the pipeline
 * (`scripts/research-pipeline.ts`) run one implementation of "draft the
 * proposals from the stored map". What is left here is argument parsing,
 * printing and where the report file goes.
 *
 * Both modes draft proposals with the model, because the board's copy, targets
 * and confidence come from the evidence rather than from a template. Dry run
 * prints them and writes nothing; execute stores them in the existing
 * Opportunity table. `--ai` adds one critique review, which can challenge a
 * proposal but cannot add queries, pages or evidence.
 */

import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { runOpportunitiesStage } from "@/lib/research/opportunities-stage";
import type { Proposal } from "@/lib/research/opportunity-generation";

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

function printProposals(proposals: Proposal[]): void {
  for (const proposal of proposals) {
    process.stdout.write(
      `- [${proposal.lane}/${proposal.kind}] ${proposal.title} · ${proposal.effort}/${proposal.confidence} · target ${proposal.target.url ?? (proposal.target.newAsset ? "new asset" : "none")}\n`
    );
    process.stdout.write(`    ${proposal.summary}\n`);
    if (proposal.whyNow) process.stdout.write(`    why now: ${proposal.whyNow}\n`);
    process.stdout.write(`    action: ${proposal.action}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();
  try {
    const month = args.month?.trim() || new Date().toISOString().slice(0, 7);
    const site = await db.site.findUnique({ where: { id: args.siteId }, select: { domain: true } });
    const slug = (site?.domain ?? args.siteId).replace(/[^a-z0-9.-]+/gi, "-");
    const outPath = args.out ?? path.join("docs", `${slug}-opportunities-${month}.md`);

    const result = await runOpportunitiesStage(db, {
      siteId: args.siteId,
      month,
      mode: args.mode,
      approval: args.approval,
      ai: args.ai,
      refresh: args.refresh,
      onNote: (message) => process.stderr.write(`${message}\n`),
      reports: {
        write: async (name, body) => {
          const target = name.endsWith(`-opportunities-${month}.md`) ? outPath : path.join("docs", name);
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
        process.stdout.write(`existing opportunity run: ${result.runId}; ${result.detail}\n`);
      }
      process.exitCode = 0;
      return;
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ status: "completed", runId: result.runId, proposals: result.proposals, detail: result.detail }, null, 2)}\n`);
    } else {
      printProposals(result.proposals);
      process.stdout.write(`${result.detail}\nrun: ${result.runId}\nreport: ${args.mode === "dry-run" ? outPath : "-"}\n`);
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
