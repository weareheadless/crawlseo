import { db } from "@/lib/db";
async function main() {
  const [externalProjectId, property] = process.argv.slice(2);
  const project = await db.project.findFirst({ where: { externalProjectId } });
  if (!project) throw new Error("project not found");
  const grant = await db.integrationGrant.findFirst({
    where: { projectId: project.id, provider: "GOOGLE_SEARCH_CONSOLE", externalResourceId: property },
    select: { id: true, status: true },
  });
  if (!grant) { console.log("grant not found"); await db.$disconnect(); return; }
  const active = await db.integrationGrant.count({
    where: { projectId: project.id, provider: "GOOGLE_SEARCH_CONSOLE", status: "ACTIVE" },
  });
  if (grant.status === "ACTIVE" || active === 0) {
    console.log(`refusing to delete: status=${grant.status} activeGrants=${active}`);
    await db.$disconnect();
    process.exitCode = 1;
    return;
  }
  await db.integrationGrant.delete({ where: { id: grant.id } });
  console.log("deleted", property, "| active grants remaining:", active);
  await db.$disconnect();
}
main().catch(async (e) => { console.error(e instanceof Error ? e.message : "failed"); await db.$disconnect(); process.exitCode = 1; });
