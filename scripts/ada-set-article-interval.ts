import { db } from "@/lib/db";

async function main() {
  const [projectExternalId, interval] = process.argv.slice(2);
  if (!projectExternalId || interval === undefined) {
    throw new Error("usage: ada-set-article-interval <externalProjectId> <days>");
  }
  const project = await db.project.findFirst({ where: { externalProjectId: projectExternalId } });
  if (!project) throw new Error("project not found");
  const site = await db.site.findFirst({ where: { projectId: project.id } });
  if (!site) throw new Error("site not found");
  const policy = await db.seoResearchPolicy.update({
    where: { siteId: site.id },
    data: { articleMinIntervalDays: Number(interval) },
    select: { siteId: true, articleMinIntervalDays: true, articleTaskLimitPerMonth: true, articleResearchEnabled: true },
  });
  console.log(JSON.stringify({ project: projectExternalId, ...policy }));
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : "failed");
  await db.$disconnect();
  process.exitCode = 1;
});
