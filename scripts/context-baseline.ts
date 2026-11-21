/**
 * Read-only baseline: what context and research each active site actually has,
 * and whether the board is backed by measured demand.
 *
 *   npx tsx scripts/context-baseline.ts --all
 *   npx tsx scripts/context-baseline.ts --all --json
 *
 * This exists to measure the gap before changing anything (plan M0) and to give
 * every later milestone a before/after. It writes nothing and calls no provider.
 */

import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());

type Row = {
  siteId: string;
  domain: string;
  knowledge: "absent" | "unusable" | "working" | "accepted";
  knowledgeFields: number;
  lastResearch: string | null;
  lastResearchStatus: string | null;
  findings: number;
  researchEvidence: number;
  opportunities: number;
  withHowLeg: number;
  withBothLegs: number;
  lastBundle: string | null;
};

function hasUsableFields(fields: unknown): boolean {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return false;
  for (const [key, entry] of Object.entries(fields as Record<string, unknown>)) {
    if (key === "contentLanguage") continue;
    const value = entry && typeof entry === "object" ? (entry as { value?: unknown }).value : entry;
    if (typeof value === "string" && value.trim()) return true;
    if (Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim())) return true;
    if (value != null && typeof value !== "string" && typeof value !== "object") return true;
  }
  return false;
}

async function readSite(db: PrismaClient, site: { id: string; domain: string; projectId: string }): Promise<Row> {
  const [document, lastRun, researchEvidence, opportunities, lastBundle] = await Promise.all([
    db.businessKnowledgeDocument.findUnique({
      where: { projectId: site.projectId },
      select: { acceptedRevision: true, revision: true, revisions: { orderBy: { revision: "desc" }, take: 1, select: { fields: true } } },
    }),
    db.researchRun.findFirst({
      where: { siteId: site.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, status: true, findingCount: true },
    }),
    db.evidenceRecord.count({ where: { projectId: site.projectId, siteId: site.id, kind: "research_finding", supersededById: null } }),
    db.opportunity.findMany({ where: { projectId: site.projectId }, select: { evidenceCompleteness: true } }),
    db.researchRun.findFirst({
      where: { siteId: site.id, idempotencyKey: { contains: ":bundle" } },
      orderBy: { createdAt: "desc" },
      select: { idempotencyKey: true, createdAt: true },
    }),
  ]);
  const fields = document?.revisions[0]?.fields;
  const usable = hasUsableFields(fields);
  return {
    siteId: site.id,
    domain: site.domain,
    knowledge: !document ? "absent" : usable ? (document.acceptedRevision != null ? "accepted" : "working") : "unusable",
    knowledgeFields: fields && typeof fields === "object" && !Array.isArray(fields) ? Object.keys(fields).length : 0,
    lastResearch: lastRun?.createdAt.toISOString().slice(0, 10) ?? null,
    lastResearchStatus: lastRun?.status ?? null,
    findings: lastRun?.findingCount ?? 0,
    researchEvidence,
    opportunities: opportunities.length,
    withHowLeg: opportunities.filter((row) => row.evidenceCompleteness === "how" || row.evidenceCompleteness === "both").length,
    withBothLegs: opportunities.filter((row) => row.evidenceCompleteness === "both").length,
    lastBundle: lastBundle?.createdAt.toISOString().slice(0, 10) ?? null,
  };
}

async function main() {
  const db = new PrismaClient();
  const json = process.argv.includes("--json");
  try {
    const sites = await db.site.findMany({
      where: { projectId: { not: null }, retiredAt: null },
      select: { id: true, domain: true, projectId: true },
      orderBy: { createdAt: "asc" },
    });
    const rows: Row[] = [];
    for (const site of sites) rows.push(await readSite(db, { id: site.id, domain: site.domain, projectId: site.projectId! }));

    if (json) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    const counts = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.knowledge] = (acc[row.knowledge] ?? 0) + 1;
      return acc;
    }, {});
    process.stdout.write("domain".padEnd(34) + "knowledge".padEnd(12) + "research".padEnd(20) + "findings".padEnd(10) + "opps".padEnd(7) + "how".padEnd(6) + "both".padEnd(6) + "bundle\n");
    for (const row of rows) {
      process.stdout.write(
        `${row.domain.slice(0, 33).padEnd(34)}${row.knowledge.padEnd(12)}${`${row.lastResearch ?? "never"} ${row.lastResearchStatus ?? ""}`.slice(0, 19).padEnd(20)}${String(row.findings).padEnd(10)}${String(row.opportunities).padEnd(7)}${String(row.withHowLeg).padEnd(6)}${String(row.withBothLegs).padEnd(6)}${row.lastBundle ?? "never"}\n`
      );
    }
    process.stdout.write(`\n${rows.length} active site(s); knowledge ${JSON.stringify(counts)}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error).slice(0, 500)}\n`);
  process.exitCode = 1;
});
