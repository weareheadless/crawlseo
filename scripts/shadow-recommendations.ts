/**
 * Shadow recommendation analysis (read-only).
 *
 *   npx tsx scripts/shadow-recommendations.ts --domain=www.example.com \
 *     --out=/tmp/opencode/shadow.json
 *
 * Runs the same packet builder, model assessor, evidence loop and validator as a
 * published reassessment, but writes only the JSON report. It does not mutate
 * opportunities, tasks, evidence selection or business knowledge.
 */
import { db } from "@/lib/db";
import { shadowRecommendations } from "@/lib/recommendation/shadow";
import { AnalysisLedger } from "@/lib/recommendation/ledger";

function value(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main() {
  const domain = value("domain");
  if (!domain) throw new Error("--domain is required");
  const out = value("out") ?? `/tmp/opencode/shadow-${domain.replace(/[^a-z0-9.-]+/gi, "-")}.json`;
  const site = await db.site.findFirst({
    where: { domain, retiredAt: null },
    select: { id: true, domain: true, projectId: true },
  });
  if (!site?.projectId) throw new Error(`no active site/project for ${domain}`);

  const report = await shadowRecommendations(db, {
    projectId: site.projectId,
    siteId: site.id,
    outPath: out,
    maxAssessments: Math.max(1, Math.min(Number(value("max-assessments") ?? 8), 12)),
    ledger: new AnalysisLedger(),
  });
  process.stdout.write(`\n${site.domain}: shadow analysis\n`);
  for (const [status, count] of Object.entries(report.totals)) {
    if (count > 0) process.stdout.write(`  ${status}: ${count}\n`);
  }
  for (const entry of report.entries) {
    if (entry.status === "unchanged") continue;
    process.stdout.write(
      `  ${entry.status}: ${entry.theme} (${entry.currentReadiness ?? "none"} → ${entry.proposedReadiness ?? "none"})${entry.reason ? ` — ${entry.reason}` : ""}\n`
    );
  }
  process.stdout.write(`\nwrote ${out}\n`);
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
