import { loadEnvConfig } from "@next/env";
import { db } from "@/lib/db";
import { normalizeResearchCadence } from "@/lib/research/policy";
import { runEvaluation } from "@/lib/aeo/run";

loadEnvConfig(process.cwd());

async function main() {
  const sites = await db.site.findMany({
    where: { project: { status: "ACTIVE" } },
    select: {
      id: true, domain: true, projectId: true,
      project: { select: { status: true, researchBudgetTimeZone: true, businessKnowledgeDocuments: { select: { id: true } } } },
      researchPolicy: { select: { cadence: true } },
      siteProfile: { select: { id: true } },
      researchRuns: { select: { id: true }, take: 1 },
    },
  });
  let unexpected = false;
  for (const site of sites) {
    if (normalizeResearchCadence(site.researchPolicy?.cadence) === "manual") {
      console.log(JSON.stringify({ site: site.domain, status: "skipped", reason: "manual cadence" }));
      continue;
    }
    if (!site.projectId || (!site.project?.businessKnowledgeDocuments.length && !site.siteProfile && !site.researchRuns.length)) {
      console.log(JSON.stringify({ site: site.domain, status: "skipped", reason: "missing project or business/research data" }));
      continue;
    }
    try {
      const receipt = await runEvaluation({ projectId: site.projectId, siteId: site.id, trigger: "scheduled", cap: 30, timeZone: site.project?.researchBudgetTimeZone ?? "UTC" });
      console.log(JSON.stringify({ site: site.domain, ...receipt }));
    } catch (error) {
      unexpected = true;
      console.log(JSON.stringify({ site: site.domain, status: "failed", error: error instanceof Error ? error.message : "unexpected failure" }));
    }
  }
  if (unexpected) process.exitCode = 1;
}

main().catch((error) => {
  console.error("AEO evaluation scheduler failed", error);
  process.exitCode = 1;
}).finally(() => db.$disconnect());
