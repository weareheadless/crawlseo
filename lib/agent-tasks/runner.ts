import { execFile, spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import { addAgentArtifact, addAgentMessage } from "@/lib/agent-tasks/chat";

const execFileAsync = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function prepareWorktree(task: {
  id: string;
  repoPath: string;
  branch: string | null;
  worktreePath: string | null;
}) {
  const branch = task.branch?.trim() || `agent/${task.id}`;
  const worktreePath = task.worktreePath?.trim() || `/tmp/opencode/agent-${task.id}`;
  if (await exists(worktreePath)) return { branch, worktreePath };

  await mkdir("/tmp/opencode", { recursive: true });
  try {
    await execFileAsync("git", ["-C", task.repoPath, "worktree", "add", "-b", branch, worktreePath, "origin/main"], {
      timeout: 60_000,
    });
  } catch {
    await execFileAsync("git", ["-C", task.repoPath, "worktree", "add", worktreePath, branch], {
      timeout: 60_000,
    });
  }
  return { branch, worktreePath };
}

export async function runAgentTask(taskId: string) {
  const task = await db.agentTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("Agent task not found");
  if (!["READY", "CHANGES_REQUESTED"].includes(task.status)) {
    throw new Error(`Agent task is ${task.status}; only READY or CHANGES_REQUESTED tasks can run`);
  }

  const { branch, worktreePath } = await prepareWorktree(task);
  await db.agentTask.update({
    where: { id: task.id },
    data: { status: "RUNNING", branch, worktreePath, startedAt: new Date(), errorCode: null },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "opencode",
        [
          "run",
          "--dir", worktreePath,
          "--agent", "build",
          "--model", process.env.OPENCODE_AGENT_MODEL?.trim() || "openrouter/deepseek/deepseek-v4.1-flash-1017",
          "--format", "json",
          "--auto",
          "--title", `CrawlSEO ${task.id}`,
          task.prompt,
        ],
        {
          cwd: worktreePath,
          stdio: "ignore",
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            HOME: process.env.HOME,
            NODE_ENV: process.env.NODE_ENV,
            LANG: process.env.LANG ?? "C.UTF-8",
            TERM: process.env.TERM ?? "dumb",
            TMPDIR: "/tmp/opencode",
          },
        },
      );
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Agent run timed out after 15 minutes"));
      }, 15 * 60 * 1000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Agent process exited with code ${code ?? "unknown"}`));
      });
    });

    const [diff, status] = await Promise.all([
      execFileAsync("git", ["-C", worktreePath, "diff", "--", "."], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }),
      execFileAsync("git", ["-C", worktreePath, "status", "--short"], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }),
    ]);

    await addAgentArtifact(task.id, { kind: "diff", content: diff.stdout });
    await addAgentArtifact(task.id, { kind: "git_status", content: status.stdout });
    await addAgentMessage(task.id, "Agent run completed. Review the diff, tests, and bridge plan before approving.", "AGENT");
    return db.agentTask.update({
      where: { id: task.id },
      data: {
        status: "AWAITING_REVIEW",
        result: {
          worktreePath,
          branch,
          diffBytes: Buffer.byteLength(diff.stdout),
          changedFiles: status.stdout.split(/\r?\n/).filter(Boolean).length,
        },
        completedAt: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent run failed";
    await addAgentMessage(task.id, `Agent run failed: ${message.slice(0, 1_000)}`, "SYSTEM").catch(() => undefined);
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: "FAILED", errorCode: message.slice(0, 120), completedAt: new Date() },
    });
    throw error;
  }
}
