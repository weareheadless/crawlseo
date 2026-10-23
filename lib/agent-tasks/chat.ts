import { db } from "@/lib/db";
import { ResearchServiceError } from "@/lib/research/service";

export async function listAgentMessages(taskId: string) {
  const task = await db.agentTask.findUnique({ where: { id: taskId }, select: { id: true } });
  if (!task) throw new ResearchServiceError("Agent task not found", 404);
  return db.agentTaskMessage.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
}

export async function addAgentMessage(
  taskId: string,
  content: string,
  role: "HUMAN" | "AGENT" | "SYSTEM" = "HUMAN",
) {
  const task = await db.agentTask.findUnique({ where: { id: taskId }, select: { id: true } });
  if (!task) throw new ResearchServiceError("Agent task not found", 404);
  return db.agentTaskMessage.create({
    data: { taskId, role, content: content.trim().slice(0, 20_000) },
  });
}

export async function listAgentArtifacts(taskId: string) {
  return db.agentTaskArtifact.findMany({
    where: { taskId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function addAgentArtifact(
  taskId: string,
  input: { kind: string; content?: string | null; url?: string | null },
) {
  return db.agentTaskArtifact.create({
    data: {
      taskId,
      kind: input.kind.slice(0, 80),
      content: input.content?.slice(0, 100_000) ?? null,
      url: input.url?.slice(0, 2_000) ?? null,
    },
  });
}
