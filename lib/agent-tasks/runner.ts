import { execFile, spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import { addAgentArtifact, addAgentMessage } from "@/lib/agent-tasks/chat";

const execFileAsync = promisify(execFile);

async function repoState(repoPath: string): Promise<{ branch: string; status: string }> {
  const [branch, status] = await Promise.all([
    execFileAsync("git", ["-C", repoPath, "branch", "--show-current"], { timeout: 30_000 }),
    execFileAsync("git", ["-C", repoPath, "status", "--porcelain"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }),
  ]);
  return { branch: branch.stdout.trim(), status: status.stdout };
}

function agentTextFromOutput(output: string): string {
  const parts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; part?: { type?: unknown; text?: unknown } };
      if (event.type === "text" && typeof event.part?.text === "string" && event.part.text.trim()) {
        parts.push(event.part.text.trim());
      }
    } catch {
      // Opencode can emit non-JSON lines; keep them out of the assistant message.
    }
  }
  return parts.join("\n\n").trim();
}

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
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    include: {
      messages: {
        where: { role: "HUMAN" },
        orderBy: { createdAt: "asc" },
        take: 50,
      },
    },
  });
  if (!task) throw new Error("Agent task not found");
  if (!["READY", "CHANGES_REQUESTED"].includes(task.status)) {
    throw new Error(`Agent task is ${task.status}; only READY or CHANGES_REQUESTED tasks can run`);
  }

  const repoBefore = await repoState(task.repoPath).catch(() => null);
  const followUps = task.messages
    .map((message) => message.content.trim())
    .filter((content) => content && !/^(go|ok|okay|yes|yep|do it|proceed)$/i.test(content))
    .slice(-10);
  const prompt = followUps.length > 0
    ? `${task.prompt}\n\nLATEST OPERATOR FOLLOW-UP\n${followUps.map((message) => `- ${message}`).join("\n")}`
    : task.prompt;

  const { branch, worktreePath } = await prepareWorktree(task);
  await db.agentTask.update({
    where: { id: task.id },
    data: { status: "RUNNING", branch, worktreePath, startedAt: new Date(), errorCode: null },
  });

  let agentOutput = "";
  let agentErrorOutput = "";
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
          prompt,
        ],
        {
          cwd: worktreePath,
          stdio: ["ignore", "pipe", "pipe"],
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
      child.stdout?.on("data", (chunk: Buffer) => {
        agentOutput = (agentOutput + chunk.toString("utf8")).slice(-1_000_000);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        agentErrorOutput = (agentErrorOutput + chunk.toString("utf8")).slice(-200_000);
      });
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
    if (agentOutput.trim()) {
      await addAgentArtifact(task.id, { kind: "agent_output", content: agentOutput.slice(0, 200_000) });
    }
    if (agentErrorOutput.trim()) {
      await addAgentArtifact(task.id, { kind: "agent_stderr", content: agentErrorOutput.slice(0, 100_000) });
    }
    const agentText = agentTextFromOutput(agentOutput);
    if (agentText) {
      await addAgentMessage(task.id, agentText.slice(0, 4_000), "AGENT");
    }

    const repoAfter = await repoState(task.repoPath).catch(() => null);
    const escaped = Boolean(
      repoBefore && repoAfter &&
      (repoBefore.branch !== repoAfter.branch || repoBefore.status !== repoAfter.status),
    );
    if (escaped) {
      const detail = JSON.stringify({ before: repoBefore, after: repoAfter }, null, 2);
      await addAgentArtifact(task.id, { kind: "main_repo_contamination", content: detail });
      await addAgentMessage(
        task.id,
        "The agent modified the main site checkout instead of staying in the prepared worktree. Review the main repository before continuing.",
        "SYSTEM",
      );
      return db.agentTask.update({
        where: { id: task.id },
        data: {
          status: "CHANGES_REQUESTED",
          errorCode: "AGENT_ESCAPED_WORKTREE",
          result: { worktreePath, branch, diffBytes: Buffer.byteLength(diff.stdout), repoBefore, repoAfter },
          completedAt: null,
        },
      });
    }

    if (!diff.stdout.trim() && !status.stdout.trim()) {
      await addAgentMessage(
        task.id,
        "Agent run completed without changing any files. Add more specific instructions or verify the target route before rerunning.",
        "SYSTEM",
      );
      return db.agentTask.update({
        where: { id: task.id },
        data: {
          status: "CHANGES_REQUESTED",
          errorCode: "AGENT_NO_CHANGES",
          result: { worktreePath, branch, diffBytes: 0, changedFiles: 0 },
          completedAt: null,
        },
      });
    }

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
