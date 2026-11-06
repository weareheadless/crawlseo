/**
 * One monthly evidence bundle for one site.
 *
 *   npx tsx scripts/research-bundle.ts --site <siteId> --month 2026-11 --dry-run
 *   npx tsx scripts/research-bundle.ts --site <siteId> --month 2026-11 \
 *     --execute --approval <owner-reference>
 *
 * Dry run is read-only: it selects the queries/questions, estimates the provider
 * calls and prints the storage plan. Execute is the only mode that can spend, and
 * it refuses without an approval reference, a configured DataForSEO credential
 * and a cap that covers the estimate.
 */

import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

import {
  BundleError,
  runMonthlyBundle,
  type BundlePlan,
  type BundleResult,
} from "@/lib/research/monthly-bundle";

// `tsx` does not load `.env.local` the way Next.js does. The DataForSEO
// credential is encrypted with CREDENTIAL_ENCRYPTION_KEY, which lives there.
loadEnvConfig(process.cwd());

type Args = {
  siteId: string;
  month?: string;
  mode: "dry-run" | "execute";
  approval?: string;
  caps: {
    keywordQueries?: number;
    serpQueries?: number;
    aeoQuestions?: number;
    newsItems?: number;
    capMicros?: number;
  };
  language?: string;
  country?: string;
  resume: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new BundleError(`unexpected argument ${arg}`, 2);
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
  if (!siteId) throw new BundleError("--site <siteId> is required", 2);
  const dryRun = flags.has("dry-run");
  const execute = flags.has("execute");
  if (dryRun === execute) throw new BundleError("choose exactly one of --dry-run or --execute", 2);

  const numberValue = (name: string): number | undefined => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new BundleError(`--${name} must be a number`, 2);
    return value;
  };

  const capUsd = numberValue("cap-usd");
  return {
    siteId,
    month: values.get("month"),
    mode: execute ? "execute" : "dry-run",
    approval: values.get("approval"),
    caps: {
      keywordQueries: numberValue("keyword-queries"),
      serpQueries: numberValue("serp-queries"),
      aeoQuestions: numberValue("aeo-questions"),
      newsItems: numberValue("news-items"),
      capMicros: capUsd === undefined ? undefined : Math.round(capUsd * 1_000_000),
    },
    language: values.get("language"),
    country: values.get("country"),
    resume: flags.has("resume"),
    json: flags.has("json"),
  };
}

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}

function printPlan(plan: BundlePlan): void {
  process.stdout.write(`${plan.domain} (${plan.siteId})\n`);
  process.stdout.write(
    `month ${plan.month} · locale ${plan.locale.languageCode}:${plan.locale.locationCode} (${plan.locale.marketSource} market) · key ${plan.idempotencyKey}\n`
  );
  process.stdout.write(
    `existing bundle: ${plan.existingRun ? `${plan.existingRun.status} (${plan.existingRun.id})` : "none"}\n`
  );
  process.stdout.write(`credentials: ${plan.credentials ? "configured" : "missing"}\n`);
  const budget = plan.budget;
  process.stdout.write(
    `budget: period ${budget.period} · allowance ${
      budget.allowanceMicros === null ? "unset" : usd(budget.allowanceMicros)
    } · committed ${usd(budget.committedMicros)} · remaining ${
      budget.remainingMicros === null ? "unset" : usd(budget.remainingMicros)
    }\n`
  );
  process.stdout.write(
    `caps: keywords ${plan.caps.keywordQueries} · serp ${plan.caps.serpQueries} · aeo ${plan.caps.aeoQuestions} · news ${plan.caps.newsItems} · bundle ${usd(plan.caps.capMicros)}\n`
  );

  process.stdout.write(
    `coverage: ${plan.coverage.keywordQueriesAvailable} queries · ${plan.coverage.unmeasuredKeywordQueries} never measured · ${plan.coverage.keywordQueriesOmitted} get no volume this month · ${plan.coverage.serpQueriesOmitted} get no SERP snapshot · ${plan.coverage.queriesDroppedTooLong} too long for the keyword API\n`
  );

  printList("keyword queries", plan.selected.keywordQueries);
  printList("serp queries", plan.selected.serpQueries);
  printList("aeo questions", plan.selected.aeoQuestions);
  printList("news queries", plan.selected.newsQueries);

  process.stdout.write(
    `reuse: keywords ${plan.reuse.keywordQueries.length} · serp ${plan.reuse.serpQueries.length} · aeo ${plan.reuse.aeoQuestions.length}\n`
  );
  process.stdout.write("expected paid calls:\n");
  if (plan.paidCalls.length === 0) {
    process.stdout.write("  none (everything selected is already stored for this month)\n");
  } else {
    for (const call of plan.paidCalls) {
      process.stdout.write(
        `  ${call.section} · ${call.operation} · ${call.units.length} unit(s) · ~${usd(call.estimatedMicros)}\n`
      );
      if (call.units.length <= 3) {
        for (const unit of call.units) process.stdout.write(`    - ${unit}\n`);
      }
    }
    process.stdout.write(`  total ~${usd(plan.estimatedMicros)} (cap ${usd(plan.caps.capMicros)})\n`);
  }

  process.stdout.write("storage plan:\n");
  for (const entry of plan.storage) {
    process.stdout.write(`  ${entry.table}: ${entry.purpose}\n`);
  }
  for (const warning of plan.warnings) process.stdout.write(`warning: ${warning}\n`);
}

function printList(label: string, values: string[]): void {
  process.stdout.write(`${label} (${values.length}):\n`);
  if (values.length === 0) {
    process.stdout.write("  none\n");
    return;
  }
  values.forEach((value, index) => process.stdout.write(`  ${index + 1}. ${value}\n`));
}

type StoredReport = {
  bundle?: {
    status?: string;
    actualMicros?: number;
    paidCalls?: number;
    month?: string;
    approvalReference?: string;
  };
  sections?: Array<{
    name: string;
    status: string;
    stored: number;
    reused: number;
    costMicros: number;
    error?: string;
  }>;
  counts?: {
    evidenceByKind?: Record<string, number>;
    runEvidenceByKind?: Record<string, number>;
    monthEvidenceByKind?: Record<string, number>;
    newsSources?: number;
  };
};

function printStoredReport(report: StoredReport | undefined): void {
  if (!report?.bundle) return;
  process.stdout.write(
    `stored bundle: ${report.bundle.status ?? "unknown"} · month ${report.bundle.month ?? "?"} · cost ${usd(
      report.bundle.actualMicros ?? 0
    )} · paid calls ${report.bundle.paidCalls ?? 0}\n`
  );
  if (report.bundle.approvalReference) {
    process.stdout.write(`approval: ${report.bundle.approvalReference}\n`);
  }
  if (report.sections) {
    process.stdout.write("stored sections:\n");
    for (const section of report.sections) {
      const cost = section.costMicros > 0 ? ` · ${usd(section.costMicros)}` : "";
      const error = section.error ? ` · ${section.error}` : "";
      process.stdout.write(
        `  ${section.name}: ${section.status} · stored ${section.stored} · reused ${section.reused}${cost}${error}\n`
      );
    }
  }
  if (report.counts?.monthEvidenceByKind) {
    process.stdout.write("evidence by kind (bundle month):\n");
    for (const [kind, count] of Object.entries(report.counts.monthEvidenceByKind)) {
      process.stdout.write(`  ${kind}: ${count}\n`);
    }
  }
  if (report.counts?.runEvidenceByKind) {
    process.stdout.write("evidence stored by this bundle:\n");
    for (const [kind, count] of Object.entries(report.counts.runEvidenceByKind)) {
      process.stdout.write(`  ${kind}: ${count}\n`);
    }
  }
  if (report.counts?.newsSources !== undefined) {
    process.stdout.write(`news/event sources: ${report.counts.newsSources}\n`);
  }
}

function printResult(result: BundleResult): void {
  process.stdout.write(`\nstatus: ${result.status}\n`);
  if (result.runId) process.stdout.write(`run: ${result.runId}\n`);
  if (result.status === "existing") {
    printStoredReport(result.receipt?.report as StoredReport | undefined);
    process.stdout.write("no paid calls were made; the stored bundle receipt is returned above\n");
    if (result.error) process.stdout.write(`note: ${result.error}\n`);
    return;
  }
  if (result.status === "planned") {
    process.stdout.write("dry run only: no provider calls, no writes\n");
    return;
  }

  process.stdout.write(
    `cost: ${usd(result.totalCostMicros)} · paid calls: ${result.paidCalls}\n`
  );
  process.stdout.write("sections:\n");
  for (const section of result.sections) {
    const cost = section.costMicros > 0 ? ` · ${usd(section.costMicros)}` : "";
    const error = section.error ? ` · ${section.error}` : "";
    process.stdout.write(
      `  ${section.name}: ${section.status} · stored ${section.stored} · reused ${section.reused}${cost}${error}\n`
    );
  }
  const report = result.receipt?.report as
    | {
        counts?: {
          evidenceByKind?: Record<string, number>;
          runEvidenceByKind?: Record<string, number>;
          monthEvidenceByKind?: Record<string, number>;
          newsSources?: number;
        };
      }
    | undefined;
  if (report?.counts?.evidenceByKind) {
    process.stdout.write("evidence by kind (site total):\n");
    for (const [kind, count] of Object.entries(report.counts.evidenceByKind)) {
      process.stdout.write(`  ${kind}: ${count}\n`);
    }
  }
  if (report?.counts?.monthEvidenceByKind) {
    process.stdout.write("evidence by kind (bundle month):\n");
    for (const [kind, count] of Object.entries(report.counts.monthEvidenceByKind)) {
      process.stdout.write(`  ${kind}: ${count}\n`);
    }
  }
  if (report?.counts?.runEvidenceByKind) {
    process.stdout.write("evidence stored by this run:\n");
    for (const [kind, count] of Object.entries(report.counts.runEvidenceByKind)) {
      process.stdout.write(`  ${kind}: ${count}\n`);
    }
  }
  if (report?.counts?.newsSources !== undefined) {
    process.stdout.write(`news/event sources: ${report.counts.newsSources}\n`);
  }
  if (result.error) process.stdout.write(`error: ${result.error}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();
  try {
    const result = await runMonthlyBundle(db, {
      siteId: args.siteId,
      month: args.month,
      mode: args.mode,
      approval: args.approval,
      resume: args.resume,
      caps: args.caps,
      language: args.language,
      country: args.country,
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printPlan(result.plan);
      printResult(result);
    }
    process.exitCode = result.exitCode;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof BundleError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
