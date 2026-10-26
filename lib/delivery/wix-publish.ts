import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REVISION_URL = "https://editor.wix.com/_serverless/typok/v1/site-revision";

type ExecResult = { stdout: string; stderr: string };
export type RunCommand = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<ExecResult>;

type WixConfig = {
  siteId: string;
  uiVersion: string;
  [key: string]: unknown;
};

export type SiteRevision = {
  revision: string;
  number: number;
};

export type SyncRevisionResult = {
  changed: boolean;
  previousRevision: string | null;
  revision: SiteRevision;
  commitSha: string;
};

export type PublicationResult = {
  codeSha: string;
  releaseSha: string;
  revisionBefore: SiteRevision;
  revisionPublished: SiteRevision;
  revisionAfter: SiteRevision;
  previewUrl: string | null;
  output: string;
};

export class WixPublicationOutcomeUnknown extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WixPublicationOutcomeUnknown";
  }
}

export function siteRevisionFromPayload(payload: unknown): SiteRevision {
  const raw = (payload as { siteRevision?: { revision?: unknown } } | null)?.siteRevision?.revision;
  const revision = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  const number = Number(revision);
  if (!revision || !Number.isSafeInteger(number) || number < 0) {
    throw new Error("Wix did not return a valid site revision");
  }
  return { revision, number };
}

export async function getWixSiteRevision(
  siteId: string,
  options: {
    run?: RunCommand;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): Promise<SiteRevision> {
  const run = options.run ?? execFileAsync;
  const env = options.env ?? process.env;
  const wix = env.WIX_CLI_BIN || "wix";
  const tokenResult = await run(wix, ["token", "-s", siteId], {
    cwd: options.cwd,
    env,
    timeout: 30_000,
  });
  const token = tokenResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  if (!token) throw new Error(`Wix CLI did not return a site token for ${siteId}`);

  const response = await (options.fetchImpl ?? fetch)(REVISION_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "wix-cli",
      "X-XSRF-TOKEN": "nocheck",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Wix site revision lookup failed with HTTP ${response.status}`);
  }
  return siteRevisionFromPayload(await response.json());
}

export async function readWixConfig(repoPath: string): Promise<WixConfig> {
  const configPath = path.join(repoPath, "wix.config.json");
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as Partial<WixConfig>;
  if (typeof parsed.siteId !== "string" || !parsed.siteId) {
    throw new Error("wix.config.json is missing its siteId");
  }
  if (typeof parsed.uiVersion !== "string" || !/^\d+$/.test(parsed.uiVersion)) {
    throw new Error("wix.config.json is missing a numeric uiVersion");
  }
  return parsed as WixConfig;
}

async function git(repoPath: string, args: string[], run: RunCommand = execFileAsync): Promise<string> {
  const result = await run("git", ["-C", repoPath, ...args], {
    timeout: 120_000,
    env: process.env,
  });
  return result.stdout.trim();
}

export async function assertCleanReleaseCommit(repoPath: string, gitSha: string, run: RunCommand = execFileAsync) {
  const status = await git(repoPath, ["status", "--porcelain"], run);
  if (status) throw new Error(`Site repository is not clean: ${status.split(/\r?\n/)[0]}`);
  const head = await git(repoPath, ["rev-parse", "HEAD"], run);
  if (head !== gitSha) throw new Error(`Release commit ${gitSha} is not the repository HEAD`);
  const remote = await git(repoPath, ["rev-parse", "origin/main"], run);
  if (remote !== gitSha) throw new Error("Release commit has not been pushed to origin/main");
}

export async function syncWixUiVersion(input: {
  repoPath: string;
  siteId: string;
  getRevision?: (siteId: string) => Promise<SiteRevision>;
  run?: RunCommand;
}): Promise<SyncRevisionResult> {
  const run = input.run ?? execFileAsync;
  const getRevision = input.getRevision ?? ((siteId: string) => getWixSiteRevision(siteId));
  const revision = await getRevision(input.siteId);
  const config = await readWixConfig(input.repoPath);
  if (config.siteId !== input.siteId) {
    throw new Error(`wix.config.json siteId ${config.siteId} does not match release site ${input.siteId}`);
  }

  const current = await git(input.repoPath, ["rev-parse", "HEAD"], run);
  if (config.uiVersion === revision.revision) {
    return { changed: false, previousRevision: config.uiVersion, revision, commitSha: current };
  }

  const previousRevision = config.uiVersion;
  const next = { ...config, uiVersion: revision.revision };
  await writeFile(
    path.join(input.repoPath, "wix.config.json"),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
  await git(input.repoPath, ["add", "wix.config.json"], run);
  await git(
    input.repoPath,
    ["commit", "-m", `chore: sync Wix UI revision to ${revision.revision}`],
    run,
  );
  await git(input.repoPath, ["push", "origin", "main"], run);
  const commitSha = await git(input.repoPath, ["rev-parse", "HEAD"], run);
  return { changed: true, previousRevision, revision, commitSha };
}

export async function publishWixSite(input: {
  repoPath: string;
  siteId: string;
  gitSha: string;
  getRevision?: (siteId: string) => Promise<SiteRevision>;
  run?: RunCommand;
  publish?: (context: { repoPath: string; revision: string; env: NodeJS.ProcessEnv }) => Promise<ExecResult>;
}): Promise<PublicationResult> {
  const run = input.run ?? execFileAsync;
  const getRevision = input.getRevision ?? ((siteId: string) => getWixSiteRevision(siteId));
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1" };

  await assertCleanReleaseCommit(input.repoPath, input.gitSha, run);
  const revisionBefore = await getRevision(input.siteId);
  const synced = await syncWixUiVersion({
    repoPath: input.repoPath,
    siteId: input.siteId,
    getRevision: async () => revisionBefore,
    run,
  });
  const releaseSha = synced.commitSha;
  const releaseHead = await git(input.repoPath, ["rev-parse", "HEAD"], run);
  const releaseRemote = await git(input.repoPath, ["rev-parse", "origin/main"], run);
  if (releaseHead !== releaseRemote) {
    throw new Error("The Wix UI revision commit has not been pushed to origin/main");
  }

  // Publishing does not create a new UI version; only saving design changes does.
  // Re-read immediately before publishing so a concurrent Editor save cannot make
  // this transaction publish an older design over the newer one.
  const revisionGate = await getRevision(input.siteId);
  if (revisionGate.number !== revisionBefore.number) {
    throw new Error(
      `The Wix editor revision changed during release (${revisionBefore.revision} -> ${revisionGate.revision}); retry the release`,
    );
  }

  const publish = input.publish ?? ((context) => run(
    env.WIX_CLI_BIN || "wix",
    ["publish", "--source", "remote", "-y"],
    { cwd: context.repoPath, env: context.env, timeout: 300_000 },
  ));
  try {
    const published = await publish({
      repoPath: input.repoPath,
      revision: revisionBefore.revision,
      env,
    });

    const reported = published.stdout.match(/UI version:\s*(\d+)/i)?.[1];
    if (reported && reported !== revisionBefore.revision) {
      throw new Error(`Wix published UI version ${reported}, expected ${revisionBefore.revision}`);
    }
    if (!reported) throw new Error("Wix publish did not report the UI version it used");
    if (!/published successfully|site has been published/i.test(published.stdout)) {
      throw new Error("Wix publish did not return a successful publication result");
    }
    if (/newer design changes/i.test(published.stdout)) {
      throw new Error("Wix reported a concurrent editor revision during publish; the release may have published an older UI version.");
    }

    const revisionAfter = await getRevision(input.siteId);
    if (revisionAfter.number < revisionBefore.number) {
      throw new Error(`The Wix site revision moved backwards during publish (before ${revisionBefore.revision}, after ${revisionAfter.revision})`);
    }

    const previewUrl = published.stdout.match(/https:\/\/wix\.to\/[A-Za-z0-9]+/)?.[0] ?? null;
    return {
      codeSha: input.gitSha,
      releaseSha,
      revisionBefore,
      revisionPublished: revisionBefore,
      revisionAfter,
      previewUrl,
      output: published.stdout,
    };
  } catch (error) {
    throw new WixPublicationOutcomeUnknown(error instanceof Error ? error.message : "Wix publication outcome is unknown");
  }
}
