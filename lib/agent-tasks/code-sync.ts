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

  const status = await execFileAsync(
    "git",
    ["-C", repoPath, "status", "--porcelain", "--", ...pushable],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
  );
  if (!status.stdout.trim()) return { status: "nothing", files: pushable };

  await execFileAsync("git", ["-C", repoPath, "add", "--", ...pushable], { timeout: 60_000 });
  // Commit only these paths: another session may have staged other work, and
  // publishing this page must not sweep it in.
  await execFileAsync("git", ["-C", repoPath, "commit", "-m", message.slice(0, 200), "--", ...pushable], {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const commitSha = (await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"], { timeout: 30_000 }))
    .stdout.trim();

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
