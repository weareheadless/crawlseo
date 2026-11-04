/**
 * Analyse one tenant, or every tenant, through the pipeline.
 *
 *   npx tsx scripts/tenant.ts --site <siteId> [--apply]
 *   npx tsx scripts/tenant.ts --all [--apply]
 *
 * This replaces the per-tenant scripts (business knowledge, joins, provisioning):
 * they were the same steps applied by hand, which is why each tenant looked
 * different depending on what someone had remembered to run.
 */
import { PrismaClient } from "@prisma/client";

import { ensureTenantAnalysis, inspectTenant, type TenantAnalysis } from "@/lib/tenants/analysis";

function value(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function report(analysis: TenantAnalysis): string {
  const lines = [`\n${analysis.domain}  ${analysis.ready ? "READY" : "INCOMPLETE"}`];
  for (const step of analysis.steps) {
    lines.push(`  ${step.status.padEnd(8)} ${step.step.padEnd(19)} ${step.detail}`);
  }
  return lines.join("\n");
}

async function main() {
  const db = new PrismaClient();
  const apply = process.argv.includes("--apply");
  const siteId = value("--site");
  const all = process.argv.includes("--all");
  if (!siteId && !all) throw new Error("--site <siteId> or --all is required");

  const ids = siteId
    ? [siteId]
    : (await db.site.findMany({ where: { researchPolicy: { isNot: null }, retiredAt: null }, select: { id: true }, orderBy: { createdAt: "asc" } })).map((site) => site.id);

  let incomplete = 0;
  for (const id of ids) {
    const analysis = apply ? await ensureTenantAnalysis(db, id, { apply: true }) : await inspectTenant(db, id);
    if (!analysis.ready) incomplete += 1;
    process.stdout.write(`${report(analysis)}\n`);
  }
  process.stdout.write(`\n${ids.length} tenant(s), ${incomplete} incomplete${apply ? "" : " (read-only: pass --apply to fix)"}\n`);
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`${String(error).slice(0, 500)}\n`);
  process.exitCode = 1;
});
