import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import { addAgentArtifact, addAgentMessage } from "@/lib/agent-tasks/chat";
import { agentChangeOutcome, isReleaseableSiteFile, parseGitStatusFiles } from "@/lib/agent-tasks/changes";
import { captureTaskScreenshots, selectScreenshotUrls, type AgentScreenshot } from "@/lib/agent-tasks/screenshots";
import { agentTimeouts } from "@/lib/agent-tasks/timeouts";

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type AgentProgressLine = { at: string; message: string };
type AgentProgressState = {
  stage: string;
  startedAt: string;
  updatedAt: string;
  lines: AgentProgressLine[];
};

function progressRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function createProgress(): AgentProgressState {
  const now = new Date().toISOString();
  return { stage: "Preparing agent", startedAt: now, updatedAt: now, lines: [] };
}

async function flushProgress(taskId: string, progress: AgentProgressState): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const task = await db.agentTask.findUnique({ where: { id: taskId }, select: { result: true } });
  if (!task) return;
  await db.agentTask.update({
    where: { id: taskId },
    data: {
      result: {
        ...progressRecord(task.result),
        progress: {
          ...progress,
          lines: progress.lines.slice(-60),
        },
      },
    },
  });
}

function progressLineForEvent(line: string): string | null {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line) as {
      type?: unknown;
      part?: { type?: unknown; text?: unknown; tool?: unknown; name?: unknown };
    };
    if (event.type === "step_start") return "Agent started a reasoning step.";
    if (event.type === "step_finish") return "Reasoning step completed.";
    if (event.type === "text" && typeof event.part?.text === "string") {
      const text = event.part.text.replace(/\s+/g, " ").trim();
      return text ? `Agent: ${text.slice(0, 220)}` : null;
    }
    const tool = typeof event.part?.tool === "string"
      ? event.part.tool
      : typeof event.part?.name === "string"
        ? event.part.name
        : null;
    if (tool && (event.type === "tool_use" || event.part?.type === "tool")) {
      return `Tool: ${tool}`;
    }
  } catch {
    // Ignore non-JSON output.
  }
  return null;
}

function previewTag(source: string, file: string): string | null {
  const direct = source.match(/customElements\.define\(\s*["']([a-z0-9-]+)["']/i)?.[1];
  const tagged = source.match(/(?:const|let|var)\s+TAG\s*=\s*["']([a-z0-9-]+)["']/i)?.[1];
  const fallback = path.basename(file).replace(/\.js$/i, "");
  const tag = direct ?? tagged ?? fallback;
  return tag && /^[a-z0-9-]+$/.test(tag) ? tag : null;
}

export async function createPreviewArtifact(
  taskId: string,
  worktreePath: string,
  status: string,
  routeUrl?: string | null,
): Promise<void> {
  const files = status
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[A-Z?]{1,2}\s+/, ""))
    .filter((file) => /^src\/public\/custom-elements\/[^/]+\.js$/.test(file))
    .slice(0, 6);
  if (files.length === 0) return;

  const components: Array<{ file: string; tag: string; source: string }> = [];
  for (const file of files) {
    try {
      const source = await readFile(path.join(worktreePath, file), "utf8");
      const tag = previewTag(source, file);
      if (tag) components.push({ file, tag, source });
    } catch {
      // A deleted or unreadable file cannot be previewed.
    }
  }
  if (components.length === 0) return;

  let previewPath = "";
  let categoryKey = "";
  let locale = "";
  if (routeUrl) {
    try {
      const parsed = new URL(routeUrl);
      previewPath = `${parsed.pathname}${parsed.search}`;
      const parts = parsed.pathname.split("/").filter(Boolean);
      categoryKey = parts.at(-1) ?? "";
      locale = /^en(?:\/|$)/i.test(parts[0] ?? "") ? "en" : "fr";
    } catch {
      previewPath = "";
    }
  }
  const attributes = [
    locale ? `locale="${locale}"` : "",
    categoryKey ? `category-key="${categoryKey}"` : "",
  ].filter(Boolean).join(" ");
  const routeScript = previewPath
    ? `<script>history.replaceState(null,"",${JSON.stringify(previewPath)});</script>`
    : "";

  const sections = components.map(({ file, tag, source }) => `
    <section class="preview-block">
      <div class="preview-label">${file}${previewPath ? ` · ${previewPath}` : ""}</div>
      <${tag} ${attributes}></${tag}>
    </section>
    ${routeScript}
    <script>${source}</script>`).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CrawlSEO preview</title>
<style>
  body{margin:0;background:#f3f1eb;color:#222;font:14px/1.5 Arial,sans-serif}
  .preview-note{padding:12px 18px;background:#111;color:#fff;font-size:12px}
  .preview-block{border-bottom:1px solid #d9d4c7;padding:0}
  .preview-label{padding:8px 18px;background:#e7e1d4;color:#6c6558;font:10px/1.4 monospace;text-transform:uppercase;letter-spacing:.08em}
</style>
</head>
<body>
<div class="preview-note">Preview of the modified component source. Live Wix data and page chrome are not loaded here; use this to validate the visible component change before approval.</div>
${sections}
</body>
</html>`;
  await addAgentArtifact(taskId, { kind: "preview_html", content: html });
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
      action: { select: { evidence: true, kind: true, title: true } },
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

  const progress = createProgress();
  progress.stage = "Worktree ready";
  progress.lines.push({ at: new Date().toISOString(), message: `Worktree: ${worktreePath}` });
  await flushProgress(task.id, progress);

  let agentOutput = "";
  let agentErrorOutput = "";
  let outputBuffer = "";
  let lastProgressFlush = 0;
  const addProgress = async (message: string | null, stage?: string, force = false) => {
    if (stage) progress.stage = stage;
    if (message) {
      const last = progress.lines.at(-1)?.message;
      if (message !== last) progress.lines.push({ at: new Date().toISOString(), message });
    }
    const now = Date.now();
    if (force || now - lastProgressFlush >= 1_500) {
      lastProgressFlush = now;
      await flushProgress(task.id, progress).catch(() => undefined);
    }
  };
  let screenshots: AgentScreenshot[] = [];
  const screenshotUrls = selectScreenshotUrls({
    route: task.route,
    evidence: task.action?.evidence,
  });
  if (screenshotUrls.length > 0) {
    await addProgress("Capturing page screenshots for visual review.", "Capturing screenshots", true);
    screenshots = await captureTaskScreenshots(task.id, screenshotUrls).catch(() => []);
    for (const screenshot of screenshots) {
      await addAgentArtifact(task.id, { kind: "screenshot", content: JSON.stringify(screenshot) });
    }
    if (screenshots.length > 0) {
      await addProgress(`Captured ${screenshots.length} page screenshot(s).`, "Screenshots ready", true);
    }
  }
  const batch = task.action?.evidence && typeof task.action.evidence === "object" && !Array.isArray(task.action.evidence)
    ? (task.action.evidence as Record<string, unknown>).batch === true
    : false;
  const timeouts = agentTimeouts({ batch });
  const screenshotNote = screenshots.length > 0
    ? [
        "",
        "SCREENSHOTS",
        `Attached rendered screenshots: ${screenshots.map((screenshot) => screenshot.url).join(", ")}.`,
        "Use the screenshots to inspect the rendered page, its language, and visible content. Do not infer user-facing text from URLs or slugs alone.",
        "For alt text, apply the description to the matching <img> element in the DOM and use alt=\"\" for decorative images.",
      ].join("\n")
    : "";
  const agentPrompt = `${prompt}${screenshotNote}`;
  await addProgress("Starting OpenCode agent.", "Starting agent", true);
  try {
    await new Promise<void>((resolve, reject) => {
      const args = [
        "run",
        "--dir", worktreePath,
        "--agent", "build",
        "--model", process.env.OPENCODE_AGENT_MODEL?.trim() || "openrouter/deepseek/deepseek-v4.1-flash-1017",
        "--format", "json",
        "--auto",
        "--title", `CrawlSEO ${task.id}`,
        agentPrompt,
      ];
      for (const screenshot of screenshots) args.push("-f", screenshot.file);
      const child = spawn(
        "opencode",
        args,
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
      let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
      let maxRuntimeTimer: ReturnType<typeof setTimeout> | null = null;
      let finished = false;
      const clearTimers = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
        inactivityTimer = null;
        maxRuntimeTimer = null;
      };
      const finish = (fn: () => void) => {
        if (finished) return;
        finished = true;
        clearTimers();
        fn();
      };
      const resetInactivity = () => {
        if (finished) return;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          child.kill("SIGTERM");
          finish(() => reject(new Error(
            `Agent produced no output for ${Math.round(timeouts.inactivityMs / 60_000)} minutes; stopped as inactive.`,
          )));
        }, timeouts.inactivityMs);
      };
      resetInactivity();
      maxRuntimeTimer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new Error(
          `Agent exceeded the maximum runtime of ${Math.round(timeouts.maxRuntimeMs / 60_000)} minutes.`,
        )));
      }, timeouts.maxRuntimeMs);
      child.once("error", (error) => finish(() => reject(error)));
      child.stdout?.on("data", (chunk: Buffer) => {
        resetInactivity();
        const text = chunk.toString("utf8");
        agentOutput = (agentOutput + text).slice(-1_000_000);
        outputBuffer += text;
        const lines = outputBuffer.split(/\r?\n/);
        outputBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const message = progressLineForEvent(line);
          if (message) void addProgress(message);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        resetInactivity();
        agentErrorOutput = (agentErrorOutput + chunk.toString("utf8")).slice(-200_000);
      });
      child.once("close", (code) => finish(() => {
        if (code === 0) resolve();
        else reject(new Error(`Agent process exited with code ${code ?? "unknown"}`));
      }));
    });

    if (outputBuffer.trim()) {
      const message = progressLineForEvent(outputBuffer);
      if (message) await addProgress(message);
    }
    await addProgress("Agent process finished. Capturing diff.", "Capturing diff", true);

    // Include new files in the review diff. Without this, an agent that only
    // creates a script appears to have made no changes.
    await execFileAsync("git", ["-C", worktreePath, "add", "--intent-to-add", "-A"], {
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    }).catch(() => undefined);

    const [diff, status] = await Promise.all([
      execFileAsync("git", ["-C", worktreePath, "diff", "--", "."], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }),
      execFileAsync("git", ["-C", worktreePath, "status", "--short", "--untracked-files=all"], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }),
    ]);

    const files = parseGitStatusFiles(status.stdout);
    const releaseableFiles = files.filter(isReleaseableSiteFile);
    const outcome = agentChangeOutcome(files);
    const diffBytes = Buffer.byteLength(diff.stdout);
    const agentText = agentTextFromOutput(agentOutput);
    const summary = agentText.slice(0, 20_000);
    const outcomeMessage = outcome === "no_changes"
      ? "No files changed. The agent did not produce a reviewable change."
      : `${files.length} file${files.length === 1 ? "" : "s"} changed (${releaseableFiles.length} releaseable site-code file${releaseableFiles.length === 1 ? "" : "s"}, ${formatBytes(diffBytes)} diff). Not committed or pushed.`;

    await addAgentArtifact(task.id, { kind: "diff", content: diff.stdout });
    await addAgentArtifact(task.id, { kind: "git_status", content: status.stdout });
    if (agentOutput.trim()) {
      await addAgentArtifact(task.id, { kind: "agent_output", content: agentOutput.slice(0, 200_000) });
    }
    if (agentErrorOutput.trim()) {
      await addAgentArtifact(task.id, { kind: "agent_stderr", content: agentErrorOutput.slice(0, 100_000) });
    }
    await createPreviewArtifact(task.id, worktreePath, status.stdout, task.route).catch(() => undefined);
    if (agentText) {
      await addAgentMessage(task.id, agentText.slice(0, 12_000), "AGENT");
    }
    await addProgress(outcomeMessage, "Review ready", true);

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
          result: {
            worktreePath,
            branch,
            diffBytes,
            changedFiles: files.length,
            files,
            releaseableFiles,
            outcome: "escaped_worktree",
            summary,
            screenshots,
            repoBefore,
            repoAfter,
            progress: { ...progress, stage: "Agent escaped the worktree" },
          },
          completedAt: null,
        },
      });
    }

    if (outcome === "no_changes" && !diff.stdout.trim()) {
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
          result: {
            worktreePath,
            branch,
            diffBytes,
            changedFiles: files.length,
            files,
            releaseableFiles,
            outcome: "no_changes",
            summary,
            screenshots,
            progress: { ...progress, stage: "No changes produced" },
          },
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
          diffBytes,
          changedFiles: files.length,
          files,
          releaseableFiles,
          outcome,
          summary,
          screenshots,
          progress: { ...progress, stage: "Review ready" },
        },
        completedAt: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent run failed";
    await addProgress(`Agent failed: ${message.slice(0, 240)}`, "Failed", true).catch(() => undefined);
    await addAgentMessage(task.id, `Agent run failed: ${message.slice(0, 1_000)}`, "SYSTEM").catch(() => undefined);
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: "FAILED", errorCode: message.slice(0, 120), completedAt: new Date() },
    });
    throw error;
  }
}
