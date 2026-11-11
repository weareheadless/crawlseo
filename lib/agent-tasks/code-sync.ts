import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Keeping the site repository in step with what was delivered.
 *
 * A page delivery writes its component source and navigation edit into the
 * site checkout, but the live page is served by the bridge. Without a commit
 * and push GitHub stops being the source of truth, and the next person to edit
 * the repository silently reverts the delivered page.
 *
 * Only the files the delivery itself wrote are committed. Anything else in the
 * checkout belongs to someone else and is left alone.
 */
export type CodeSyncResult = {
  status: "pushed" | "nothing" | "skipped" | "failed";
  files: string[];
  commitSha?: string;
  reason?: string;
};

/** Files inside the repository, de-duplicated, as repository-relative paths. */
export function pushableFiles(repoPath: string, files: Array<string | null | undefined>): string[] {
  const root = path.resolve(repoPath);
  const seen = new Set<string>();
  const pushable: string[] = [];
  for (const file of files) {
    if (!file) continue;
    const relative = path.relative(root, path.resolve(root, file));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const normalized = relative.split(path.sep).join("/");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    pushable.push(normalized);
  }
  return pushable;
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repoPath, "merge-base", "--is-ancestor", ancestor, descendant], {
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function commitAndPushFiles(
  repoPath: string,
  files: Array<string | null | undefined>,
  message: string,
): Promise<CodeSyncResult> {
  const pushable = pushableFiles(repoPath, files);
  if (pushable.length === 0) return { status: "nothing", files: [] };

  const branch = (await execFileAsync("git", ["-C", repoPath, "branch", "--show-current"], { timeout: 30_000 }))
    .stdout.trim();
  if (branch !== "main") {
    return { status: "skipped", files: pushable, reason: `the site repository is on ${branch || "a detached head"}` };
  }

  // Compare against the real remote, not a stale local ref. A previous
  // delivery may have committed locally and failed before the push; the next
  // sync must carry that commit rather than report "nothing" because the
  // worktree happens to be clean.
  try {
    await execFileAsync("git", ["-C", repoPath, "fetch", "origin", "main"], { timeout: 60_000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "fetch failed";
    return { status: "failed", files: pushable, reason: `could not refresh origin/main: ${detail.slice(-400)}` };
  }
  const rev = async (value: string) => (await execFileAsync(
    "git", ["-C", repoPath, "rev-parse", value], { timeout: 30_000 },
  )).stdout.trim();
  const remote = await rev("origin/main");
  let commitSha = await rev("HEAD");

  const status = await execFileAsync(
    "git",
    ["-C", repoPath, "status", "--porcelain", "--", ...pushable],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
  );
  if (status.stdout.trim()) {
    // Never commit the delivery on top of a base that has moved away from
    // origin/main; that would produce a push that cannot fast-forward.
    if (commitSha !== remote && !(await isAncestor(repoPath, remote, commitSha))) {
      return {
        status: "skipped",
        files: pushable,
        reason: "the site repository is behind or diverged from origin/main; reconcile it before delivering",
      };
    }
    await execFileAsync("git", ["-C", repoPath, "add", "--", ...pushable], { timeout: 60_000 });
    // Commit only these paths: another session may have staged other work, and
    // publishing this page must not sweep it in.
    await execFileAsync("git", ["-C", repoPath, "commit", "-m", message.slice(0, 200), "--", ...pushable], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    commitSha = await rev("HEAD");
  }

  if (commitSha === remote) return { status: "nothing", files: pushable, commitSha };
  if (!(await isAncestor(repoPath, remote, commitSha))) {
    return {
      status: "skipped",
      files: pushable,
      commitSha,
      reason: "the site repository is behind or diverged from origin/main; reconcile it before delivering",
    };
  }

  // Only push a delivery commit, never someone else's unpushed work. The
  // unpushed range must contain nothing outside the files this delivery wrote.
  const changed = (await execFileAsync(
    "git", ["-C", repoPath, "diff", "--name-only", `${remote}..${commitSha}`],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
  )).stdout.split(/\r?\n/).filter(Boolean);
  const unrelated = changed.filter((file) => !pushable.includes(file));
  if (unrelated.length > 0) {
    return {
      status: "skipped",
      files: pushable,
      commitSha,
      reason: `the site repository has unpushed changes outside this delivery: ${unrelated.slice(0, 5).join(", ")}`,
    };
  }

  try {
    await execFileAsync("git", ["-C", repoPath, "push", "origin", "HEAD:main"], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "push failed";
    return { status: "failed", files: pushable, commitSha, reason: detail.slice(-400) };
  }
  return { status: "pushed", files: pushable, commitSha };
}
