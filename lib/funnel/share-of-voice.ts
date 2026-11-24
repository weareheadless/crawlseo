import type { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord } from "@/lib/funnel/evidence";
import { isoWeekStart } from "@/lib/funnel/rank-series";
import { ctrAtPosition } from "@/lib/funnel/scoring";

/**
 * CMP-008: measured share of voice.
 *
 * The old number was `1 - (ourBest - 1) / 19`: a position proxy wearing a
 * share-of-voice label, computed from our own best position only, with no competitor
 * in it at all. Two clusters could read 80% while one was contested by nobody and the
 * other was lost to a rival on every query.
 *
 * This is the measurement instead. For one cluster and one sample week:
 *
 *   credit(domain) = Σ over queries ctrAtPosition(rank the domain holds)
 *   share(domain)  = credit(domain) / Σ credit(all attributable domains)
 *
 * Why CTR-weighted rather than "count of queries": a domain holding position 1 on one
 * query takes more of the clicks than a domain holding position 9 on five. The curve
 * is the declared model already used for scoring (`ctrAtPosition`), not a second one
 * invented here — and the UI labels it as a model rather than observed clicks.
 *
 * Boundaries:
 *  - **`unobserved`, never 0%.** A cluster with no sample has no share. Reporting 0
 *    would say "we are invisible" when the truth is "nobody looked".
 *  - **Only attributable domains.** A result the CMP-001 resolver could not name never
 *    receives credit, because a `google.com/goto` wrapper is not a competitor.
 *  - **One row per domain per week per cluster**, superseded on recompute, so the
 *    series is stored and a re-run produces the same numbers rather than a second
 *    opinion.
 */

/** How many samples in a row count as a trend for the win condition. */
export const WIN_STREAK_SAMPLES = 4;

/** Only the top of the SERP takes meaningful clicks. */
export const SHARE_OF_VOICE_DEPTH = 10;

export type DomainShare = {
  domain: string;
  /** Sum of the declared CTR curve over the positions this domain holds. */
  credit: number;
  /** 0–1, of the cluster's total attributable credit. */
  share: number;
  /** Queries where this domain holds a credited position. */
  queries: number;
  /** True for the site being measured. */
  us: boolean;
};

export type ClusterShareOfVoice = {
  cluster: string;
  /** The ISO week this sample belongs to. */
  week: string;
  /** How many queries the sample covered. */
  queriesObserved: number;
  /** How many SERP items could be attributed to a domain. */
  attributable: number;
  /** Ordered by share, largest first. Empty when the cluster is unobserved. */
  domains: DomainShare[];
  /**
   * Our share, or null when our position could not be measured.
   *
   * A null here is the difference between "we do not rank for these queries" and
   * "the snapshot could not name us". Measured 2026-11-24 on atelier-harmonie: the
   * newest brand-cluster snapshot held 14 organic results and **no attributable
   * domain at all**, so a 0% share would have said "we are invisible on our own brand"
   * when the truth was "that payload named nobody".
   */
  ourShare: number | null;
  /** True when at least one snapshot for the week could be attributed. */
  ourObserved: boolean;
  /** True when there is no sample at all for this cluster and week. */
  unobserved: boolean;
  /** When the newest underlying snapshot was taken. */
  sampledAt: Date | null;
};

export type ShareOfVoiceDb = Pick<PrismaClient, "evidenceRecord">;

type Observation = {
  query: string;
  domain: string;
  position: number;
  observedAt: Date;
};

/**
 * Read one week of attributable positions for a cluster.
 *
 * `competitor_rank` rows are used for competitors and our own position comes from the
 * same snapshot's rows: CMP-003 writes our position onto the `serp_snapshot` and the
 * competitors into `competitor_rank`, so both sides of one SERP are one observation.
 */
async function observationsFor(
  db: ShareOfVoiceDb,
  input: {
    projectId: string;
    clusterSlug: string;
    week: string;
    domain: string;
    /** Every domain we want credit for, including ours. */
    domains?: string[];
  }
): Promise<{ observations: Observation[]; ourObserved: boolean; sampledAt: Date | null }> {
  const [competitors, snapshots] = await Promise.all([
    db.evidenceRecord.findMany({
      where: { projectId: input.projectId, kind: "competitor_rank", supersededById: null },
      select: { dimensions: true, metrics: true, observedAt: true },
    }),
    db.evidenceRecord.findMany({
      where: { projectId: input.projectId, kind: "serp_snapshot", supersededById: null },
      select: { dimensions: true, metrics: true, observedAt: true },
    }),
  ]);

  const observations: Observation[] = [];
  // The queries in this cluster, from the competitor rows' own cluster dimension and
  // from the cluster's memberships, so a query is credited once.
  const clusterQueries = new Set<string>();
  for (const row of competitors) {
    const dims = (row.dimensions ?? {}) as { cluster?: string; query?: string };
    if (dims.cluster === input.clusterSlug && typeof dims.query === "string") {
      clusterQueries.add(dims.query.toLowerCase());
    }
  }

  const seen = new Set<string>();
  for (const row of competitors) {
    const dims = (row.dimensions ?? {}) as { query?: string; domain?: string; cluster?: string };
    if (typeof dims.query !== "string" || typeof dims.domain !== "string") continue;
    const inCluster =
      dims.cluster === input.clusterSlug || clusterQueries.has(dims.query.toLowerCase());
    if (!inCluster) continue;
    if (isoWeekStart(row.observedAt) !== input.week) continue;
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    const position = metrics["provider:position"]?.value ?? null;
    if (position == null || position <= 0 || position > SHARE_OF_VOICE_DEPTH) continue;
    const key = `${dims.query.toLowerCase()}::${dims.domain.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    observations.push({
      query: dims.query.toLowerCase(),
      domain: dims.domain.toLowerCase().replace(/^www\./, ""),
      position,
      observedAt: row.observedAt,
    });
  }

  // Our own position, from the same snapshots. A snapshot whose `cluster` matches, or
  // whose query belongs to this cluster, contributes only when we were ranked.
  //
  // "Was our position measured?" is answered by whether the attribution produced a
  // real domain, not by a flag. Measured 2026-11-24: a brand-cluster snapshot carried
  // `competitorCovered: "true"` while its `topDomains` list was **empty** — 14 organic
  // results, none attributable, because the earlier writer derived the flag from a
  // different rule. Trusting the flag turned "this payload named nobody" into a 0%
  // share, which reads as "we are invisible on our own brand".
  let ourObserved = false;
  let sampledAt: Date | null = null;
  for (const row of snapshots) {
    const dims = (row.dimensions ?? {}) as {
      query?: string;
      cluster?: string;
      competitorCovered?: string;
      topDomains?: unknown;
    };
    if (typeof dims.query !== "string") continue;
    const inCluster =
      dims.cluster === input.clusterSlug || clusterQueries.has(dims.query.toLowerCase());
    if (!inCluster) continue;
    if (isoWeekStart(row.observedAt) !== input.week) continue;
    if (!sampledAt || row.observedAt > sampledAt) sampledAt = row.observedAt;
    const attributable = Array.isArray(dims.topDomains)
      ? dims.topDomains.filter((value) => typeof value === "string" && value.trim() !== "").length
      : 0;
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    // A payload with no attributable domain is evidence of nothing, whether or not a
    // legacy flag says it was "covered".
    if (attributable === 0 && metrics["provider:position"]?.value == null) continue;
    ourObserved = true;
    const position = metrics["provider:position"]?.value ?? null;
    if (position == null || position <= 0 || position > SHARE_OF_VOICE_DEPTH) continue;
    const key = `${dims.query.toLowerCase()}::${input.domain.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    observations.push({
      query: dims.query.toLowerCase(),
      domain: input.domain.toLowerCase().replace(/^www\./, ""),
      position,
      observedAt: row.observedAt,
    });
  }

  for (const row of observations) {
    if (!sampledAt || row.observedAt > sampledAt) sampledAt = row.observedAt;
  }

  // A competitor observation is itself proof that the SERP could be attributed. So a
  // cluster where six competitors were named and we hold no position is a measured
  // absence — zero — not "not measured". Only a sample that named nobody at all
  // leaves our share unknown.
  if (!ourObserved && observations.length > 0) ourObserved = true;

  return { observations, ourObserved, sampledAt };
}

/** Every ISO week that has at least one observation for this cluster. */
export async function observedWeeks(
  db: ShareOfVoiceDb,
  input: { projectId: string; clusterSlug: string }
): Promise<string[]> {
  const rows = await db.evidenceRecord.findMany({
    where: { projectId: input.projectId, kind: "competitor_rank", supersededById: null },
    select: { dimensions: true, observedAt: true },
  });
  const weeks = new Set<string>();
  for (const row of rows) {
    const dims = (row.dimensions ?? {}) as { cluster?: string };
    if (dims.cluster !== input.clusterSlug) continue;
    weeks.add(isoWeekStart(row.observedAt));
  }
  return [...weeks].sort();
}

/**
 * The share of voice for one cluster and one week.
 *
 * A pure computation over observations, so the arithmetic can be checked against a
 * hand-built fixture as well as against the database.
 */
export function computeShareOfVoice(input: {
  cluster: string;
  week: string;
  observations: Observation[];
  domain: string;
  sampledAt?: Date | null;
  /** True when at least one snapshot for the week could be attributed. */
  ourObserved?: boolean;
}): ClusterShareOfVoice {
  const us = input.domain.toLowerCase().replace(/^www\./, "");
  const credit = new Map<string, { credit: number; queries: Set<string> }>();
  const queries = new Set<string>();
  for (const row of input.observations) {
    if (!Number.isFinite(row.position) || row.position <= 0 || row.position > SHARE_OF_VOICE_DEPTH) continue;
    const weight = ctrAtPosition(row.position) ?? 0;
    if (weight <= 0) continue;
    queries.add(row.query);
    const entry = credit.get(row.domain) ?? { credit: 0, queries: new Set<string>() };
    entry.credit += weight;
    entry.queries.add(row.query);
    credit.set(row.domain, entry);
  }

  const total = [...credit.values()].reduce((sum, entry) => sum + entry.credit, 0);
  const unobserved = credit.size === 0;

  const domains: DomainShare[] = [...credit.entries()]
    .map(([domain, entry]) => ({
      domain,
      credit: Math.round(entry.credit * 1e6) / 1e6,
      share: total > 0 ? entry.credit / total : 0,
      queries: entry.queries.size,
      us: domain === us,
    }))
    .sort((a, b) => b.share - a.share || a.domain.localeCompare(b.domain));

  const ourObserved = input.ourObserved ?? !unobserved;
  let ourEntry = domains.find((row) => row.us);

  // Show our line even at zero. A scoreboard that omits the site when it holds no
  // position leaves the client unable to see where they stand, and "0%" beside the
  // competitors is a measurement while an absent row is a gap where the answer
  // should be. Only a measured absence earns the row: an unattributable sample does
  // not invent our domain.
  if (!ourEntry && ourObserved && !unobserved) {
    ourEntry = { domain: us, credit: 0, share: 0, queries: 0, us: true };
    domains.push(ourEntry);
    domains.sort((a, b) => b.share - a.share || a.domain.localeCompare(b.domain));
  }

  const ourShare = ourEntry?.share ?? (ourObserved ? 0 : null);

  return {
    cluster: input.cluster,
    week: input.week,
    queriesObserved: queries.size,
    attributable: input.observations.length,
    domains,
    ourShare,
    ourObserved,
    unobserved,
    sampledAt: input.sampledAt ?? null,
  };
}

/**
 * Measure one cluster and week, reading the stored rows.
 *
 * Returns `unobserved` rather than a zero share when nothing was sampled: the two
 * claims are different and only one of them is a measurement.
 */
export async function shareOfVoice(
  db: ShareOfVoiceDb,
  input: { projectId: string; clusterSlug: string; week: string; domain: string }
): Promise<ClusterShareOfVoice> {
  const { observations, ourObserved, sampledAt } = await observationsFor(db, { ...input });
  return computeShareOfVoice({
    cluster: input.clusterSlug,
    week: input.week,
    observations,
    domain: input.domain,
    sampledAt,
    ourObserved,
  });
}

export type ClusterStatus = "winning" | "contending" | "losing" | "unobserved";

export type ClusterStanding = {
  status: ClusterStatus;
  /** The four most recent sampled weeks, newest last. */
  weeks: string[];
  /** Our share per week, in the same order. */
  shares: number[];
  /** Domains that led in any of the sampled weeks. */
  leaders: string[];
  /** Why the status is what it is, in one line. */
  reason: string;
};

/**
 * CMP-008's win condition, stated once.
 *
 * `winning` requires **four consecutive samples** where our share exceeds every named
 * competitor's. That is deliberately strict: one good month is noise, and calling it a
 * win is how a board stops being believed.
 *
 * The issue also requires a delivered win in the cluster (CMP-009). That dependency is
 * passed in rather than read here, so this function stays a pure statement of the
 * share condition and the caller decides what evidence of delivery it has.
 */
export function clusterStatus(input: {
  samples: ClusterShareOfVoice[];
  /** Whether a delivered opportunity in this cluster has a measured won outcome. */
  deliveredWin?: boolean;
}): ClusterStanding {
  const observed = input.samples
    .filter((sample) => !sample.unobserved)
    .sort((a, b) => (a.week < b.week ? -1 : 1));

  if (observed.length === 0) {
    return {
      status: "unobserved",
      weeks: [],
      shares: [],
      leaders: [],
      reason: "No SERP sample has been taken for this cluster, so its share of voice is unknown.",
    };
  }

  const weeks = observed.map((sample) => sample.week);
  const shares = observed.map((sample) => sample.ourShare ?? 0);
  const leaders = [
    ...new Set(
      observed
        .map((sample) => [...sample.domains].sort((a, b) => b.share - a.share)[0]?.domain)
        .filter((domain): domain is string => Boolean(domain))
    ),
  ];

  const last = observed.slice(-WIN_STREAK_SAMPLES);
  const ledEverySample = last.every((sample) => {
    const ours = sample.domains.find((row) => row.us);
    if (!ours) return false;
    // Strictly ahead of every other domain, not merely tied.
    return sample.domains.every((row) => row.us || row.share < ours.share);
  });

  if (last.length < WIN_STREAK_SAMPLES) {
    return {
      status: "contending",
      weeks,
      shares,
      leaders,
      reason: `${last.length} of ${WIN_STREAK_SAMPLES} consecutive samples collected; a win needs ${WIN_STREAK_SAMPLES}.`,
    };
  }
  if (!ledEverySample) {
    // Name who is ahead **now**, and say when the lead was lost. A reason that only
    // says "not every sample" makes a person dig for the answer the function already
    // has.
    const newest = last[last.length - 1];
    // Pick the leader by share, not by index: a caller may hand us lines in any order,
    // and a reason that names the wrong domain is worse than no reason.
    const top = [...newest.domains].sort((a, b) => b.share - a.share)[0];
    const lostAt = last.find((sample) => {
      const ours = sample.domains.find((row) => row.us);
      if (!ours) return !sample.unobserved && sample.ourObserved;
      return sample.domains.some((row) => !row.us && row.share >= ours.share);
    });
    return {
      status: "losing",
      weeks,
      shares,
      leaders,
      reason:
        top && !top.us
          ? `${top.domain} holds the largest share (${(top.share * 100).toFixed(0)}%) in the newest sample${
              lostAt && lostAt.week !== newest.week ? `, and has led since ${lostAt.week}` : ""
            }.`
          : "We do not lead every one of the last four samples.",
    };
  }
  if (!input.deliveredWin) {
    return {
      status: "contending",
      weeks,
      shares,
      leaders,
      reason: `We led the last ${WIN_STREAK_SAMPLES} samples, but no delivered opportunity in this cluster has a measured win yet.`,
    };
  }
  return {
    status: "winning",
    weeks,
    shares,
    leaders,
    reason: `We led all of the last ${WIN_STREAK_SAMPLES} samples and a delivered opportunity has a measured win.`,
  };
}

/**
 * Persist the series: one `share_of_voice` row per cluster, week and domain.
 *
 * The issue requires the series to be **stored and recomputable**: re-running over the
 * same snapshots must produce identical values, and an existing row must be superseded
 * rather than deleted or duplicated. `storeEvidenceRecord` upserts on the observation
 * hash, so a re-run with the same numbers writes nothing new; a genuine change (a
 * re-attributed snapshot) supersedes the old row through the caller.
 *
 * `unobserved` weeks write nothing: an absence is not a row.
 */
export async function storeShareOfVoice(
  db: ShareOfVoiceDb & { evidenceRecord: Pick<PrismaClient, "evidenceRecord">["evidenceRecord"] },
  input: { projectId: string; siteId: string | null; sample: ClusterShareOfVoice }
): Promise<{ written: number; sample: ClusterShareOfVoice }> {
  const { sample } = input;
  if (sample.unobserved || sample.domains.length === 0) return { written: 0, sample };
  let written = 0;
  for (const row of sample.domains) {
    await storeEvidenceRecord(db as never, {
      projectId: input.projectId,
      siteId: input.siteId,
      kind: "share_of_voice",
      observedAt: sample.sampledAt ?? new Date(),
      producer: "lib/funnel/share-of-voice",
      dimensions: {
        cluster: sample.cluster,
        week: sample.week,
        domain: row.domain,
        us: row.us,
        queries: row.queries,
        queriesObserved: sample.queriesObserved,
        ...(sample.sampledAt ? { sampledAt: sample.sampledAt.toISOString() } : {}),
      },
      metrics: {
        "first_party:share": {
          value: Math.round(row.share * 1e6) / 1e6,
          unit: "ratio",
          source: "first_party",
        },
        "first_party:credit": {
          value: row.credit,
          unit: "ratio",
          source: "first_party",
        },
      },
    });
    written += 1;
  }
  return { written, sample };
}

/**
 * The scoreboard for one cluster: its weeks, its lines, and the losing queries.
 *
 * This is the shape the UI renders, so the arithmetic in the panel and the arithmetic
 * in the stored rows are one computation rather than two that can drift.
 */
export type ClusterScoreboard = {
  cluster: string;
  status: ClusterStanding;
  samples: ClusterShareOfVoice[];
  /** The newest sample's lines, which is what the table shows. */
  latest: ClusterShareOfVoice | null;
  /** Queries in the newest sample where another domain holds a credited position. */
  losing: Array<{ query: string; domain: string; position: number }>;
  /** True when the cluster has no sample at all. */
  unobserved: boolean;
};

/**
 * Read the scoreboard for a cluster.
 *
 * `losing` names the queries the cluster is not holding: for each query in the newest
 * sample, the best-placed domain that is not us. That is the list a person acts on, and
 * it comes from the same observations the shares came from.
 */
export async function clusterScoreboard(
  db: ShareOfVoiceDb,
  input: { projectId: string; clusterSlug: string; domain: string; weeks?: number }
): Promise<ClusterScoreboard> {
  const allWeeks = await observedWeeks(db, { projectId: input.projectId, clusterSlug: input.clusterSlug });
  const weeks = input.weeks ? allWeeks.slice(-input.weeks) : allWeeks;
  const samples: ClusterShareOfVoice[] = [];
  for (const week of weeks) {
    samples.push(
      await shareOfVoice(db, {
        projectId: input.projectId,
        clusterSlug: input.clusterSlug,
        week,
        domain: input.domain,
      })
    );
  }
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  // The losing queries come from the newest week's raw positions, not from the shares:
  // a share is a cluster total, and a person needs the per-query holder.
  const losing: ClusterScoreboard["losing"] = [];
  if (latest && !latest.unobserved) {
    const observations = await observationsFor(db, {
      projectId: input.projectId,
      clusterSlug: input.clusterSlug,
      week: latest.week,
      domain: input.domain,
    });
    const us = input.domain.toLowerCase().replace(/^www\./, "");
    const bestByQuery = new Map<string, Observation>();
    for (const row of observations.observations) {
      if (row.domain === us) continue;
      const held = bestByQuery.get(row.query);
      if (!held || row.position < held.position) bestByQuery.set(row.query, row);
    }
    for (const [, row] of bestByQuery) {
      losing.push({ query: row.query, domain: row.domain, position: row.position });
    }
    losing.sort((a, b) => a.position - b.position || a.query.localeCompare(b.query));
  }

  return {
    cluster: input.clusterSlug,
    status: clusterStatus({ samples }),
    samples,
    latest,
    losing,
    unobserved: samples.every((sample) => sample.unobserved),
  };
}
