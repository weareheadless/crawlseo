import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getWixSiteRevision,
  publishWixSite,
  siteRevisionFromPayload,
  syncWixUiVersion,
  WixPublicationOutcomeUnknown,
} from "@/lib/delivery/wix-publish";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function gitFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wix-publish-test-"));
  roots.push(root);
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  git(root, "init", "--bare", "-b", "main", remote);
  await mkdir(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "publish-test@example.invalid");
  git(repo, "config", "user.name", "Publish Test");
  await writeFile(
    path.join(repo, "wix.config.json"),
    `${JSON.stringify({ siteId: "site-123", uiVersion: "729" }, null, 2)}\n`,
  );
  git(repo, "add", "wix.config.json");
  git(repo, "commit", "-m", "initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  return { root, remote, repo };
}

function revision(number: number) {
  return { revision: String(number), number };
}

describe("Wix site revision", () => {
  it("reads the site-scoped token and parses the current revision", async () => {
    const result = await getWixSiteRevision("site-123", {
      run: async () => ({ stdout: "ignored\nOauthNG.test-token\n", stderr: "" }),
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ siteRevision: { revision: "848" } }),
      })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ revision: "848", number: 848 });
  });

  it("rejects a revision response that is not a safe integer", () => {
    expect(() => siteRevisionFromPayload({ siteRevision: { revision: "not-a-number" } })).toThrow(
      /valid site revision/,
    );
  });
});

describe("Wix UI revision synchronization", () => {
  it("commits and pushes a stale UI revision before publish", async () => {
    const { remote, repo } = await gitFixture();
    const result = await syncWixUiVersion({
      repoPath: repo,
      siteId: "site-123",
      getRevision: async () => revision(848),
    });

    expect(result.changed).toBe(true);
    expect(result.previousRevision).toBe("729");
    expect(result.revision.revision).toBe("848");
    expect(JSON.parse(await readFile(path.join(repo, "wix.config.json"), "utf8")).uiVersion).toBe("848");
    expect(git(repo, "log", "-1", "--pretty=%s")).toContain("sync Wix UI revision to 848");
    expect(git(remote, "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"));

    const second = await syncWixUiVersion({
      repoPath: repo,
      siteId: "site-123",
      getRevision: async () => revision(848),
    });
    expect(second.changed).toBe(false);
  });
});

describe("Wix publication transaction", () => {
  it("labels a lost publish response as unknown rather than retryable failure", async () => {
    const { repo } = await gitFixture();
    const codeSha = git(repo, "rev-parse", "HEAD");
    await expect(publishWixSite({
      repoPath: repo,
      siteId: "site-123",
      gitSha: codeSha,
      getRevision: async () => revision(848),
      publish: async () => { throw new Error("connection reset after request"); },
    })).rejects.toBeInstanceOf(WixPublicationOutcomeUnknown);
  });

  it("syncs the UI revision, publishes remote code, and requires a new site revision", async () => {
    const { repo } = await gitFixture();
    const codeSha = git(repo, "rev-parse", "HEAD");
    const revisions = [revision(848), revision(848), revision(848)];
    let call = 0;
    const received: Array<{ repoPath: string; revision: string; env: NodeJS.ProcessEnv }> = [];

    const result = await publishWixSite({
      repoPath: repo,
      siteId: "site-123",
      gitSha: codeSha,
      getRevision: async () => revisions[call++],
      publish: async (context) => {
        received.push(context);
        return {
          stdout: `UI version: ${context.revision}\nYour site has been published successfully: https://www.example.com/`,
          stderr: "",
        };
      },
    });

    expect(received[0]?.repoPath).toBe(repo);
    expect(received[0]?.revision).toBe("848");
    expect(received[0]?.env.CI).toBe("1");
    expect(result.codeSha).toBe(codeSha);
    expect(result.releaseSha).not.toBe(codeSha);
    expect(result.revisionBefore.revision).toBe("848");
    expect(result.revisionAfter.revision).toBe("848");
    expect(JSON.parse(await readFile(path.join(repo, "wix.config.json"), "utf8")).uiVersion).toBe("848");
  });

  it("allows a successful publish when the UI version is unchanged", async () => {
    const { repo } = await gitFixture();
    const codeSha = git(repo, "rev-parse", "HEAD");
    const revisions = [revision(848), revision(848), revision(848)];
    let call = 0;

    const result = await publishWixSite({
      repoPath: repo,
      siteId: "site-123",
      gitSha: codeSha,
      getRevision: async () => revisions[call++],
      publish: async () => ({
        stdout: "UI version: 848\nYour site has been published successfully",
        stderr: "",
      }),
    });
    expect(result.revisionBefore.revision).toBe("848");
    expect(result.revisionAfter.revision).toBe("848");
  });

  it("fails before publishing if the editor revision changes during the release", async () => {
    const { repo } = await gitFixture();
    const codeSha = git(repo, "rev-parse", "HEAD");
    const revisions = [revision(848), revision(849)];
    let call = 0;
    let published = false;

    await expect(publishWixSite({
      repoPath: repo,
      siteId: "site-123",
      gitSha: codeSha,
      getRevision: async () => revisions[call++],
      publish: async () => {
        published = true;
        return { stdout: "UI version: 848\nYour site has been published successfully", stderr: "" };
      },
    })).rejects.toThrow(/editor revision changed during release/);
    expect(published).toBe(false);
  });

  it("fails if the site revision moves backwards during publish", async () => {
    const { repo } = await gitFixture();
    const codeSha = git(repo, "rev-parse", "HEAD");
    const revisions = [revision(848), revision(848), revision(847)];
    let call = 0;

    await expect(publishWixSite({
      repoPath: repo,
      siteId: "site-123",
      gitSha: codeSha,
      getRevision: async () => revisions[call++],
      publish: async () => ({
        stdout: "UI version: 848\nYour site has been published successfully",
        stderr: "",
      }),
    })).rejects.toThrow(/moved backwards/);
  });

  it("fails when Wix warns that the editor has a newer design version", async () => {
    const { repo } = await gitFixture();
    const codeSha = git(repo, "rev-parse", "HEAD");
    const revisions = [revision(848), revision(848)];
    let call = 0;

    await expect(publishWixSite({
      repoPath: repo,
      siteId: "site-123",
      gitSha: codeSha,
      getRevision: async () => revisions[call++],
      publish: async () => ({
        stdout: "UI version: 848\nCaution: The Editor contains newer design changes.\nYour site has been published successfully",
        stderr: "",
      }),
    })).rejects.toThrow(/concurrent editor revision/);
  });

  it("fails when Wix reports a different UI version than the synchronized one", async () => {
    const { repo } = await gitFixture();
    const codeSha = git(repo, "rev-parse", "HEAD");
    const revisions = [revision(848), revision(848)];
    let call = 0;

    await expect(publishWixSite({
      repoPath: repo,
      siteId: "site-123",
      gitSha: codeSha,
      getRevision: async () => revisions[call++],
      publish: async () => ({
        stdout: "UI version: 729\nYour site has been published successfully",
        stderr: "",
      }),
    })).rejects.toThrow(/expected 848/);
  });
});
