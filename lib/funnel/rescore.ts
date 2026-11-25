/**
 * Re-score stored opportunities from their stored inputs.
 *
 * `scoreValue` is computed once inside `writeOpportunity` and never again, so a row
 * keeps the score it had when it was first written. When a later bundle supplies
 * impressions, a competitor position or measured reach, the number does not move — and
 * `lastScoredAt` was written and read by nothing, so "how stale is this board" had no
 * answer.
 *
 * This is the missing half: one entry point that recomputes `scoreValue` from
 * `scoreInputs`, and two callers (pipeline end, nightly sweep) rather than a bespoke
 * query in each.
 *
 * ## What it refuses to do
 *
 * It does not re-score work a person owns. An accepted, in-progress or delivered row
 * carries a task and a brief that were chosen at its current priority; moving that
 * number silently is a change under someone's feet. The same rule as
 * `scripts/business-value-source-backfill.ts` and `scripts/winnability-backfill.ts`,
 * with the same explicit opt-in.
 *
 * It does not invent an input. A row whose `scoreInputs` is missing or shapeless is
 * reported, not repaired: repairing it needs a producer run, and guessing is how the
 * board acquired numbers nobody could defend.
 *
 * It does not reimplement scoring. `computeScore` is called, so there is exactly one
 * definition of what a row is worth. If it called anything else, the re-score would be
 * a second opinion rather than the same one applied later.
 *
 * ## Why it is cheap
 *
 * Every input is already stored on the row. This buys no evidence, calls no provider
 * and reads no crawl: it is a pure function of `scoreInputs`, applied again. Measured
 * 2026-11-25, the whole fleet is 2,010 rows, of which ~100 are open — the cost is
 * nothing next to staleness.
 */

import type { PrismaClient } from "@prisma/client";

import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";

/** Statuses whose score a person owns, so the sweep leaves them alone. */
const HUMAN_OWNED = ["accepted", "in_progress", "delivered"] as const;

export type RescoreDb = Pick<PrismaClient, "opportunity">;

export type RescoreScope = {
  /** One project. The pipeline passes the site's project; the sweep walks every one. */
  projectId: string;
  /** Include rows a person accepted or is working. Off by default, and deliberate. */
  includeHumanOwned?: boolean;
  /**
   * Report only. The default, because a re-score changes the board and a caller that
   * writes by accident is how a number moves without anyone deciding it should.
   */
  dryRun?: boolean;
};

export type RescoreResult = {
  /** Rows whose stored score differs from the score their inputs now produce. */
  changed: number;
  /** Rows already correct. On a second run, this is all of them. */
  unchanged: number;
  /** Rows skipped because a person owns the priority. */
  humanOwned: number;
  /**
   * Rows with no usable `scoreInputs`. Reported, never repaired here: a producer run
   * is what gives them inputs, and a guessed score is worse than a missing one.
   */
  unscorable: number;
  /** Rows moved because a row's inputs changed, largest movement first. */
  movements: {
    id: string;
    title: string;
    from: number | null;
    to: number;
    /** Positive means the row got more important. */
    delta: number;
  }[];
};

/** Whether `scoreInputs` is the shape `computeScore` needs, without guessing. */
function hasWorth(inputs: unknown): inputs is ScoreInputs {
  if (inputs == null || typeof inputs !== "object") return false;
  const worth = (inputs as { worth?: unknown }).worth;
  if (worth == null || typeof worth !== "object") return false;
  // The two fields every scorer path reads. A row missing either cannot be scored
  // honestly, and zero-filling it would produce a number that looks measured.
  const w = worth as { businessValue?: unknown; volume?: unknown };
  return "businessValue" in w && "volume" in w;
}

/**
 * Recompute `scoreValue` for one project's rows from their stored inputs.
 *
 * Idempotent: a second run with the same inputs reports every row unchanged. That is
 * the property the nightly sweep depends on — a job that rewrites rows on every run
 * makes "did anything change?" unanswerable.
 */
export async function rescoreProjectOpportunities(
  db: RescoreDb,
  scope: RescoreScope
): Promise<RescoreResult> {
  const result: RescoreResult = {
    changed: 0,
    unchanged: 0,
    humanOwned: 0,
    unscorable: 0,
    movements: [],
  };

  const rows = await db.opportunity.findMany({
    where: { projectId: scope.projectId },
    select: { id: true, title: true, status: true, scoreValue: true, scoreInputs: true },
  });

  for (const row of rows) {
    if (!scope.includeHumanOwned && (HUMAN_OWNED as readonly string[]).includes(String(row.status))) {
      result.humanOwned += 1;
      continue;
    }
    if (!hasWorth(row.scoreInputs)) {
      result.unscorable += 1;
      continue;
    }

    const next = computeScore(row.scoreInputs).scoreValue;
    if (next === row.scoreValue) {
      result.unchanged += 1;
      continue;
    }

    result.changed += 1;
    result.movements.push({
      id: row.id,
      title: row.title,
      from: row.scoreValue,
      to: next,
      delta: next - (row.scoreValue ?? 0),
    });

    if (scope.dryRun) continue;
    await db.opportunity.update({
      where: { id: row.id },
      data: {
        scoreValue: next,
        // Finally read by something. A board can now answer "when was this number
        // last derived from its inputs", which is what makes staleness a fact instead
        // of a suspicion.
        lastScoredAt: new Date(),
      },
    });
  }

  // Largest movement first, so a caller reading the log sees what actually matters
  // rather than the order rows happened to be stored in.
  result.movements.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return result;
}

/**
 * Re-score every active project. The nightly sweep's body.
 *
 * Walks `site` rather than `project` so a project with no live site is not scored: a
 * retired site's board is history, and rewriting its numbers would change a record
 * nobody asked to change.
 */
export async function rescoreAllProjects(
  db: Pick<PrismaClient, "opportunity" | "site">,
  opts: { includeHumanOwned?: boolean; dryRun?: boolean } = {}
): Promise<Map<string, RescoreResult>> {
  const sites = await db.site.findMany({
    where: { retiredAt: null, projectId: { not: null } },
    select: { domain: true, projectId: true },
  });
  const byProject = new Map<string, string>();
  for (const site of sites) {
    if (site.projectId) byProject.set(site.projectId, site.domain);
  }

  const out = new Map<string, RescoreResult>();
  for (const [projectId] of byProject) {
    out.set(
      projectId,
      await rescoreProjectOpportunities(db, {
        projectId,
        includeHumanOwned: opts.includeHumanOwned,
        dryRun: opts.dryRun,
      })
    );
  }
  return out;
}

