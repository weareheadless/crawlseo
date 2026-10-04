import { db } from "@/lib/db";
async function main() {
  const [externalProjectId] = process.argv.slice(2);
  const project = await db.project.findFirst({ where: { externalProjectId } });
  if (!project) throw new Error("project not found");
  const grants = await db.integrationGrant.findMany({
    where: { projectId: project.id },
    select: { provider: true, status: true, safeErrorCode: true, lastSuccessfulAt: true, lastValidatedAt: true },
  });
  for (const g of grants) {
    console.log(`${g.provider} status=${g.status} error=${g.safeErrorCode ?? "-"} lastOk=${g.lastSuccessfulAt?.toISOString() ?? "-"}`);
  }
  await db.$disconnect();
}
main().catch(async (e) => { console.error(e instanceof Error ? e.message : "failed"); await db.$disconnect(); process.exitCode = 1; });
