import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { prepareOpportunityWithAgent } from "@/lib/agent-tasks/opportunity-task";
loadEnvConfig(process.cwd());
async function main() {
  const db = new PrismaClient();
  const task = await prepareOpportunityWithAgent("cmw85ld05000soyhbq52sumo3", "cmulsoosk000uoyqfntc58hx5");
  console.log(task);
  const action = await db.researchAction.findFirst({ where: { dedupeKey: "opportunity:cmw85ld05000soyhbq52sumo3" }, select: { id: true, kind: true, format: true, targetUrl: true, status: true, preparationStatus: true } });
  console.log(action);
  const funnel = await db.task.findUnique({ where: { id: "cmwb7duhv0054oy8blozznvr0" }, select: { status: true, plan: true, humanConfirmedAt: true } });
  console.log(funnel);
  await db.$disconnect();
}
void main();
