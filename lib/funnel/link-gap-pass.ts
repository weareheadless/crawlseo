import type { PrismaClient } from "@prisma/client";

import { collectReferringDomains } from "@/lib/dataforseo/collection";
import { REFERRING_DOMAINS_LIMIT } from "@/lib/dataforseo/client";
import { storeEvidenceRecord } from "@/lib/funnel/evidence";
import {
  backlinkGap,
  linkTargetSummary,
  normalizeDomain,
  type BacklinkGap,
  type LinkTarget,
  type ReferringDomain,
} from "@/lib/funnel/backlink-gap";

/**
 * CMP-007: the link-target pass.
 *
 * O9 could never fire because `provider:referringDomainGap` had no writer. This
 * pass produces it, and it does so as an honest set difference:
 *
 *   gap = (union of competitors' referring domains) − (our referring domains)
 *
 * Which means **our own referring set has to be bought as well**. Subtracting from
 * a summary count would be arithmetic on a number, not on a set: the site has 63
 * referring domains, so "we have 63" cannot tell you *which* 63, and every domain
 * a competitor shares with us would be offered as an opportunity. One extra call
 * per month buys the only honest answer.
 *
 * Boundaries, each of them a way this could go wrong:
 *  - **A competitor with no data is named, not counted as zero.** `missing` travels
 *    in the gap and into the summary; an absent measurement is not "no links".
 *  - **Nothing is re-bought inside a month.** The referring set is a monthly
 *    observation, and a second run in the same period reuses it.
 *  - **The cap is reported.** Which competitors were skipped is returned, never
 *    silently dropped.
 *  - **No weighting, scoring or priority.** The provider's facts travel with each
 *    domain; ordering is by provider rank, a declared number.
 *
 * This is a list of link targets. It is not an outreach system: no email, no
 * submission, no automation against another site.
 */

/** How many competitor referring sets one pass may buy, beyond our own. */
export const DEFAULT_COMPETITOR_CALL_CAP = 4;

export type LinkGapPassInput = {
  projectId: string;
  siteId: string | null;
  /** The site's own domain, whose referring set is the subtrahend. */
  domain: string;
  /** Competitor domains to measure. Ordered by the caller. */
  competitors: string[];
  /** Skip a target whose referring set was already bought this period. */
  periodStart: Date;
  apply: boolean;
  cap?: number;
  limit?: number;
  now?: Date;
  collect?: typeof collectReferringDomains;
};

export type LinkGapPassResult = {
  gap: BacklinkGap;
  /** Which calls were made, at what cost. The receipt for the pass. */
  calls: Array<{ target: string; role: "own" | "competitor"; spentMicros: number }>;
  /** Competitors not measured because the cap was reached. */
  skipped: string[];
  /** Competitors not measured because this was a dry run. Not a cap. */
  notAttempted: string[];
  /** Competitors already measured this period, reused rather than re-bought. */
  reused: string[];
  /** Targets the provider gave no data for. */
  missing: string[];
  spentMicros: number;
  summary: string;
  /** Evidence ids the gap was computed from, for O9's how leg. */
  evidenceIds: string[];
  /** The own set's paid receipt, which the gap row inherits. */
  rawResponseId: string | null;
  /**
   * Why our own set is in the state it is. "not_attempted" (a dry run) is not the
   * same claim as "failed" (the provider refused), and neither is "reused".
   */
  ownStatus: "reused" | "collected" | "not_attempted" | "failed";
};

type StoredSet = {
  domains: string[];
  ranks: Map<string, number>;
  evidenceId: string;
  /** The receipt for this set. The gap row inherits the own set's receipt. */
  rawResponseId: string | null;
  observedAt: Date;
};

type SetDb = Pick<PrismaClient, "evidenceRecord">;

/**
 * The newest stored referring set for one target, inside the period.
 *
 * A set is identified by its `scope` and `domain`; the newest row for that pair is
 * the current measurement. Reading `domains` is reading the set the paid call
 * returned, not a count someone typed.
 */
export async function storedReferringSet(
  db: SetDb,
  input: { projectId: string; domain: string; scope: "own_referring_domains" | "competitor_referring_domains"; since: Date }
): Promise<StoredSet | null> {
  const target = normalizeDomain(input.domain);
  const rows = await db.evidenceRecord.findMany({
    where: {
      projectId: input.projectId,
      kind: "backlink_profile",
      supersededById: null,
      observedAt: { gte: input.since },
    },
    select: { id: true, observedAt: true, dimensions: true, rawResponseId: true },
    orderBy: { observedAt: "desc" },
  });
  // Pick the newest matching set ourselves rather than trusting the query's order:
  // the identity of a set is (`scope`, `domain`), so a caller passing rows in any
  // order must still get the current measurement.
  let newest: StoredSet | null = null;
  for (const row of rows) {
    const dims = (row.dimensions ?? {}) as {
      scope?: string;
      domain?: string;
      domains?: unknown;
      domainRanks?: unknown;
    };
    if (dims.scope !== input.scope) continue;
    if (typeof dims.domain !== "string" || normalizeDomain(dims.domain) !== target) continue;
    if (newest && row.observedAt <= newest.observedAt) continue;
    const domains = Array.isArray(dims.domains)
      ? dims.domains.filter((value): value is string => typeof value === "string")
      : [];
    const ranks = new Map<string, number>();
    if (Array.isArray(dims.domainRanks)) {
      const rankValues = dims.domainRanks.filter((value): value is number => typeof value === "number");
      domains.forEach((domain, index) => {
        const rank = rankValues[index];
        if (typeof rank === "number") ranks.set(normalizeDomain(domain), rank);
      });
    }
    newest = { domains, ranks, evidenceId: row.id, rawResponseId: row.rawResponseId, observedAt: row.observedAt };
  }
  return newest;
}

/** Turn a stored set into the shape the pure gap function reads. */
function asReferringRows(set: StoredSet): ReferringDomain[] {
  return set.domains.map((domain) => {
    const key = normalizeDomain(domain);
    return {
      domain: key,
      rank: set.ranks.get(key) ?? null,
      backlinks: null,
      targetUrl: null,
      linkType: null,
    };
  });
}

/**
 * Run the pass.
 *
 * `apply: false` buys nothing: it reads the stored sets and reports the gap that
 * would be written, so a person can see the list and its size before spending.
 */
export async function runLinkGapPass(
  db: SetDb,
  input: LinkGapPassInput
): Promise<LinkGapPassResult> {
  const now = input.now ?? new Date();
  const cap = input.cap ?? DEFAULT_COMPETITOR_CALL_CAP;
  const limit = input.limit ?? REFERRING_DOMAINS_LIMIT;
  const collect = input.collect ?? collectReferringDomains;

  const calls: LinkGapPassResult["calls"] = [];
  const skipped: string[] = [];
  const notAttempted: string[] = [];
  const reused: string[] = [];
  const missing: string[] = [];
  const evidenceIds: string[] = [];
  let spentMicros = 0;

  // Our own set first: without it the subtraction has no subtrahend and every
  // shared domain would be presented as an opportunity.
  let ours = await storedReferringSet(db, {
    projectId: input.projectId,
    domain: input.domain,
    scope: "own_referring_domains",
    since: input.periodStart,
  });
  let ownStatus: "reused" | "collected" | "not_attempted" | "failed" = ours ? "reused" : "not_attempted";
  if (ours) {
    evidenceIds.push(ours.evidenceId);
  } else if (input.apply) {
    try {
      const output = await collect(db as never, {
        projectId: input.projectId,
        siteId: input.siteId,
        domain: input.domain,
        limit,
      });
      spentMicros += output.spentMicros;
      calls.push({ target: normalizeDomain(input.domain), role: "own", spentMicros: output.spentMicros });
      for (const row of output.evidence) evidenceIds.push(row.id);
      const written = output.evidence[0];
      if (written) {
        const dims = (written.dimensions ?? {}) as { domains?: unknown; domainRanks?: unknown };
        const domains = Array.isArray(dims.domains)
          ? dims.domains.filter((value): value is string => typeof value === "string")
          : [];
        const ranks = new Map<string, number>();
        if (Array.isArray(dims.domainRanks)) {
          const rankValues = dims.domainRanks.filter((value): value is number => typeof value === "number");
          domains.forEach((domain, index) => {
            const rank = rankValues[index];
            if (typeof rank === "number") ranks.set(normalizeDomain(domain), rank);
          });
        }
        ours = {
          domains,
          ranks,
          evidenceId: written.id,
          rawResponseId: (written as { rawResponseId?: string | null }).rawResponseId ?? null,
          observedAt: now,
        };
        ownStatus = "collected";
      }
    } catch (error) {
      missing.push(normalizeDomain(input.domain));
      ours = null;
      ownStatus = "failed";
      // A failure to read our own set is reported, not swallowed: the gap cannot be
      // computed honestly without it, and saying "gap 0" would be a lie.
      calls.push({ target: normalizeDomain(input.domain), role: "own", spentMicros: 0 });
      if (!input.apply) throw error;
    }
  }

  const competitorSets: Array<{ domain: string; referring: ReferringDomain[] | null; evidenceId?: string }> = [];
  for (const competitor of input.competitors) {
    const target = normalizeDomain(competitor);
    if (!target) continue;
    const stored = await storedReferringSet(db, {
      projectId: input.projectId,
      domain: target,
      scope: "competitor_referring_domains",
      since: input.periodStart,
    });
    if (stored) {
      competitorSets.push({ domain: target, referring: asReferringRows(stored), evidenceId: stored.evidenceId });
      evidenceIds.push(stored.evidenceId);
      reused.push(target);
      continue;
    }
    if (!input.apply) {
      // A dry run cannot know what the provider will return, so it does not claim a
      // gap for this competitor. Reported separately from a cap hit, because
      // "we chose not to spend" and "we ran out of room" are different facts.
      competitorSets.push({ domain: target, referring: null });
      notAttempted.push(target);
      continue;
    }
    if (calls.filter((call) => call.role === "competitor").length >= cap) {
      competitorSets.push({ domain: target, referring: null });
      skipped.push(target);
      continue;
    }
    try {
      const output = await collect(db as never, {
        projectId: input.projectId,
        siteId: input.siteId,
        domain: target,
        limit,
        competitor: target,
      });
      spentMicros += output.spentMicros;
      calls.push({ target, role: "competitor", spentMicros: output.spentMicros });
      const written = output.evidence[0];
      if (!written) {
        competitorSets.push({ domain: target, referring: [] });
        missing.push(target);
        continue;
      }
      evidenceIds.push(written.id);
      const dims = (written.dimensions ?? {}) as { domains?: unknown; domainRanks?: unknown };
      const domains = Array.isArray(dims.domains)
        ? dims.domains.filter((value): value is string => typeof value === "string")
        : [];
      const ranks = new Map<string, number>();
      if (Array.isArray(dims.domainRanks)) {
        const rankValues = dims.domainRanks.filter((value): value is number => typeof value === "number");
        domains.forEach((domain, index) => {
          const rank = rankValues[index];
          if (typeof rank === "number") ranks.set(normalizeDomain(domain), rank);
        });
      }
      competitorSets.push({
        domain: target,
        referring: asReferringRows({ domains, ranks, evidenceId: written.id, rawResponseId: null, observedAt: now }),
        evidenceId: written.id,
      });
    } catch (error) {
      competitorSets.push({ domain: target, referring: null });
      missing.push(target);
      if (!input.apply) throw error;
    }
  }

  const gap = backlinkGap({
    competitors: competitorSets.map((set) => ({ domain: set.domain, referring: set.referring })),
    ours: ours ? asReferringRows(ours) : null,
  });
  // The pure function cannot know why a set is missing when it was never bought;
  // the pass knows, so the two are merged rather than losing one of them.
  const allMissing = [...new Set([...gap.missing, ...missing])];

  // The three "no own set" cases are different claims and must read differently:
  // a dry run attempted nothing, a failure means the provider refused, and a
  // missing purchase means nobody has run the pass this period.
  const summary =
    ours != null
      ? linkTargetSummary(gap)
      : ownStatus === "not_attempted"
        ? "Nothing was bought: this was a dry run and our own referring set has not been collected for this period."
        : ownStatus === "failed"
          ? `Our own referring domains could not be read (${input.domain}), so the link gap is not measured.`
          : `Our own referring set has not been bought for this period, so the link gap is not measured yet.`;

  return {
    gap: { ...gap, missing: allMissing },
    calls,
    skipped,
    notAttempted,
    reused,
    missing: allMissing,
    spentMicros,
    summary,
    evidenceIds,
    rawResponseId: ours?.rawResponseId ?? null,
    ownStatus,
  };
}

/**
 * Write the gap onto the site's own `backlink_profile` row.
 *
 * The row gains `provider:referringDomainGap` and `provider:targetDomainCount`
 * alongside any summary metrics it already had, because O9 reads one row and a
 * second identity for the same fact would make "the own profile" ambiguous. The
 * target list itself is stored in `dimensions.domains` so a task generated from the
 * opportunity carries the names, not just a count.
 */
export async function storeOwnDomainGap(
  db: SetDb,
  input: {
    projectId: string;
    siteId: string | null;
    domain: string;
    gap: BacklinkGap;
    cluster?: string | null;
    /**
     * The paid call this gap was computed from. A provider metric needs a receipt,
     * and the own referring set's response is the one that makes the subtraction
     * possible — the competitor sets are named in `howEvidenceIds` instead.
     */
    rawResponseId: string | null;
    /** Competitor evidence rows the subtraction read, for O9's how leg. */
    competitorEvidenceIds: string[];
  }
): Promise<string> {
  const domain = normalizeDomain(input.domain);
  const rows = await db.evidenceRecord.findMany({
    where: { projectId: input.projectId, kind: "backlink_profile", supersededById: null },
    select: { observedAt: true, dimensions: true, metrics: true },
    orderBy: { observedAt: "desc" },
  });

  // Carry forward the summary numbers this row already had: the gap is an addition
  // to the profile, not a replacement that drops what was measured before.
  const summary: Record<string, { value: number | null; unit: string; source: "provider" }> = {};
  for (const row of rows) {
    const dims = (row.dimensions ?? {}) as { scope?: string; domain?: string };
    if (dims.scope !== "own_domain") continue;
    if (typeof dims.domain === "string" && normalizeDomain(dims.domain) !== domain) continue;
    for (const [label, metric] of Object.entries((row.metrics ?? {}) as Record<string, { value: number | null; unit: string; source: "provider" }>)) {
      if (label === "provider:referringDomainGap" || label === "provider:targetDomainCount") continue;
      summary[label] = metric;
    }
    break;
  }

  const dimensions: Record<string, unknown> = {
    scope: "own_domain",
    domain,
    // The named targets, so the opportunity's task can carry the list itself.
    domains: input.gap.targets.map((row) => row.domain),
    domainRanks: input.gap.targets.map((row) => row.rank ?? 0),
    // Which competitor profiles the subtraction read, and the evidence rows they
    // are, so O9 can cite both sides rather than only the own profile.
    competitorEvidenceIds: input.competitorEvidenceIds,
  };
  if (input.cluster) dimensions.cluster = input.cluster;

  const metrics = {
    ...summary,
    "provider:referringDomainGap": { value: input.gap.gap, unit: "count" as const, source: "provider" as const },
    "provider:targetDomainCount": { value: input.gap.targets.length, unit: "count" as const, source: "provider" as const },
  };

  const stored = await storeEvidenceRecord(db as never, {
    projectId: input.projectId,
    siteId: input.siteId,
    kind: "backlink_profile",
    observedAt: new Date(),
    producer: "lib/funnel/link-gap-pass",
    rawResponseId: input.rawResponseId ?? undefined,
    dimensions: dimensions as never,
    metrics,
  });
  return stored.id;
}

/**
 * CMP-007: the target list for a link-gap opportunity, read from stored evidence.
 *
 * The panel needs the names, so this reads the own-domain profile row the gap was
 * written on and returns its list with the facts that make it a brief: how many
 * domains we already share with the competitors (so the gap is not overstated), how
 * many competitors were measured, and how many domains our own profile had (so an
 * unknown subtrahend is not presented as zero).
 *
 * A page view never fetches or buys anything. Everything here was paid for by the pass.
 */
export async function linkTargetsForOpportunity(
  db: SetDb,
  input: { projectId: string; howEvidenceIds?: string[] }
): Promise<{
  targets: LinkTarget[];
  sharedCount: number;
  competitorCount: number;
  missing: string[];
  ourDomainCount: number | null;
} | null> {
  const rows = await db.evidenceRecord.findMany({
    where: { projectId: input.projectId, kind: "backlink_profile", supersededById: null },
    select: { id: true, dimensions: true, metrics: true, observedAt: true },
    orderBy: { observedAt: "desc" },
  });

  // Prefer the row the opportunity cites; fall back to the newest own-domain row that
  // carries a gap, which is the row the detector reads anyway.
  const cited = input.howEvidenceIds?.length
    ? rows.find((row) => input.howEvidenceIds!.includes(row.id))
    : undefined;
  const own =
    cited && ((cited.dimensions ?? {}) as { scope?: string }).scope === "own_domain"
      ? cited
      : rows.find((row) => {
          const dims = (row.dimensions ?? {}) as { scope?: string };
          if (dims.scope !== "own_domain") return false;
          const metrics = (row.metrics ?? {}) as Record<string, { value?: number | null }>;
          return typeof metrics["provider:referringDomainGap"]?.value === "number";
        });
  if (!own) return null;

  const dims = (own.dimensions ?? {}) as {
    domains?: unknown;
    domainRanks?: unknown;
    competitorEvidenceIds?: unknown;
  };
  const domains = Array.isArray(dims.domains)
    ? dims.domains.filter((value): value is string => typeof value === "string")
    : [];
  const ranks = Array.isArray(dims.domainRanks)
    ? dims.domainRanks.filter((value): value is number => typeof value === "number")
    : [];
  const competitorEvidenceIds = Array.isArray(dims.competitorEvidenceIds)
    ? dims.competitorEvidenceIds.filter((value): value is string => typeof value === "string")
    : [];

  const targets: LinkTarget[] = domains.map((domain, index) => ({
    domain,
    rank: ranks[index] ?? null,
    backlinks: null,
    targetUrl: null,
    linkType: null,
    // The gap row does not carry a per-domain competitor count, and inventing one
    // would be a fabricated number. The panel shows what is known.
    competitorsLinking: 1,
  }));

  // The shared count and the measured competitors come from the sets themselves, so
  // the panel states the subtraction, not only its result.
  const ownSet = rows.find(
    (row) => ((row.dimensions ?? {}) as { scope?: string }).scope === "own_referring_domains"
  );
  const ourDomains = new Set(
    (Array.isArray(((ownSet?.dimensions ?? {}) as { domains?: unknown }).domains)
      ? (((ownSet?.dimensions ?? {}) as { domains: unknown[] }).domains.filter(
          (value): value is string => typeof value === "string"
        ))
      : []
    ).map(normalizeDomain)
  );

  // A *distinct* count, matching the subtraction. Counting an occurrence per
  // competitor set reported 92 excluded domains where the gap had excluded 54: the
  // same shared domain appeared in three sets. The panel must agree with the number
  // the detector scored, or the arithmetic on screen contradicts itself.
  const sharedDomains = new Set<string>();
  const measuredCompetitors = new Set<string>();
  for (const row of rows) {
    const d = (row.dimensions ?? {}) as { scope?: string; domain?: string; domains?: unknown };
    if (d.scope !== "competitor_referring_domains") continue;
    if (typeof d.domain === "string") measuredCompetitors.add(normalizeDomain(d.domain));
    if (!Array.isArray(d.domains)) continue;
    for (const value of d.domains) {
      if (typeof value !== "string") continue;
      const key = normalizeDomain(value);
      if (ourDomains.has(key)) sharedDomains.add(key);
    }
  }
  const sharedCount = sharedDomains.size;

  const metrics = (own.metrics ?? {}) as Record<string, { value?: number | null }>;
  const competitorCount = competitorEvidenceIds.length > 0 ? competitorEvidenceIds.length : measuredCompetitors.size;
  const ourDomainCount =
    typeof metrics["provider:referringDomains"]?.value === "number"
      ? (metrics["provider:referringDomains"].value as number)
      : ownSet
        ? ourDomains.size
        : null;

  return { targets, sharedCount, competitorCount, missing: [], ourDomainCount };
}
