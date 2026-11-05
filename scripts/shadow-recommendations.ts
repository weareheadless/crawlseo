/**
 * Shadow recommendation analysis (read-only).
 *
 *   npx tsx scripts/shadow-recommendations.ts --domain=www.example.com \
 *     --database-url="postgresql://.../db?schema=csv_validation" \
 *     --out=/tmp/opencode/shadow.json
 *
 * Runs the same packet builder, model assessor, evidence loop and validator as a
 * published reassessment, but writes only the JSON report. It does not mutate
 * opportunities, tasks, evidence selection or business knowledge.
 *
 * The database URL is explicit and must name a non-public schema. The output path
 * must be an absolute JSON file outside the repository and inside the approved
 * shadow root. Both are validated before the connection or model call.
 */
import { PrismaClient } from "@prisma/client";

import { AnalysisLedger } from "@/lib/recommendation/ledger";
import { shadowRecommendations } from "@/lib/recommendation/shadow";
import { assertShadowDestination } from "@/lib/recommendation/shadow-destination";

function value(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main() {
  const domain = value("domain");
  if (!domain) throw new Error("--domain is required");
  const out = value("out") ?? `/tmp/opencode/shadow-${domain.replace(/[^a-z0-9.-]+/gi, "-")}.json`;
  const databaseUrl = value("database-url") ?? process.env.SHADOW_DATABASE_URL ?? null;
  const destination = assertShadowDestination({
    outPath: out,
    databaseUrl,
    overwrite: process.argv.includes("--overwrite"),
  });
  if (!destination.databaseUrl) {
    throw new Error("--database-url or SHADOW_DATABASE_URL is required");
  }

  const db = new PrismaClient({ datasources: { db: { url: destination.databaseUrl } } });
  const site = await db.site.findFirst({
    where: { domain, retiredAt: null },
    select: { id: true, domain: true, projectId: true },
  });
  if (!site?.projectId) throw new Error(`no active site/project for ${domain}`);

  const all = process.argv.includes("--all") || value("max-assessments") === "all";
  const report = await shadowRecommendations(db, {
    projectId: site.projectId,
    siteId: site.id,
    outPath: destination.outPath,
    maxAssessments: all ? "all" : Math.max(1, Math.min(Number(value("max-assessments") ?? 8), 12)),
    ledger: new AnalysisLedger(),
  });
  process.stdout.write(`\n${site.domain}: shadow analysis\n`);
  process.stdout.write(
    `  ${report.complete ? "complete" : "incomplete"}: ${report.assessedCount}/${report.candidateCount} assessed, ${report.notAssessedCount} not assessed\n`
  );
  for (const [status, count] of Object.entries(report.totals)) {
    if (count > 0) process.stdout.write(`  ${status}: ${count}\n`);
  }
  for (const entry of report.entries) {
    if (entry.status === "unchanged") continue;
    process.stdout.write(
      `  ${entry.status}: ${entry.theme} (${entry.currentReadiness ?? "none"} → ${entry.proposedReadiness ?? "none"})${entry.reason ? ` — ${entry.reason}` : ""}\n`
    );
  }
  process.stdout.write(`\nwrote ${destination.outPath}\n`);
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
