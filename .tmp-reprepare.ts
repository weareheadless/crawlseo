import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { prepareOpportunityWithAgent } from "@/lib/agent-tasks/opportunity-task";
loadEnvConfig(process.cwd());
async function main() {
  const db = new PrismaClient();
  const action = await db.researchAction.findFirst({ where: { dedupeKey: "opportunity:cmw85ld05000soyhbq52sumo3" }, select: { id: true } });
  if (!action) throw new Error("action missing");
  await db.agentTask.deleteMany({ where: { actionId: action.id } });
  await db.contentDraft.deleteMany({ where: { actionId: action.id } });
  const funnel = await db.task.findUnique({ where: { id: "cmwb7duhv0054oy8blozznvr0" }, select: { plan: true } });
  const plan = (funnel?.plan ?? {}) as Record<string, unknown>;
  delete plan.agentTaskId;
  delete plan.agentTaskKind;
  delete plan.agentTaskStatus;
  await db.task.update({ where: { id: "cmwb7duhv0054oy8blozznvr0" }, data: { plan: plan as never } });
  const task = await prepareOpportunityWithAgent("cmw85ld05000soyhbq52sumo3", "cmulsoosk000uoyqfntc58hx5");
  console.log(task);
  const created = await db.agentTask.findUnique({ where: { id: task.id }, select: { draftId: true, prompt: true, status: true, route: true } });
  console.log({ draftId: created?.draftId, status: created?.status, route: created?.route });
  console.log(created?.prompt.slice(0, 800));
  await db.$disconnect();
}
void main();
