import { db } from "@/lib/db";
async function main() {
  const [externalProjectId] = process.argv.slice(2);
  const project = await db.project.findFirst({ where: { externalProjectId } });
  if (!project) throw new Error("project not found");
  const stale = await db.integrationGrant.findMany({
    where: { projectId: project.id, provider: "GOOGLE_SEARCH_CONSOLE", status: "ERROR" },
    select: { id: true, externalResourceId: true },
  });
  for (const grant of stale) {
    await db.integrationGrant.update({
      where: { id: grant.id },
      data: { status: "REVOKED", safeErrorCode: "SUPERSEDED_BY_PLATFORM_PROPERTY" },
    });
    console.log("revoked", grant.externalResourceId);
  }
  if (!stale.length) console.log("nothing to revoke");
  await db.$disconnect();
}
main().catch(async (e) => { console.error(e instanceof Error ? e.message : "failed"); await db.$disconnect(); process.exitCode = 1; });
