import { db } from "@/lib/db";

async function main() {
  const [externalProjectId] = process.argv.slice(2);
  const project = await db.project.findFirst({ where: { externalProjectId } });
  if (!project) throw new Error("project not found");
  const jobs = await db.job.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { kind: true, status: true, attempts: true, lastErrorCode: true, createdAt: true, updatedAt: true },
  });
  for (const job of jobs) {
    console.log(`${job.kind} ${job.status} attempts=${job.attempts} err=${job.lastErrorCode ?? "-"} created=${job.createdAt.toISOString()} updated=${job.updatedAt.toISOString()}`);
  }
  await db.$disconnect();
}
main().catch(async (e) => { console.error(e instanceof Error ? e.message : "failed"); await db.$disconnect(); process.exitCode = 1; });
