import type { PrismaClient } from "@prisma/client";

import { queryFromDedupKey } from "@/lib/funnel/cluster-resolver";

/**
 * CMP-004: the monthly SERP watch list.
 *
 * The weekly grid is drawn from first-party rows we already own; it costs
 * nothing. This is the *other* series — one bought SERP per watched query per
 * month, as an independent check on the free trend.
 *
 * It exists because of a measured limit. Buying a SERP every week would buy a
 * move smaller than the uncertainty of the data used to judge it (weekly median
 * |Δposition| 0.80 against a noise floor of 1.14), and the bundle already caps
 * SERPs at 10 per site per month. So this stage does not add a second collector:
 * it *chooses* which queries the existing monthly SERP budget is spent on, so the
 * cap is spent on the queries a person declared and on the ones with live work,
 * instead of on whatever the bundle happened to rank first.
 *
 * All of it is arithmetic over stored facts. Nothing here decides what a topic
 * means.
 */

/** The bundle's own hard cap. This stage may not exceed it. */
export const BUNDLE_SERP_CAP = 10;

export type WatchListInput = {
  /** Queries on any cluster's declared grid. */
  gridQueries: string[];
  /** Queries with a live opportunity, highest score first. */
  opportunityQueries: string[];
  /** Already sampled this month, so a second run buys nothing. */
  alreadySampled: Set<string>;
  /** Micros per SERP call, from the measured provider cost. */
  perCallMicros: number;
  cap?: number;
};

export type WatchList = {
  /** In purchase order: live work first, then the declared grid. */
  selected: string[];
  /** Queries that would have been watched but the cap was reached. */
  omitted: number;
  /** Queries skipped because this month already bought them. */
  reused: number;
  /** Queries that looked eligible but had no query text. */
  invalid: number;
  estimatedMicros: number;
  cap: number;
  /** Set when the cap stopped the list short, so the caller can report it. */
  capReached: boolean;
};

/**
 * Choose the watch list.
 *
 * Order is deliberate: a query with live work is one where a position change is
 * the thing we are trying to prove, so it is bought first. Then the declared grid,
 * in declaration order. The free daily series covers the rest — it is the trend,
 * and this is a check on it.
 */
export function selectWatchList(input: WatchListInput): WatchList {
  const cap = Math.max(0, Math.min(input.cap ?? BUNDLE_SERP_CAP, BUNDLE_SERP_CAP));
  const seen = new Set<string>();
  const candidates: string[] = [];
  let invalid = 0;

  for (const query of [...input.opportunityQueries, ...input.gridQueries]) {
    const trimmed = typeof query === "string" ? query.trim() : "";
    if (!trimmed) {
      invalid += 1;
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(trimmed);
  }

  const fresh = [];
  let reused = 0;
  for (const query of candidates) {
    if (input.alreadySampled.has(query.toLowerCase())) {
      reused += 1;
      continue;
    }
    fresh.push(query);
  }

  const selected = fresh.slice(0, cap);
  return {
    selected,
    omitted: fresh.length - selected.length,
    reused,
    invalid,
    estimatedMicros: selected.length * input.perCallMicros,
    cap,
    capReached: fresh.length > selected.length,
  };
}

export type WatchListDb = Pick<PrismaClient, "evidenceRecord" | "opportunity">;

/**
 * Read the watch list's inputs from stored facts.
 *
 * - Grid queries come from the memberships a person marked tracked (CMP-004),
 *   so this stage spends the cap on the grid that was actually declared.
 * - Live-opportunity queries come from the open opportunity rows, by score.
 * - `alreadySampled` is this month's `serp_snapshot` rows: idempotent by month,
 *   which is what stops a second run from buying the same SERPs again.
 */
export async function readWatchList(
  db: WatchListDb,
  input: { projectId: string; monthStart: Date; perCallMicros: number; cap?: number }
): Promise<WatchList> {
  const [memberships, opportunities, samples] = await Promise.all([
    db.evidenceRecord.findMany({
      where: { projectId: input.projectId, kind: "keyword_universe_membership", supersededById: null },
      select: { dimensions: true },
    }),
    db.opportunity.findMany({
      where: { projectId: input.projectId, status: { in: ["detected", "accepted", "in_progress"] } },
      select: { dedupKey: true, scoreValue: true, title: true },
      orderBy: [{ scoreValue: "desc" }],
    }),
    db.evidenceRecord.findMany({
      where: {
        projectId: input.projectId,
        kind: "serp_snapshot",
        supersededById: null,
        observedAt: { gte: input.monthStart },
      },
      select: { dimensions: true },
    }),
  ]);

  const gridQueries: string[] = [];
  const gridSeen = new Set<string>();
  for (const row of memberships) {
    const dims = (row.dimensions ?? {}) as { query?: string; grid?: string };
    if (dims.grid !== "tracked" || typeof dims.query !== "string") continue;
    const key = dims.query.trim().toLowerCase();
    if (!key || gridSeen.has(key)) continue;
    gridSeen.add(key);
    gridQueries.push(dims.query);
  }

  // The query a live opportunity is about. `dedupKey` is the row's stable
  // identity and it carries the query text; the title is not parsed, because a
  // title is prose the model wrote and reading it back is guessing.
  const opportunityQueries: string[] = [];
  const oppSeen = new Set<string>();
  for (const row of opportunities) {
    const query = queryFromDedupKey(row.dedupKey);
    if (!query) continue;
    const key = query.toLowerCase();
    if (gridSeen.has(key) || oppSeen.has(key)) continue;
    oppSeen.add(key);
    opportunityQueries.push(query);
  }

  const alreadySampled = new Set(
    samples
      .map((row) => (row.dimensions as { query?: string })?.query)
      .filter((query): query is string => typeof query === "string")
      .map((query) => query.trim().toLowerCase())
  );

  return selectWatchList({
    gridQueries,
    opportunityQueries,
    alreadySampled,
    perCallMicros: input.perCallMicros,
    cap: input.cap,
  });
}

/** `opportunity` dedup keys are `<detector>:<query>:<rest>`; the parser is CMP-002's. */
