import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
loadEnvConfig(process.cwd());
async function main() {
  const db = new PrismaClient();
  const id = "cmwbbs06o0003oy5oycqtsmz5";
  for (let i = 0; i < 60; i += 1) {
    const task = await db.agentTask.findUnique({ where: { id }, select: { status: true, errorCode: true, result: true } });
    const result = (task?.result ?? {}) as Record<string, unknown>;
    const progress = (result.progress ?? {}) as { stage?: string; lines?: Array<{ message: string }> };
    const last = progress.lines?.at(-1)?.message ?? "";
    console.log(new Date().toISOString().slice(11, 19), task?.status, progress.stage ?? "", "|", last.slice(0, 120));
    if (task && ["AWAITING_REVIEW", "FAILED", "PUBLISHED", "CHANGES_REQUESTED"].includes(task.status)) {
      if (task.errorCode) console.log("error", task.errorCode);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  await db.$disconnect();
}
void main();
