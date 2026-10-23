import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { updateAgentTask } from "@/lib/agent-tasks/service";
import { ResearchServiceError } from "@/lib/research/service";

const execFileAsync = promisify(execFile);

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, title: true, worktreePath: true },
  });
  if (!task) return Response.json({ error: "Agent task not found" }, { status: 404 });
  if (task.status !== "APPROVED") {
    return Response.json({ error: "Approve the agent task before committing" }, { status: 409 });
  }
  if (!task.worktreePath) {
    return Response.json({ error: "Agent worktree is missing" }, { status: 409 });
  }

  try {
    await execFileAsync("git", ["-C", task.worktreePath, "add", "-A"], { timeout: 60_000 });
    const status = await execFileAsync("git", ["-C", task.worktreePath, "status", "--porcelain"], { timeout: 60_000 });
    if (!status.stdout.trim()) {
      return Response.json({ error: "No changes to commit" }, { status: 409 });
    }
    await execFileAsync(
      "git",
      ["-C", task.worktreePath, "commit", "-m", `CrawlSEO agent: ${task.title}`.slice(0, 200)],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const sha = (await execFileAsync("git", ["-C", task.worktreePath, "rev-parse", "HEAD"], { timeout: 30_000 })).stdout.trim();
    const updated = await updateAgentTask(task.id, { status: "COMMITTED", commitSha: sha });
    return Response.json({ task: updated, commitSha: sha });
  } catch (error) {
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Agent commit error:", error);
    return Response.json({ error: "Failed to commit agent changes" }, { status: 500 });
  }
}
