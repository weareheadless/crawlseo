import type { PrismaClient } from "@prisma/client";

import { queryFromDedupKey } from "@/lib/funnel/cluster-resolver";
/**
 * CMP-009: close the loop. Nothing the system delivers was ever measured.
 *
 * `OutcomeObservation` held **0 rows against 17 tasks**: every delivery and outcome
 * path existed in the schema and no stage wrote through it. This module is the two
 * halves that fix that:
 *
 *   1. **A baseline at acceptance**, from the latest sample — our position and the
 *      competitor URL ahead of us. Capturing it later would be measuring against a
 *      number that already moved.
 *   2. **A measurement at one moment**: for a delivered task with history after
 *      `OUTCOME_MIN_DAYS`, compare our position with the baseline and write an
 *      `OutcomeObservation` with a verdict.
 *
 * The rules that keep the verdict honest:
 *
 *  - **Arithmetic, not judgement.** `improved` is a position gain of at least
 *    `OUTCOME_MIN_MOVE` places, measured against the task's own baseline. The system
 *    never decides that its work *caused* anything: every outcome carries the
 *    limitation that algorithm changes, seasonality and competitor action are not
 *    excluded.
 *  - **`won` is a human's word.** The system's own verdict never reads `verified_win`;
 *    only a person confirming the delivery landed and the competitor was passed can
 *    record that.
 *  - **`unmeasurable`, never `unchanged`.** A task with no sample after delivery, or
 *    with no baseline, has not been measured. Reporting "no effect" for it would be a
 *    conclusion nobody earned.
 *  - **One observation per task per window.** A re-run finds the existing row.
 */

/** Days after delivery before a second sample carries real information. */
export const OUTCOME_MIN_DAYS = 28;

/** Position places of improvement that count as `improved`. */
export const OUTCOME_MIN_MOVE = 3;

export type Verdict = "improved" | "unchanged" | "declined" | "unmeasurable";

export type BaselineSnapshot = {
  /** Our position for the task's query, or null when it was not measured. */
  position: number | null;
  /** The competitor whose page was ahead of ours, when one is known. */
  competitorDomain: string | null;
  /** That competitor's position. */
  competitorPosition: number | null;
  /** The URL of our own page the work targets, when known. */
  url: string | null;
  /** The query the work is about. */
  query: string | null;
  observedAt: Date | null;
  /** True when nothing could be measured, which the task must record visibly. */
  unobserved: boolean;
  /** Why it is unobserved, in words a person can read. */
  reason: string | null;
};

export type OutcomeMeasurement = {
  taskId: string;
  query: string | null;
  baseline: BaselineSnapshot;
  /** Our position in the newest sample after delivery, or null. */
  afterPosition: number | null;
  afterObservedAt: Date | null;
  /** Signed places gained: positive is better. Null when not measurable. */
  positionDelta: number | null;
  /** The competitor's position now, when a sample named it. Null is not zero. */
  competitorAfterPosition: number | null;
  competitorDelta: number | null;
  /** True when our position is now ahead of the competitor we were chasing. */
  passedCompetitor: boolean | null;
  verdict: Verdict;
  /** Why this verdict, in one line. */
  reason: string;
  /** Stated on every row: this is not a causal claim. */
  limitation: string;
};

export type OutcomeDb = Pick<PrismaClient, "task" | "opportunity" | "evidenceRecord" | "outcomeObservation">;

const LIMITATION =
  "A position change between two samples is not proof this work caused it: algorithm updates, " +
  "seasonality and competitor action are not excluded.";

/**
 * The query a task is about, from its opportunity's dedup key.
 *
 * This delegates to the codebase's single resolver rather than parsing the key again.
 * A first version of this module took `split(":")[1]` as the query, which read
 * `phase3:content_business:52ac11fcf047c488` as a query called "content_business" and
 * then reported "no sample names this query" instead of "this opportunity does not name
 * a query" — the right verdict for the wrong reason. Measured 2026-11-24: 155 live
 * opportunities carry that lane segment, 67 `cluster`, 39 `site`, 24 `technical`, and
 * the resolver rejects all of them because an internal slug is not a query.
 *
 * The cost of this strictness is stated, not hidden: a one-word query key is not
 * treated as a query, so such work is reported `unmeasurable` with the reason rather
 * than measured against a segment that might be a lane label.
 */
function queryOf(dedupKey: string): string | null {
  return queryFromDedupKey(dedupKey);
}

type RankRow = {
  dimensions: unknown;
  metrics: unknown;
  observedAt: Date;
};

/**
 * The current position for one query — the *latest* measurement, never the best-ever.
 *
 * A first version of this took the minimum position across all history. Measured on
 * atelier-harmonie's `renover abat jour`: that returned **6**, taken three weeks before
 * the opportunity was even created, while the newest sample said **9.125**. A baseline
 * built from a page's best day is not a baseline — it makes every delivery look like a
 * fall and every comparison dishonest.
 *
 * Two conventions come from `rank-series.ts`, which already documents them:
 *
 *  - **A single day is not a position.** One day's Search Console row is ±2 places of
 *    noise on ~14 impressions. So all rows on the newest sampled date are folded into an
 *    impressions-weighted mean, which is what `bucketWeekly` does for a week.
 *  - **Impressions weight the mean**, because a position seen on one impression is not the
 *    same claim as one seen on 900. A row with no impression count still counts, at
 *    weight 1, so a sampled SERP (which has no impressions) is not discarded — but it
 *    never outweighs real first-party evidence on the same date.
 */
function currentPosition(
  rows: RankRow[],
  query: string,
  domain: string | null
): { position: number | null; observedAt: Date | null } {
  const wanted = domain ? domain.toLowerCase().replace(/^www\./, "") : null;
  const matching: Array<{ position: number; impressions: number; observedAt: Date }> = [];
  for (const row of rows) {
    const dims = (row.dimensions ?? {}) as { query?: string; domain?: string; url?: string };
    if (typeof dims.query !== "string" || dims.query.toLowerCase() !== query.toLowerCase()) continue;
    if (wanted) {
      const rowDomain = typeof dims.domain === "string" ? dims.domain.toLowerCase().replace(/^www\./, "") : null;
      if (rowDomain !== wanted) continue;
    }
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    const position =
      metrics["first_party:position"]?.value ?? metrics["provider:position"]?.value ?? null;
    if (position == null || position <= 0) continue;
    const impressions = metrics["first_party:impressions"]?.value ?? 0;
    matching.push({
      position,
      impressions: Number.isFinite(impressions) && impressions > 0 ? impressions : 1,
      observedAt: row.observedAt,
    });
  }
  if (matching.length === 0) return { position: null, observedAt: null };

  // The newest sampled date is the current reading. `toISOString().slice(0,10)` compares
  // calendar days in UTC, which is how the rest of the pipeline stamps observations.
  const newest = matching.reduce((latest, row) => (row.observedAt > latest ? row.observedAt : latest), matching[0].observedAt);
  const day = newest.toISOString().slice(0, 10);
  const sameDay = matching.filter((row) => row.observedAt.toISOString().slice(0, 10) === day);
  const weight = sameDay.reduce((sum, row) => sum + row.impressions, 0);
  const weighted = sameDay.reduce((sum, row) => sum + row.position * row.impressions, 0);
  return {
    position: Math.round((weighted / weight) * 100) / 100,
    observedAt: newest,
  };
}

/**
 * Read the baseline for a task from the evidence that already exists.
 *
 * Our position comes from our own rank evidence; the competitor ahead of us comes from
 * CMP-003's `competitor_rank` rows, taking the domain immediately above us. When the
 * query has no sample, the baseline is `unobserved` **with a reason**, which the task
 * records visibly — the issue requires that rather than an invented number.
 */
export async function readBaseline(
  db: OutcomeDb,
  input: { projectId: string; dedupKey: string; siteDomain: string; at?: Date }
): Promise<BaselineSnapshot> {
  const query = queryOf(input.dedupKey);
  const empty = (reason: string): BaselineSnapshot => ({
    position: null,
    competitorDomain: null,
    competitorPosition: null,
    url: null,
    query,
    observedAt: null,
    unobserved: true,
    reason,
  });
  if (!query) return empty("The opportunity does not name a query, so there is nothing to measure.");

  /**
   * The baseline describes the world **at acceptance**.
   *
   * `at` bounds the read so re-running a baseline for an older acceptance returns the same
   * number rather than the newest sample. Without the bound a baseline computed today and
   * recomputed next month would silently move, and the "before" in a before/after report
   * would be whatever was newest when someone last looked.
   */
  const observedAtFilter = input.at ? { lte: input.at } : undefined;
  const [ranks, competitors] = await Promise.all([
    db.evidenceRecord.findMany({
      where: { projectId: input.projectId, kind: "keyword_rank", supersededById: null, observedAt: observedAtFilter },
      select: { dimensions: true, metrics: true, observedAt: true },
    }),
    db.evidenceRecord.findMany({
      where: { projectId: input.projectId, kind: "competitor_rank", supersededById: null, observedAt: observedAtFilter },
      select: { dimensions: true, metrics: true, observedAt: true },
    }),
  ]);

  const ours = currentPosition(ranks, query, null);
  // "Ahead of us" is a competitor at a better position than our own. When we have no
  // position, the best-placed competitor is the page to beat.
  let ahead: { domain: string; position: number; observedAt: Date } | null = null;
  for (const row of competitors) {
    const dims = (row.dimensions ?? {}) as { query?: string; domain?: string };
    if (typeof dims.query !== "string" || dims.query.toLowerCase() !== query.toLowerCase()) continue;
    if (typeof dims.domain !== "string") continue;
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    const position = metrics["provider:position"]?.value ?? null;
    if (position == null || position <= 0) continue;
    if (ours.position != null && position >= ours.position) continue;
    if (!ahead || position < ahead.position) {
      ahead = { domain: dims.domain, position, observedAt: row.observedAt };
    }
  }

  if (ours.position == null && !ahead) {
    return empty(
      "No sample names this query, so neither our position nor a competitor's was measured."
    );
  }

  const targetUrl =
    ranks
      .map((row) => (row.dimensions ?? {}) as { query?: string; url?: string })
      .find((dims) => typeof dims.url === "string" && dims.query?.toLowerCase() === query.toLowerCase())?.url ?? null;

  const observedAt =
    ours.observedAt && ahead?.observedAt
      ? ours.observedAt > ahead.observedAt
        ? ours.observedAt
        : ahead.observedAt
      : (ours.observedAt ?? ahead?.observedAt ?? null);

  return {
    position: ours.position,
    competitorDomain: ahead?.domain ?? null,
    competitorPosition: ahead?.position ?? null,
    url: targetUrl,
    query,
    observedAt,
    unobserved: false,
    reason: null,
  };
}

/**
 * Record the baseline on a task.
 *
 * Called when a task is accepted, in the same transaction, so a task can never exist
 * without either a baseline or a recorded reason it has none.
 */
export async function captureBaseline(
  db: Pick<PrismaClient, "baseline">,
  input: { taskId: string; baseline: BaselineSnapshot; at?: Date }
): Promise<void> {
  await db.baseline.create({
    data: {
      taskId: input.taskId,
      observedAt: input.baseline.observedAt ?? input.at ?? new Date(),
      metrics: {
        unobserved: input.baseline.unobserved,
        reason: input.baseline.reason,
        query: input.baseline.query,
        position: input.baseline.position,
        competitorDomain: input.baseline.competitorDomain,
        competitorPosition: input.baseline.competitorPosition,
        url: input.baseline.url,
      } as never,
    },
  });
}

/**
 * Measure one delivered task.
 *
 * `now` is passed rather than read so the 28-day gate can be tested at its boundary.
 * The row's `afterObservedAt` is the newest sample's own timestamp, not `now`: the
 * measurement describes when the sample was taken.
 */
export async function measureOutcome(
  db: OutcomeDb,
  input: {
    taskId: string;
    projectId: string;
    /** When the work was delivered. */
    deliveredAt: Date;
    now?: Date;
  }
): Promise<OutcomeMeasurement> {
  const now = input.now ?? new Date();
  const task = await db.task.findUnique({
    where: { id: input.taskId },
    select: {
      id: true,
      opportunity: { select: { dedupKey: true, projectId: true } },
      baselines: { orderBy: { observedAt: "asc" }, select: { metrics: true, observedAt: true }, take: 1 },
    },
  });
  if (!task || !task.opportunity) throw new Error("task not found");
  const dedupKey = task.opportunity.dedupKey;
  const query = queryOf(dedupKey);

  const stored = (task.baselines[0]?.metrics ?? null) as {
    unobserved?: boolean;
    reason?: string | null;
    query?: string | null;
    position?: number | null;
    competitorDomain?: string | null;
    competitorPosition?: number | null;
    url?: string | null;
  } | null;
  const baseline: BaselineSnapshot = stored
    ? {
        position: stored.position ?? null,
        competitorDomain: stored.competitorDomain ?? null,
        competitorPosition: stored.competitorPosition ?? null,
        url: stored.url ?? null,
        query: stored.query ?? query,
        observedAt: task.baselines[0].observedAt,
        unobserved: stored.unobserved === true,
        reason: stored.reason ?? null,
      }
    : {
        position: null,
        competitorDomain: null,
        competitorPosition: null,
        url: null,
        query,
        observedAt: null,
        unobserved: true,
        // Two different reasons, and the specific one is the useful one. A task
        // accepted before baselines existed cannot be backfilled (the ticket forbids
        // it); a task whose opportunity names no query never had anything to measure.
        reason: query
          ? "No baseline was captured when this work was accepted, and backfilling one is not allowed, so this work cannot be measured."
          : "The opportunity does not name a query, so there is nothing to measure this work against.",
      };

  const base = {
    taskId: input.taskId,
    query,
    baseline,
    competitorAfterPosition: null,
    competitorDelta: null,
    passedCompetitor: null,
    limitation: LIMITATION,
  };

  if (baseline.unobserved || baseline.position == null) {
    return {
      ...base,
      afterPosition: null,
      afterObservedAt: null,
      positionDelta: null,
      verdict: "unmeasurable",
      reason:
        baseline.reason ??
        "The baseline has no measured position, so no change can be claimed for this work.",
    };
  }

  // The gate: a second sample inside four weeks measures noise, and a task measured too
  // early would be permanently marked as having failed.
  const daysSince = Math.floor((now.getTime() - input.deliveredAt.getTime()) / 86_400_000);
  if (daysSince < OUTCOME_MIN_DAYS) {
    return {
      ...base,
      afterPosition: null,
      afterObservedAt: null,
      positionDelta: null,
      verdict: "unmeasurable",
      reason: `${daysSince} days since delivery; a change is measured at ${OUTCOME_MIN_DAYS} days.`,
    };
  }

  const projectId = task.opportunity.projectId ?? input.projectId;
  const since = new Date(input.deliveredAt.getTime() + OUTCOME_MIN_DAYS * 86_400_000);
  /**
   * The after-sample must be **newer than the baseline's own observation**, not merely
   * inside the window.
   *
   * Measured 2026-11-24: a task whose baseline was the newest stored sample read that same
   * row back as its "after" and reported `unchanged` — a verdict manufactured from zero new
   * data. The baseline is taken at acceptance from the latest sample, so any run where no
   * new sample has landed since then would have produced exactly this. Nothing moved
   * because nothing was measured, which is `unmeasurable`, not `unchanged`.
   */
  const baselineObservedAt = baseline.observedAt;
  const floor: { gte: Date } | { gt: Date } =
    baselineObservedAt && baselineObservedAt > since ? { gt: baselineObservedAt } : { gte: since };
  const [ranks, competitors] = await Promise.all([
    db.evidenceRecord.findMany({
      where: { projectId, kind: "keyword_rank", supersededById: null, observedAt: floor },
      select: { dimensions: true, metrics: true, observedAt: true },
    }),
    db.evidenceRecord.findMany({
      where: { projectId, kind: "competitor_rank", supersededById: null, observedAt: floor },
      select: { dimensions: true, metrics: true, observedAt: true },
    }),
  ]);

  const after = currentPosition(ranks, query ?? "", null);
  if (after.position == null) {
    // Two different reasons. "Nothing new since the baseline" is not the same claim as
    // "the window closed and no sample arrived", and only the second is about time.
    const reason =
      "gt" in floor
        ? `No sample of "${query ?? "this query"}" was taken after the baseline (${baselineObservedAt!.toISOString().slice(0, 10)}), so there is nothing new to compare.`
        : `No sample of "${query ?? "this query"}" was taken ${OUTCOME_MIN_DAYS} days after delivery, so there is nothing to compare.`;
    return {
      ...base,
      afterPosition: null,
      afterObservedAt: null,
      positionDelta: null,
      verdict: "unmeasurable",
      reason,
    };
  }

  // A smaller position number is better, so a gain is baseline − after.
  const delta = baseline.position - after.position;
  const verdict: Verdict =
    delta >= OUTCOME_MIN_MOVE ? "improved" : delta <= -OUTCOME_MIN_MOVE ? "declined" : "unchanged";

  // The competitor's movement comes from the same window, and stays null when no sample
  // named it: an absent comparison is not "they did not move".
  let competitorAfterPosition: number | null = null;
  if (baseline.competitorDomain) {
    competitorAfterPosition = currentPosition(competitors, query ?? "", baseline.competitorDomain).position;
  }
  const competitorDelta =
    competitorAfterPosition != null && baseline.competitorPosition != null
      ? baseline.competitorPosition - competitorAfterPosition
      : null;
  const passedCompetitor =
    competitorAfterPosition != null && after.position < competitorAfterPosition
      ? true
      : competitorAfterPosition != null
        ? false
        : null;

  const places = Math.abs(delta);
  const reason =
    verdict === "improved"
      ? `Our position moved from ${baseline.position} to ${after.position} (${places} places better), measured at least ${OUTCOME_MIN_DAYS} days after delivery.`
      : verdict === "declined"
        ? `Our position moved from ${baseline.position} to ${after.position} (${places} places worse).`
        : `Our position moved from ${baseline.position} to ${after.position}, within the ${OUTCOME_MIN_MOVE}-place band the verdict treats as unchanged.`;

  return {
    ...base,
    afterPosition: after.position,
    afterObservedAt: after.observedAt,
    positionDelta: delta,
    competitorAfterPosition,
    competitorDelta,
    passedCompetitor,
    verdict,
    reason,
  };
}

/**
 * Write an outcome, once per task per window.
 *
 * The window is the delivery date: a re-run for the same task and the same
 * `afterObservedAt` finds the existing row rather than adding a second opinion. The
 * verdict written here is never `verified_win` — that is a person's confirmation, which
 * `confirmOutcomeWin` records separately.
 */
export async function storeOutcome(
  db: Pick<PrismaClient, "outcomeObservation">,
  input: { measurement: OutcomeMeasurement; deliveredAt: Date }
): Promise<{ id: string; created: boolean }> {
  const m = input.measurement;
  // Unmeasurable work is not written as an observation: a row with no before/after would
  // look like a measured outcome in every count that reads the table. The reason travels
  // on the measurement instead.
  if (m.verdict === "unmeasurable" || m.afterObservedAt == null) {
    return { id: "", created: false };
  }
  const existing = await db.outcomeObservation.findFirst({
    where: { taskId: m.taskId, afterObservedAt: m.afterObservedAt },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };

  const verdict = m.verdict === "improved" ? "no_effect" : m.verdict === "declined" ? "regression" : "no_effect";
  // `no_effect` is the schema's name for "measured, not a win". The module's own richer
  // verdict (`improved`/`unchanged`/`declined`) travels in the metrics so a reader gets
  // the real distinction rather than losing it in the enum.
  const created = await db.outcomeObservation.create({
    data: {
      taskId: m.taskId,
      baselineMetrics: {
        position: m.baseline.position,
        competitorDomain: m.baseline.competitorDomain,
        competitorPosition: m.baseline.competitorPosition,
        query: m.baseline.query,
        url: m.baseline.url,
        observedAt: m.baseline.observedAt?.toISOString() ?? null,
        limitation: m.limitation,
      } as never,
      baselineObservedAt: m.baseline.observedAt ?? input.deliveredAt,
      afterMetrics: {
        position: m.afterPosition,
        competitorPosition: m.competitorAfterPosition,
        positionDelta: m.positionDelta,
        competitorDelta: m.competitorDelta,
        passedCompetitor: m.passedCompetitor,
        verdict: m.verdict,
        reason: m.reason,
        limitation: m.limitation,
      } as never,
      afterObservedAt: m.afterObservedAt,
      verdict: verdict as never,
      measuredBy: "site-cycle",
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

/**
 * A human confirms the delivery landed and the competitor was passed.
 *
 * This is the only path to `verified_win`. The system's own measurement never writes it,
 * because "we think this worked" and "a person checked" are different claims.
 */
export async function confirmOutcomeWin(
  db: Pick<PrismaClient, "outcomeObservation" | "task">,
  input: { taskId: string; confirmedBy: string; now?: Date }
): Promise<{ id: string }> {
  if (!input.confirmedBy || input.confirmedBy.trim() === "") {
    throw new Error("confirming a win requires the person who verified it");
  }
  const now = input.now ?? new Date();
  const existing = await db.outcomeObservation.findFirst({
    where: { taskId: input.taskId },
    orderBy: { createdAt: "desc" },
    select: { id: true, verdict: true, afterMetrics: true },
  });
  if (!existing) {
    throw new Error("this task has no measured outcome; a win cannot be confirmed before one exists");
  }
  if (existing.verdict === "verified_win") return { id: existing.id };
  await db.outcomeObservation.update({
    where: { id: existing.id },
    data: {
      verdict: "verified_win",
      afterMetrics: {
        ...((existing.afterMetrics ?? {}) as Record<string, unknown>),
        confirmedBy: input.confirmedBy,
        confirmedAt: now.toISOString(),
      } as never,
    },
  });
  return { id: existing.id };
}

export type OutcomeSweep = {
  measured: number;
  /** The window is open; a sample is still to come, so time will resolve it. */
  waiting: number;
  /** The window closed with no sample. Final, and never reported as "unchanged". */
  unmeasurable: number;
  /**
   * Delivered with no baseline to measure against: accepted before CMP-009 captured
   * one, or the opportunity names no query. The ticket forbids backfilling these, so
   * they stay unmeasured and say why rather than waiting for a sample that cannot help.
   */
  unbaselined: number;
  alreadyMeasured: number;
  tasks: Array<{ taskId: string; verdict: Verdict | "waiting" | "unbaselined"; reason: string }>;
};

/**
 * Sweep every delivered task in one project.
 *
 * The three counters are deliberately separate. "Waiting" is not "unchanged": a task
 * inside its 28-day window has not been measured, and counting it as no-effect would
 * make the board report a conclusion nobody earned.
 *
 * Only tasks in `delivered` are swept. `verified_outcome` rows already have their
 * observation, and re-measuring them would add a second opinion to a closed question.
 */
export async function sweepDeliveredOutcomes(
  db: OutcomeDb,
  input: { projectId: string; now?: Date; limit?: number }
): Promise<OutcomeSweep> {
  const now = input.now ?? new Date();
  const tasks = await db.task.findMany({
    where: {
      status: "delivered",
      opportunity: { projectId: input.projectId },
    },
    select: {
      id: true,
      updatedAt: true,
      outcomeObservations: { select: { id: true } },
    },
    orderBy: { updatedAt: "asc" },
    ...(input.limit ? { take: input.limit } : {}),
  });

  const sweep: OutcomeSweep = {
    measured: 0,
    waiting: 0,
    unmeasurable: 0,
    unbaselined: 0,
    alreadyMeasured: 0,
    tasks: [],
  };

  for (const task of tasks) {
    // A task with an observation already has its answer for this window.
    if (task.outcomeObservations.length > 0) {
      sweep.alreadyMeasured += 1;
      continue;
    }
    const measurement = await measureOutcome(db, {
      taskId: task.id,
      projectId: input.projectId,
      // `updatedAt` is when the task last moved, which is its delivery for a delivered
      // task with no later edit. The window is measured from that.
      deliveredAt: task.updatedAt,
      now,
    });

    if (measurement.verdict === "unmeasurable") {
      // Three states that must not be conflated:
      //  - `waiting` — the window is open and a sample is still to come. Time resolves it.
      //  - `unbaselined` — the task was accepted before a baseline was captured, or its
      //    opportunity names no query. No amount of waiting produces a measurement, and
      //    the ticket forbids backfilling one.
      //  - `unmeasurable` — the window closed and no sample arrived. Also final.
      const daysSince = Math.floor((now.getTime() - task.updatedAt.getTime()) / 86_400_000);
      const unbaselined = !measurement.baseline.position || measurement.baseline.unobserved;
      if (unbaselined) {
        sweep.unbaselined += 1;
        sweep.tasks.push({ taskId: task.id, verdict: "unbaselined", reason: measurement.reason });
      } else if (daysSince < OUTCOME_MIN_DAYS) {
        sweep.waiting += 1;
        sweep.tasks.push({ taskId: task.id, verdict: "waiting", reason: measurement.reason });
      } else {
        sweep.unmeasurable += 1;
        sweep.tasks.push({ taskId: task.id, verdict: "unmeasurable", reason: measurement.reason });
      }
      continue;
    }

    const stored = await storeOutcome(db, { measurement, deliveredAt: task.updatedAt });
    if (stored.created) sweep.measured += 1;
    else sweep.alreadyMeasured += 1;
    sweep.tasks.push({ taskId: task.id, verdict: measurement.verdict, reason: measurement.reason });
  }

  return sweep;
}
