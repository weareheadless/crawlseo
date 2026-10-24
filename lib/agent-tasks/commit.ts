import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import { updateAgentTask } from "@/lib/agent-tasks/service";
import { ResearchServiceError } from "@/lib/research/service";

const execFileAsync = promisify(execFile);

export async function commitAgentTask(taskId: string) {
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, title: true, worktreePath: true },
  });
  if (!task) throw new ResearchServiceError("Agent task not found", 404);
  if (task.status !== "APPROVED") {
    throw new ResearchServiceError("Approve the agent task before committing", 409);
  }
  if (!task.worktreePath) {
    throw new ResearchServiceError("Agent worktree is missing", 409);
  }

  await execFileAsync("git", ["-C", task.worktreePath, "add", "-A"], { timeout: 60_000 });
  const status = await execFileAsync("git", ["-C", task.worktreePath, "status", "--porcelain"], { timeout: 60_000 });
  if (!status.stdout.trim()) {
    throw new ResearchServiceError("No changes to commit", 409);
  }
  await execFileAsync(
    "git",
    ["-C", task.worktreePath, "commit", "-m", `CrawlSEO agent: ${task.title}`.slice(0, 200)],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const sha = (await execFileAsync("git", ["-C", task.worktreePath, "rev-parse", "HEAD"], { timeout: 30_000 })).stdout.trim();
  const updated = await updateAgentTask(task.id, { status: "COMMITTED", commitSha: sha });
  return { task: updated, commitSha: sha };
}
