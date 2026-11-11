import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { commitAndPushFiles, pushableFiles } from "@/lib/agent-tasks/code-sync";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-sync-test-"));
  roots.push(root);
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  git(root, "init", "--bare", "-b", "main", remote);
  git(root, "init", "-b", "main", repo);
  git(repo, "config", "user.email", "code-sync@example.invalid");
  git(repo, "config", "user.name", "Code Sync Test");
  await writeFile(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  return { repo, remote };
}

describe("pushing what a delivery wrote", () => {
  it("commits only the named files and pushes them to origin", async () => {
    const { repo, remote } = await fixture();
    await writeFile(path.join(repo, "page.js"), "export const page = 1;\n");
    await writeFile(path.join(repo, "someone-else.txt"), "not ours\n");

    const result = await commitAndPushFiles(repo, ["page.js"], "CrawlSEO: page");

    expect(result.status).toBe("pushed");
    expect(result.files).toEqual(["page.js"]);
    // The other working-tree file is left alone, not swept into the commit.
    expect(git(repo, "status", "--porcelain")).toContain("someone-else.txt");
    expect(git(remote, "show", "main:page.js")).toBe("export const page = 1;");
  });

  it("reports nothing to do when the delivered file is unchanged", async () => {
    const { repo } = await fixture();
    await writeFile(path.join(repo, "page.js"), "export const page = 1;\n");
    expect((await commitAndPushFiles(repo, ["page.js"], "first")).status).toBe("pushed");
    expect((await commitAndPushFiles(repo, ["page.js"], "again")).status).toBe("nothing");
  });

  it("pushes a delivery commit that a previous run committed but never pushed", async () => {
    const { repo, remote } = await fixture();
    await writeFile(path.join(repo, "page.js"), "export const page = 1;\n");
    git(repo, "add", "page.js");
    git(repo, "commit", "-m", "CrawlSEO: page");
    const deliveryCommit = git(repo, "rev-parse", "HEAD");
    expect(git(remote, "rev-parse", "main")).not.toBe(deliveryCommit);

    // The worktree is clean; the only remaining work is the push.
    const result = await commitAndPushFiles(repo, ["page.js"], "CrawlSEO: page");

    expect(result.status).toBe("pushed");
    expect(result.commitSha).toBe(deliveryCommit);
    expect(git(remote, "rev-parse", "main")).toBe(deliveryCommit);
    expect(git(remote, "show", "main:page.js")).toBe("export const page = 1;");
  });

  it("refuses to push unpushed work that is not part of this delivery", async () => {
    const { repo, remote } = await fixture();
    const base = git(repo, "rev-parse", "HEAD");
    await writeFile(path.join(repo, "page.js"), "export const page = 1;\n");
    await writeFile(path.join(repo, "someone-else.txt"), "not ours\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "local work from another session");

    const result = await commitAndPushFiles(repo, ["page.js"], "CrawlSEO: page");

    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("someone-else.txt");
    expect(git(remote, "rev-parse", "main")).toBe(base);
  });

  it("does not commit onto a base that is behind origin/main", async () => {
    const { repo, remote } = await fixture();
    const other = path.join(path.dirname(repo), "other");
    git(path.dirname(repo), "clone", remote, other);
    git(other, "config", "user.email", "other@example.invalid");
    git(other, "config", "user.name", "Other Session");
    await writeFile(path.join(other, "landing.js"), "export const landing = 1;\n");
    git(other, "add", "landing.js");
    git(other, "commit", "-m", "someone else's page");
    git(other, "push", "origin", "main");

    await writeFile(path.join(repo, "page.js"), "export const page = 1;\n");
    const result = await commitAndPushFiles(repo, ["page.js"], "CrawlSEO: page");

    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("behind or diverged");
    expect(git(remote, "show", "main:landing.js")).toBe("export const landing = 1;");
  });

  it("refuses paths outside the repository and duplicate paths", async () => {
    const { repo } = await fixture();
    expect(pushableFiles(repo, ["../escape.js", "/etc/passwd", "page.js", "./page.js", null])).toEqual(["page.js"]);
  });

  it("does not push from a branch other than main", async () => {
    const { repo } = await fixture();
    git(repo, "checkout", "-b", "agent/x");
    await writeFile(path.join(repo, "page.js"), "export const page = 1;\n");
    const result = await commitAndPushFiles(repo, ["page.js"], "CrawlSEO: page");
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("agent/x");
  });
});
