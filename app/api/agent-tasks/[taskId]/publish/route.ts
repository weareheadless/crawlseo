import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { ResearchServiceError } from "@/lib/research/service";
import { z } from "zod";
import { ZodError } from "zod";

const schema = z.object({
  publishedUrl: z.string().trim().max(2_000).optional(),
  bridgeReceiptId: z.string().trim().max(200).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  try {
    const input = schema.parse(await req.json().catch(() => ({})));
    const task = await db.agentTask.findUnique({ where: { id: taskId }, select: { id: true, status: true } });
    if (!task) return Response.json({ error: "Agent task not found" }, { status: 404 });
    if (!["COMMITTED", "PUBLISHING"].includes(task.status)) {
      return Response.json({ error: "Commit the agent changes before recording publication" }, { status: 409 });
    }
    const updated = await db.agentTask.update({
      where: { id: taskId },
      data: {
        status: "PUBLISHED",
        publishedUrl: input.publishedUrl || null,
        bridgeReceiptId: input.bridgeReceiptId || null,
        completedAt: new Date(),
      },
    });
    return Response.json({ task: updated });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid publication" }, { status: 400 });
    }
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Agent publish record error:", error);
    return Response.json({ error: "Failed to record publication" }, { status: 500 });
  }
}
