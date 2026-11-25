/**
 * The monthly tranche: the clusters a person can actually work this month.
 *
 * ## The defect this replaces
 *
 * `draftClusterProposals` looped over every cluster in batches of four with no overall
 * bound. susimacdonald has 24 clusters, so that was six model calls of drafting every
 * month — and then `applyOpenCap` parked everything past 100 open rows by score. So we
 * paid to draft work that would immediately be hidden, and the board's shape was decided
 * by a score threshold rather than by what anyone could do.
 *
 * A month of work is not a hundred opportunities. It is a handful. So the tranche is
 * chosen once, at the top, and it is visible: which clusters were drafted, which were
 * deferred, and why.
 *
 * ## Deferred is not dropped
 *
 * Everything past the tranche is reported with a count and a reason, and next month it is
 * re-ranked against fresh data. A cluster that was 25th this month may be 2nd next month,
 * because its impressions moved — that is the point of re-ranking rather than re-writing
 * every cluster. Per the no-silent-truncation rule, the number dropped travels with the
 * run.
 *
 * ## What decides the tranche
 *
 * Not the same function as the board's order. The board ranks *opportunities*, which have
 * scores derived from a target page and an assessment. A cluster has not been drafted yet,
 * so it has no such score — ranking it by one would mean scoring an assessment of work
 * that does not exist.
 *
 * A cluster is ranked by what is true about it before drafting: does this site have
 * measured reach on it, how many queries carry it, and did the model rate it commercially
 * relevant. That is evidence, not a projection.
 */

import type { TopicCluster } from "@/lib/research/topic-map";

/**
 * How many clusters are drafted per month.
 *
 * Eight, because a month of SEO work on one site is a handful of content pieces and each
 * cluster is a piece: drafting 24 for a site whose owner can deliver 8 wastes model calls
 * and buries the good ones in a long board. This is a declared product decision, not a
 * tuned constant — change it when the product decision changes.
 */
export const MONTHLY_TRANCHE_CLUSTERS = 8;

export type TrancheCandidate = Pick<TopicCluster, "slug" | "name" | "metrics" | "relevance">;

export type TrancheResult<T extends TrancheCandidate> = {
  /** The clusters to draft, best first. */
  selected: T[];
  /** The clusters deferred to a later month, with the reason each was not chosen. */
  deferred: T[];
  /**
   * A sentence naming how many were deferred and why, for the run report. Null when
   * nothing was deferred, so a complete tranche does not read as a truncation.
   */
  truncation: string | null;
};

/**
 * Rank clusters for the month's work.
 *
 * The order, in priority:
 *
 * 1. **Measured reach exists.** A cluster this site has never been shown for is a
 *    hypothesis about demand; one it already ranks for is work with a starting position.
 *    This is the same "measured before projected" rule the board applies, at the cluster
 *    level.
 * 2. **More measured queries.** Two measured queries is a topic; one is a phrase.
 * 3. **Commercial relevance**, as the model rated it from the site's own facts.
 * 4. **Distinct volume**, the market's size once near-duplicates are counted once.
 *
 * Ties break on the slug so two runs over the same data agree — a tranche that changed
 * order between runs would make the monthly delta unreadable.
 */
export function selectTranche<T extends TrancheCandidate>(
  clusters: readonly T[],
  opts: { size?: number } = {}
): TrancheResult<T> {
  const size = Math.max(1, opts.size ?? MONTHLY_TRANCHE_CLUSTERS);

  const relevanceRank = (relevance: TrancheCandidate["relevance"]): number =>
    relevance === "high" ? 3 : relevance === "medium" ? 2 : 1;

  const ordered = [...clusters].sort((a, b) => {
    const measuredA = a.metrics.measuredQueries ?? 0;
    const measuredB = b.metrics.measuredQueries ?? 0;
    // Measured before unmeasured, and within measured, more queries before fewer.
    if ((measuredA > 0) !== (measuredB > 0)) return measuredA > 0 ? -1 : 1;
    if (measuredA !== measuredB) return measuredB - measuredA;
    if (a.relevance !== b.relevance) return relevanceRank(b.relevance) - relevanceRank(a.relevance);
    if (a.metrics.volume !== b.metrics.volume) return b.metrics.volume - a.metrics.volume;
    return a.slug.localeCompare(b.slug);
  });

  const selected = ordered.slice(0, size);
  const deferred = ordered.slice(size);

  return {
    selected,
    deferred,
    truncation:
      deferred.length === 0
        ? null
        : `${deferred.length} of ${ordered.length} clusters were deferred to a later month: the tranche drafts ${size} of them, and the rest are re-ranked against fresh data next month rather than paid for now`,
  };
}
