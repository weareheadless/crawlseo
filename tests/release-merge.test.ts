import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeAndPush } from "@/lib/agent-tasks/release";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-merge-test-"));
  roots.push(root);
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  git(root, "init", "--bare", "-b", "main", remote);
  git(root, "init", "-b", "main", repo);
  git(repo, "config", "user.email", "release-test@example.invalid");
  git(repo, "config", "user.name", "Release Test");
  await writeFile(path.join(repo, "wix.config.json"), "{\"siteId\":\"site-123\",\"uiVersion\":\"729\"}\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  return { repo, remote };
}

describe("release merge", () => {
  it("merges a task commit even after main advanced with a UI revision commit", async () => {
    const { repo } = await fixture();
    const base = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "-b", "agent/task");
    await writeFile(path.join(repo, "task.js"), "export const task = true;\n");
    git(repo, "add", "task.js");
    git(repo, "commit", "-m", "task");
    const taskSha = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "main");
    await writeFile(path.join(repo, "wix.config.json"), "{\"siteId\":\"site-123\",\"uiVersion\":\"848\"}\n");
    git(repo, "add", "wix.config.json");
    git(repo, "commit", "-m", "sync UI revision");
    git(repo, "push", "origin", "main");
    const configSha = git(repo, "rev-parse", "HEAD");

    const releaseSha = await mergeAndPush(repo, taskSha);

    expect(releaseSha).not.toBe(taskSha);
    expect(() => git(repo, "merge-base", "--is-ancestor", base, "HEAD")).not.toThrow();
    expect(() => git(repo, "merge-base", "--is-ancestor", taskSha, "HEAD")).not.toThrow();
    expect(() => git(repo, "merge-base", "--is-ancestor", configSha, "HEAD")).not.toThrow();
    expect(git(repo, "rev-parse", "origin/main")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(repo, "status", "--porcelain")).toBe("");

    const again = await mergeAndPush(repo, taskSha);
    expect(again).toBe(releaseSha);
  });
});
