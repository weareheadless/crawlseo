import { JobKind } from "@prisma/client";

import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";

/**
 * Operator/platform helper: enqueue fresh GSC and GA4 syncs for a project.
 * Needed after Ada verifies Search Console, because provisioning-time jobs
 * are idempotent and will not run twice for the same credential key.
 */
async function main() {
  const [externalProjectId] = process.argv.slice(2);
  if (!externalProjectId) throw new Error("usage: ada-resync-project <externalProjectId>");
  const project = await db.project.findFirst({ where: { externalProjectId } });
  if (!project) throw new Error("project not found");
  const site = await db.site.findFirst({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!site) throw new Error("site not found");
  const stamp = Date.now();
  const gsc = await enqueueJob({
    projectId: project.id,
    siteId: site.id,
    kind: JobKind.GSC_SYNC,
    payload: { daysBack: 28 },
    idempotencyKey: `ada-resync:${site.id}:gsc:${stamp}`,
  });
  const ga4 = await enqueueJob({
    projectId: project.id,
    siteId: site.id,
    kind: JobKind.GA4_SYNC,
    payload: {},
    idempotencyKey: `ada-resync:${site.id}:ga4:${stamp}`,
  });
  console.log(JSON.stringify({ project: externalProjectId, siteId: site.id, jobs: { gsc: gsc.id, ga4: ga4.id } }));
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : "failed");
  await db.$disconnect();
  process.exitCode = 1;
});
