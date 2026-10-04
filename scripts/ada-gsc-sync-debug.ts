import { db } from "@/lib/db";
import { syncGSCDataForProject } from "@/lib/workers/gsc-sync";

async function main() {
  const [externalProjectId] = process.argv.slice(2);
  const project = await db.project.findFirst({ where: { externalProjectId } });
  if (!project) throw new Error("project not found");
  const site = await db.site.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { id: true, gscProperty: true } });
  if (!site) throw new Error("site not found");
  console.log("site:", site.id, "property:", site.gscProperty);
  const result = await syncGSCDataForProject(project.id, site.id, 28);
  console.log(JSON.stringify(result, null, 2));
  await db.$disconnect();
}
main().catch(async (error) => { console.error(error); await db.$disconnect(); process.exitCode = 1; });
