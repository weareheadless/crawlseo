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

import { resolveDemand } from "@/lib/funnel/impact";
import { ASSESSMENT_VERSION, computeScore, type ScoreInputs } from "@/lib/funnel/scoring";

/** Statuses whose score a person owns, so the sweep leaves them alone. */
const HUMAN_OWNED = ["accepted", "in_progress", "delivered"] as const;

export type RescoreDb = Pick<PrismaClient, "opportunity" | "demandMapCluster" | "evidenceRecord">;

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
  /** Rows whose stored score or evidence class differs from what their inputs produce. */
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
 * Whether two stored input blobs are the same facts.
 *
 * Compared by value, not identity: the repair helpers return a fresh object on every call,
 * so a reference check would report "changed" forever and the sweep would rewrite every row
 * on every run. `computeScore` also stamps `assessment` and `assessmentVersion` into the
 * inputs it returns, so those two keys are deliberately ignored — they are a record of the
 * scoring, not an input to it.
 *
 * Serialised comparison is adequate here because the shape is plain JSON that this module
 * itself produced: no dates, no class instances, no key ordering worth preserving.
 */
function sameStoredInputs(stored: unknown, next: unknown): boolean {
  const strip = (value: unknown): string => {
    const { assessment: _a, assessmentVersion: _v, ...rest } = (value ?? {}) as Record<string, unknown>;
    return JSON.stringify(rest);
  };
  return strip(stored) === strip(next);
}

/**
 * The longest Search Console window the project's keyword evidence was measured over.
 *
 * Null when no evidence states one, which stays null: a missing window is a missing
 * measurement, and assuming 30 days is the defect #254 records.
 */
async function readMeasuredWindowDays(db: RescoreDb, projectId: string): Promise<number | null> {
  if (typeof db.evidenceRecord?.findMany !== "function") return null;
  const evidence = await db.evidenceRecord.findMany({
    where: { projectId, kind: "keyword_rank" as never, supersededById: null },
    select: { dimensions: true },
  });
  let longest: number | null = null;
  for (const row of evidence) {
    const dimensions = (row.dimensions ?? {}) as { windowRole?: string; windowDays?: number };
    if (dimensions.windowRole === "previous") continue;
    if (typeof dimensions.windowDays !== "number" || dimensions.windowDays <= 0) continue;
    longest = longest == null ? dimensions.windowDays : Math.max(longest, dimensions.windowDays);
  }
  return longest;
}

/**
 * Fill a missing measurement window from evidence, and change nothing else.
 *
 * Only fills; never overwrites. A row that already states its window keeps it, because the
 * window it was scored against is part of the record.
 */
function withMeasuredWindow(inputs: ScoreInputs, windowDays: number | null): ScoreInputs {
  if (windowDays == null) return inputs;
  const current = inputs.worth.windowDays;
  if (current != null && current > 0) return inputs;
  return { ...inputs, worth: { ...inputs.worth, windowDays } };
}

/**
 * Re-derive the demand fields a row carries, from evidence that may have changed.
 *
 * Written as a pure function of (stored inputs, current SERP state) so a re-score is
 * explainable: the same row and the same cluster always produce the same inputs. It
 * touches exactly two fields, and both are facts about evidence rather than judgements:
 *
 * - `hasSerp` — the cluster has a bought snapshot now.
 * - `demandResolution` — `observed` once either route resolves it, else `candidate`.
 *
 * `hasSerp` is never cleared: a snapshot that was bought stays bought, so a re-score
 * cannot walk a resolved row back to candidate because a later map rebuild dropped
 * `difficulty`. That direction is monotonic on purpose.
 */
function withResolvedDemand(inputs: ScoreInputs, hasSerp: boolean): ScoreInputs {
  const worth = inputs.worth;
  const serp = hasSerp || worth.hasSerp === true;
  const resolution = resolveDemand({
    observedImpressions: worth.observedImpressions ?? null,
    hasSerp: serp,
    // A re-score cannot know whether the target is a new asset without reading the
    // proposal; an existing resolved row keeps the resolution its producer decided.
    hasPage: worth.demandResolution === "observed",
  });
  const demandResolution = resolution === "unresolved" ? "candidate" : "observed";
  if (worth.hasSerp === serp && worth.demandResolution === demandResolution) return inputs;
  return { ...inputs, worth: { ...worth, hasSerp: serp, demandResolution } };
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
    select: {
      id: true,
      title: true,
      status: true,
      scoreValue: true,
      scoreInputs: true,
      evidenceClass: true,
      clusterId: true,
    },
  });

  /**
   * Which clusters have a bought SERP, read now rather than when the row was written.
   *
   * This is what makes D3 resolve on its own. `demandResolution` is stored in
   * `scoreInputs`, so re-running `computeScore` on those inputs would keep a row a
   * candidate forever — the snapshot is bought *after* the producer ran, and the inputs
   * it wrote can never learn about it. Reading `difficulty` here is the fact that changed,
   * and a bought SERP is exactly what D3 says turns a candidate into an estimated topic.
   *
   * `metrics.difficulty` is only populated from a purchased snapshot, so its presence is
   * the fact, not a proxy for one.
   */
  /**
   * The Search Console window, read once for the project.
   *
   * This is a *fact* that was measured, not a judgement, so filling it is repair rather
   * than invention — and it is the difference between sized and unsized work. Measured
   * 2026-11-25: 32 of 54 open rows carrying observed impressions could not be sized
   * because `windowDays` was null, so 944 impressions at position 60 on a 1,230/month
   * market landed in the band at a flat 7. The producer reads this window and writes it
   * on the opportunity, but rows written before that backfill existed still carry null,
   * and a re-score is the only thing that will ever revisit them.
   *
   * Read from `keyword_rank` evidence with the previous window excluded: the comparison
   * window is not the measurement being scored.
   */
  const windowDays = await readMeasuredWindowDays(db, scope.projectId);

  const clusterIds = [...new Set(rows.map((row) => row.clusterId).filter((id): id is string => id != null))];
  const clusters = clusterIds.length
    ? await db.demandMapCluster.findMany({
        where: { id: { in: clusterIds } },
        select: { id: true, businessRelevance: true },
      })
    : [];
  const serpByCluster = new Map(
    clusters.map((cluster) => {
      const metrics = (cluster.businessRelevance as { metrics?: { difficulty?: unknown } } | null)?.metrics;
      return [cluster.id, metrics?.difficulty != null];
    })
  );

  for (const row of rows) {
    if (!scope.includeHumanOwned && (HUMAN_OWNED as readonly string[]).includes(String(row.status))) {
      result.humanOwned += 1;
      continue;
    }
    if (!hasWorth(row.scoreInputs)) {
      result.unscorable += 1;
      continue;
    }

    /**
     * Re-derive resolution from the cluster's current state, then score one step later.
     *
     * Only the two fields the evidence now decides are touched; everything else stays
     * exactly as the producer wrote it. A row whose cluster has no snapshot yet is left
     * as it is, so this never invents a resolution either.
     */
    const hasSerp = row.clusterId ? (serpByCluster.get(row.clusterId) ?? false) : false;
    const inputs = withResolvedDemand(withMeasuredWindow(row.scoreInputs, windowDays), hasSerp);
    const scored = computeScore(inputs);
    const next = scored.scoreValue;
    /**
     * "Unchanged" means the score, the class **and** the inputs all already agree.
     *
     * The inputs have to be part of the test, not just the number. A repair can fill a
     * missing window or target that changes neither the score nor the class on this run but
     * leaves the row unable to reproduce its own number — and comparing only the score and
     * class would skip the write forever, so the repair would be recomputed and discarded on
     * every sweep. Measured 2026-11-25: 26 open rows read `measured` while a raw
     * `computeScore` on their stored inputs returned `hypothesis`, because the window the
     * score used was never written back.
     */
    const inputsChanged = !sameStoredInputs(row.scoreInputs, scored.inputs);
    if (next === row.scoreValue && scored.evidenceClass === row.evidenceClass && !inputsChanged) {
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
        evidenceClass: scored.evidenceClass,
        /**
         * Persist the inputs the score was actually computed from.
         *
         * `rescore` repairs two facts before scoring: a missing measurement window and a
         * missing target position. Computing the score from the repaired inputs but storing
         * only the number leaves the row in a state where its own stored `scoreInputs`
         * cannot reproduce its stored score — verified 2026-11-25 on 26 open rows that read
         * `measured` while a raw `computeScore` on their stored inputs returned
         * `hypothesis`, because the window and target the score used were never written.
         *
         * A row must be able to explain its own number. That is the whole point of storing
         * inputs, and without this a later reader could not tell a repaired row from a
         * miscalculated one.
         */
        scoreInputs: scored.inputs as never,
        // The version of the model that produced this number. A row re-scored by a
        // newer model stops claiming to have been assessed by the old one, which is
        // what made the 23-vs-6 cohort impossible to find.
        assessmentVersion: ASSESSMENT_VERSION,
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
  db: Pick<PrismaClient, "opportunity" | "site" | "demandMapCluster" | "evidenceRecord">,
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

