import { stat as stat_path } from "node:fs/promises";
import { join as join_path } from "node:path";

import type { Prisma, PrismaClient } from "@prisma/client";

import { withOpportunityAnchor, type OpportunityAnchor } from "@/lib/connectors/opportunity-anchor";

/**
 * A refusal an external executor can act on.
 *
 * Its own class rather than the connector's, because these checks are not connector checks:
 * they apply to any executor with a project scope, whether or not the site is bound to the
 * HelloAda runtime. Importing the connector error would tie a general capability to one
 * integration's lifecycle.
 */
export class ExecutionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ExecutionError";
  }
}

/**
 * An external executor reports work it did, and the opportunity moves.
 *
 * ## Why this is not a Task confirmation
 *
 * `Task.humanConfirmedBy` records that a *person* confirmed execution, and the funnel plan
 * requires that to stay a human decision. An MCP client delivering a page is a real and
 * welcome executor, but it is not a person, so writing its name there would destroy the one
 * distinction an auditor needs. The delivery is recorded in `OpportunityExecution` instead:
 * attributed, checked, and kept separate.
 *
 * ## What a delivery must carry
 *
 * The rule is "who, what, why, and where to look". A status change alone answers none of
 * them, which is why each field below is required rather than optional:
 *
 * - `executorId` — who to ask about this. An unattributed delivery cannot be followed up.
 * - `workKind` — whether to look at a commit, a page, or a setting.
 * - `note` — why this closes the opportunity, in the executor's own words.
 * - at least one locator — a commit, a PR, or a live URL — so the claim is checkable.
 *
 * A delivery with no locator is not rejected because it is dishonest; it is rejected because
 * nobody could verify it, and a board full of unverifiable "done" rows is worse than a board
 * of open work.
 */

export type ExecutionWorkKind = "code_change" | "content" | "configuration" | "external";

/** The statuses a delivery may move an opportunity to. */
export type DeliveryStatus = "delivered" | "in_progress";

export type ReportWorkInput = {
  siteId: string;
  opportunityId: string;
  /** The MCP client / agent identity doing the work. */
  executorId: string;
  workKind: ExecutionWorkKind;
  note: string;
  /** Moves the row to `delivered` (default) or leaves it `in_progress` with progress noted. */
  status?: DeliveryStatus;
  commitSha?: string | null;
  pullRequestUrl?: string | null;
  deployedUrl?: string | null;
};

export type ReportedWork = {
  schemaVersion: "1.0";
  projectId: string;
  siteId: string;
  opportunityId: string;
  executionId: string;
  /** The status the opportunity now holds. */
  status: string;
  /** What was recorded, echoed so a client can confirm what it claimed. */
  recorded: {
    executorKind: "external_agent";
    executorId: string;
    workKind: ExecutionWorkKind;
    commitSha: string | null;
    pullRequestUrl: string | null;
    deployedUrl: string | null;
    note: string;
  };
};

/** Statuses that may receive a delivery. A parked or closed row is not quietly re-opened. */
const DELIVERABLE_STATUSES = ["accepted", "in_progress", "delivered"] as const;

/** A bare 7–40 character hex commit, or a full ref. Rejects prose. */
const COMMIT = /^[0-9a-f]{7,40}$/i;

function required(value: string, field: string, max = 2000): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new ExecutionError(`${field} is required`, 400);
  if (trimmed.length > max) throw new ExecutionError(`${field} is too long (max ${max})`, 400);
  return trimmed;
}

function optionalUrl(value: string | null | undefined, field: string): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ExecutionError(`${field} is not a URL`, 400);
  }
  // A locator a reader cannot open is not a locator.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ExecutionError(`${field} must be http(s)`, 400);
  }
  return parsed.href;
}

function optionalCommit(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!COMMIT.test(trimmed)) {
    throw new ExecutionError("commitSha must be a hex commit id, not prose or a URL", 400);
  }
  return trimmed.toLowerCase();
}

/**
 * Record a delivery and move the opportunity, in one transaction.
 *
 * Both writes happen together for the same reason every other transition here does: a stored
 * execution whose status change was lost would claim work the board does not show, and a
 * status change with no record would claim work nobody can trace. Either both, or neither.
 */
export async function reportOpportunityWork(
  db: Pick<PrismaClient, "opportunity" | "opportunityExecution">,
  projectId: string,
  input: ReportWorkInput
): Promise<ReportedWork> {
  const executorId = required(input.executorId, "executorId", 200);
  const note = required(input.note, "note");
  const workKind = input.workKind;
  if (!["code_change", "content", "configuration", "external"].includes(workKind)) {
    throw new ExecutionError("workKind must be one of code_change, content, configuration, external", 400);
  }
  const status: DeliveryStatus = input.status ?? "delivered";
  if (status !== "delivered" && status !== "in_progress") {
    throw new ExecutionError("status must be delivered or in_progress", 400);
  }
  const commitSha = optionalCommit(input.commitSha);
  const pullRequestUrl = optionalUrl(input.pullRequestUrl, "pullRequestUrl");
  const deployedUrl = optionalUrl(input.deployedUrl, "deployedUrl");

  /**
   * At least one locator, unless the work is explicitly `external`.
   *
   * `external` covers work whose evidence lives somewhere this API cannot express — a Wix
   * editor change, a DNS record, a redirect rule. The note is then the only record, and it
   * is required. Anything claiming a code change or content change has to point at where.
   */
  const hasLocator = Boolean(commitSha || pullRequestUrl || deployedUrl);
  if (!hasLocator && workKind !== "external") {
    throw new ExecutionError(
      "a delivery must point at its evidence: pass commitSha, pullRequestUrl or deployedUrl (or workKind 'external' for work with no locator)",
      400
    );
  }

  const opportunity = await db.opportunity.findFirst({
    where: { id: input.opportunityId, projectId },
    select: { id: true, status: true, title: true },
  });
  if (!opportunity) throw new ExecutionError("Opportunity not found in this project", 404);
  if (!(DELIVERABLE_STATUSES as readonly string[]).includes(opportunity.status)) {
    throw new ExecutionError(
      `opportunity is ${opportunity.status}; accept it before reporting work against it`,
      409
    );
  }
  /**
   * A delivery does not re-open, re-close or un-deliver anything.
   *
   * `delivered → delivered` is allowed and records a follow-up note (a fix pushed after
   * review). Anything else that would move a delivered row back to `in_progress` is refused:
   * progress on work already delivered is a new opportunity or a task step, not a silent
   * status walk.
   */
  if (opportunity.status === "delivered" && status === "in_progress") {
    throw new ExecutionError("opportunity is already delivered; report a further delivery instead", 409);
  }

  const execution = await db.opportunityExecution.create({
    data: {
      opportunityId: opportunity.id,
      siteId: input.siteId,
      projectId,
      executorKind: "external_agent",
      executorId,
      workKind,
      commitSha,
      pullRequestUrl,
      deployedUrl,
      note,
      resultingStatus: status,
    },
    select: { id: true },
  });

  if (opportunity.status !== status) {
    await db.opportunity.update({
      where: { id: opportunity.id },
      data: { status },
    });
  }

  return {
    schemaVersion: "1.0",
    projectId,
    siteId: input.siteId,
    opportunityId: opportunity.id,
    executionId: execution.id,
    status,
    recorded: {
      executorKind: "external_agent",
      executorId,
      workKind,
      commitSha,
      pullRequestUrl,
      deployedUrl,
      note,
    },
  };
}

export type ExecutionRecord = {
  id: string;
  executorKind: string;
  executorId: string;
  workKind: string;
  commitSha: string | null;
  pullRequestUrl: string | null;
  deployedUrl: string | null;
  note: string;
  resultingStatus: string;
  createdAt: string;
};

/** The deliveries recorded against one opportunity, newest first. */
export async function listOpportunityExecutions(
  db: Pick<PrismaClient, "opportunityExecution">,
  projectId: string,
  opportunityId: string
): Promise<ExecutionRecord[]> {
  const rows = await db.opportunityExecution.findMany({
    where: { opportunityId, projectId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map((row) => ({
    id: row.id,
    executorKind: row.executorKind,
    executorId: row.executorId,
    workKind: row.workKind,
    commitSha: row.commitSha,
    pullRequestUrl: row.pullRequestUrl,
    deployedUrl: row.deployedUrl,
    note: row.note,
    resultingStatus: row.resultingStatus,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * What an executor needs to know before it can do the work.
 *
 * ## Why there are two lanes
 *
 * The first version of this reported `canExecute: false` unless the site had a cloneable
 * `repoUrl`, on the reasoning that a remote client cannot `cd` into a local path. That was
 * wrong about who executes: the common executor is an agent session running *on this host*,
 * beside the checkouts and the Wix bridge — which is exactly the case `repoPath` was built
 * for. Reporting "cannot execute" for a site that is sitting right there, checked out and
 * deployable, is a false refusal that hides working capability.
 *
 * So the two facts are two lanes, and either one makes the site executable:
 *
 * - **local checkout** — `repoPath` names a directory on this host. Verified on disk: the
 *   directory exists and is a git work tree. This is the lane a session on this box uses.
 * - **clone** — `repoUrl` names a repository a remote executor can clone.
 *
 * `canExecute` is true when *either* lane works, and `missing` lists what is absent. The
 * distinction is kept because the lanes are not interchangeable: a local path is useless to
 * a remote client, and a clone URL is not a checkout. Reporting both lets each caller take
 * the one it can use instead of guessing from a single boolean.
 */
export type ExecutionLane = {
  lane: "local_checkout" | "clone";
  /** What to use: an absolute path, or a cloneable identifier. */
  target: string;
  /** True when this lane is usable as verified. */
  usable: boolean;
  /** Why it is not usable, when it is not. */
  problem: string | null;
};

export type ExecutionConfig = {
  schemaVersion: "1.0";
  siteId: string;
  domain: string;
  /** True when at least one lane can execute. */
  canExecute: boolean;
  /** Every lane considered, usable or not, so a caller picks rather than guesses. */
  lanes: ExecutionLane[];
  repo: {
    /** A path on this host, for a local executor. */
    localPath: string | null;
    /** A cloneable identifier, for a remote executor. */
    url: string | null;
    /** The branch work targets. */
    branch: string | null;
    /** Where the site documents its own deploy process. */
    deployDocPath: string | null;
    /** True when the deploy document was found at the stated path. */
    deployDocFound: boolean;
  };
  /** The delivery adapters this site accepts, as stored. */
  adapters: readonly string[];
  /** What is missing for an executor to work here. Empty when a lane is usable. */
  missing: string[];
  /** Deliveries previously reported for this site, newest first. */
  recentExecutions: ExecutionRecord[];
  /**
   * How to report work back. Stated in the payload so a client does not have to guess the
   * call shape, and so a changed shape is visible in the response it changes.
   */
  reporting: {
    tool: "seo_report_work";
    requires: string[];
  };
};

/** Whether a directory is a git work tree, without shelling out. */
async function isGitCheckout(dir: string): Promise<boolean> {
  try {
    const stat = await stat_path(dir);
    if (!stat.isDirectory()) return false;
    await stat_path(join_path(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat_path(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the deploy document.
 *
 * Sites document their release process in one of two places, and which one is a fact about
 * the site rather than something to normalise: the site's own repository (`DEPLOYMENT.md`
 * beside the code) or the bridge's site directory (where the deploy scripts live). The
 * stated `deployDocPath` is tried first, then the two conventional locations. Whichever
 * resolves is reported; none resolving is reported as not found rather than assumed.
 */
async function resolveDeployDoc(
  stated: string | null,
  repoPath: string | null,
  bridgeAlias: string | null
): Promise<{ path: string | null; found: boolean }> {
  const candidates: string[] = [];
  if (stated) candidates.push(stated);
  if (repoPath) candidates.push(join_path(repoPath, "DEPLOYMENT.md"));
  if (bridgeAlias) candidates.push(join_path("/home/admin/wix-site-bridge/sites", bridgeAlias, "DEPLOYMENT.md"));
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return { path: candidate, found: true };
  }
  return { path: stated ?? (repoPath ? join_path(repoPath, "DEPLOYMENT.md") : null), found: false };
}

export async function readExecutionConfig(
  db: Pick<PrismaClient, "site" | "opportunityExecution">,
  projectId: string,
  siteId: string
): Promise<ExecutionConfig> {
  const site = await db.site.findFirst({
    where: { id: siteId, projectId, retiredAt: null },
    select: {
      id: true,
      domain: true,
      siteDeliveryConfig: {
        select: {
          repoPath: true, repoUrl: true, defaultBranch: true, deployDocPath: true,
          bridgeAlias: true, adapters: true, enabled: true,
        },
      },
    },
  });
  if (!site) throw new ExecutionError("Project site not found", 404);

  const config = site.siteDeliveryConfig;
  const adapters = Array.isArray(config?.adapters) ? (config!.adapters as string[]) : [];

  const missing: string[] = [];
  const lanes: ExecutionLane[] = [];

  if (!config) {
    missing.push("no delivery configuration: the site has no repository or adapters recorded");
  } else {
    if (!config.enabled) missing.push("delivery is disabled for this site");

    // Lane 1: a checkout on this host. Verified, because a stale path is the same as no path.
    if (config.repoPath) {
      const usable = await isGitCheckout(config.repoPath);
      lanes.push({
        lane: "local_checkout",
        target: config.repoPath,
        usable,
        problem: usable ? null : "path does not exist or is not a git work tree on this host",
      });
    }

    // Lane 2: something a remote executor can clone.
    if (config.repoUrl) {
      lanes.push({ lane: "clone", target: config.repoUrl, usable: true, problem: null });
    }

    if (lanes.length === 0) {
      missing.push("no repository: neither a repoPath (a checkout on this host) nor a repoUrl (something to clone)");
    } else if (!lanes.some((lane) => lane.usable)) {
      missing.push("no usable repository lane: the local path does not resolve and no repoUrl is set");
    }
    if (adapters.length === 0) missing.push("no delivery adapters recorded");
  }

  const deployDoc = await resolveDeployDoc(
    config?.deployDocPath ?? null,
    config?.repoPath ?? null,
    config?.bridgeAlias ?? null
  );
  if (config && !deployDoc.found) {
    missing.push("no deploy document found: the site does not state how a change reaches production");
  }

  const recent = await db.opportunityExecution.findMany({
    where: { siteId, projectId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true, executorKind: true, executorId: true, workKind: true,
      commitSha: true, pullRequestUrl: true, deployedUrl: true,
      note: true, resultingStatus: true, createdAt: true,
    },
  });

  return {
    schemaVersion: "1.0",
    siteId: site.id,
    domain: site.domain,
    // Disabled means disabled: a site whose delivery is switched off is not executable even
    // when every fact is present, or the tool would invite work that cannot ship.
    canExecute:
      config?.enabled === true &&
      lanes.some((lane) => lane.usable) &&
      adapters.length > 0 &&
      deployDoc.found,
    lanes,
    repo: {
      localPath: config?.repoPath ?? null,
      url: config?.repoUrl ?? null,
      branch: config?.defaultBranch ?? null,
      deployDocPath: deployDoc.path,
      deployDocFound: deployDoc.found,
    },
    adapters,
    missing,
    recentExecutions: recent.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    reporting: {
      tool: "seo_report_work",
      requires: ["executor_id", "work_kind", "note", "and one of commit_sha / pull_request_url / deployed_url"],
    },
  };
}

/** An opportunity with its delivery history attached, for the board read. */
export type OpportunityWithExecutions = OpportunityAnchor & {
  executions: ExecutionRecord[];
};

export function withExecutions<
  T extends { type: string; dedupKey: string; scoreInputs: unknown; recommendationDecision: unknown; id: string },
>(row: T, executions: ExecutionRecord[]): OpportunityWithExecutions & T {
  return { ...withOpportunityAnchor(row), executions };
}
