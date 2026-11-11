import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { addAgentArtifact } from "@/lib/agent-tasks/chat";
loadEnvConfig(process.cwd());

function runAgent(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", args, { cwd, env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", (chunk) => { err += String(chunk); });
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`agent exited ${code}: ${err.slice(-500)}`)));
  });
}

async function main() {
  const db = new PrismaClient();
  const taskId = "cmwbbs06o0003oy5oycqtsmz5";
  const task = await db.agentTask.findUnique({ where: { id: taskId }, select: { siteId: true } });
  const notes = await db.agentTaskArtifact.findFirst({ where: { taskId, kind: "navigation_notes" }, orderBy: { createdAt: "desc" }, select: { content: true } });
  const config = await db.siteDeliveryConfig.findUnique({ where: { siteId: task!.siteId }, select: { repoPath: true } });
  if (!notes?.content || !config?.repoPath) throw new Error("missing notes or repo");
  const directory = path.join("/tmp/opencode", `nav-${taskId}`);
  await mkdir(directory, { recursive: true });
  const prompt = `You are applying one navigation edit to a Wix site repository.

REPOSITORY (read-only): ${config.repoPath}
TARGET FILE: src/public/custom-elements/atelier-navbar-v1.js

The page task chose this edit:
${notes.content}

Read the target file, apply exactly that edit, and write the complete edited file as navigation.js in the current directory. Do not modify the repository. Keep every existing link, style and behaviour; add only the new link and its English label in the translation dictionary.

Then write navigation.md whose first line is exactly:
TARGET: src/public/custom-elements/atelier-navbar-v1.js
followed by a short summary of what changed.`;
  const output = await runAgent([
    "run", "--agent", "build",
    "--model", process.env.OPENCODE_AGENT_MODEL?.trim() || "openrouter/deepseek/deepseek-v4.1-flash-1017",
    "--format", "json", "--auto", "--title", `CrawlSEO navigation ${taskId}`, prompt,
  ], directory);
  const source = await readFile(path.join(directory, "navigation.js"), "utf8").catch(() => "");
  const md = await readFile(path.join(directory, "navigation.md"), "utf8").catch(() => "");
  console.log({ sourceBytes: source.length, mdBytes: md.length, tail: output.slice(-300) });
  if (source.trim()) await addAgentArtifact(taskId, { kind: "navigation_source", content: source.slice(0, 400_000) });
  if (md.trim()) await addAgentArtifact(taskId, { kind: "navigation_notes", content: md.slice(0, 20_000) });
  await db.$disconnect();
}
void main();
