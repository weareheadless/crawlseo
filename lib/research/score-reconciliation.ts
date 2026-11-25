/**
 * Which score a proposal is ranked by, and whether it is the one we compute.
 *
 * Two scorers exist:
 *
 *  - `computeScore` (lib/funnel/scoring.ts) writes `Opportunity.scoreValue`, and
 *    `listOpportunities` orders the board by it.
 *  - `proposalPriority` (lib/research/priority.ts) computes expected clicks with
 *    a reach gate, intent fit and a foundations hold — and its result is only
 *    used to render the markdown report.
 *
 * So the number that sorts the board is not the number the priority logic
 * computes. Measured 2026-11-25 across 77 open proposals: 7 sit at 0, 14 at 1,
 * 27 at 20, and only 6 reach 40. The distribution is compressed because
 * `scoreValue` rewards evidence completeness while `proposalPriority` asks a
 * different question (how many clicks this work would actually earn).
 *
 * This module does not change the ordering. It reports, for one proposal, what
 * each scorer says, so the divergence is visible in the product instead of being
 * an argument in a pull request. Choosing one is a follow-up with its own diff:
 * folding `proposalPriority` into `scoreValue` changes every row's stored score
 * and reorders every board, which must not ride along with a deletion.
 */

import { proposalPriority, type ProposalPriority } from "@/lib/research/priority";
import type { TopicCluster } from "@/lib/research/topic-map";
import type { ProposalLane, ProposalKind } from "@/lib/research/opportunity-generation";

export type ScoreReconciliation = {
  /** What `computeScore` stored and the board sorts by. */
  stored: number | null;
  /** What `proposalPriority` computes, including its gate. */
  priority: ProposalPriority | null;
  /**
   * True when the two disagree about whether this work can be sized at all:
   * the stored score implies a quantity while the priority says the demand is
   * not reachable yet, or the reverse.
   */
  disagrees: boolean;
  /** One sentence naming the difference, for a row's detail panel. */
  note: string;
};

export function reconcileScore(input: {
  stored: number | null;
  proposal: { lane: ProposalLane; kind: ProposalKind; title: string };
  cluster: TopicCluster | null;
}): ScoreReconciliation {
  const priority = proposalPriority(
    {
      lane: input.proposal.lane,
      kind: input.proposal.kind,
      title: input.proposal.title,
    } as never,
    input.cluster,
    { needed: false }
  );

  const stored = input.stored;
  // The stored score is a 0–100 completeness-weighted number; the priority is an
  // expected-clicks estimate. They are not on the same scale, so this compares
  // *whether* each can size the work, not their magnitudes.
  const storedSizes = stored != null && stored > 0;
  const prioritySizes = priority.score != null;
  const disagrees = storedSizes !== prioritySizes;

  return {
    stored,
    priority,
    disagrees,
    note: disagrees
      ? prioritySizes
        ? `the board ranks this ${stored ?? "unscored"} but it has ${priority.expectedClicks?.toFixed(1)} expected clicks; the stored score is not measuring demand`
        : `the board ranks this ${stored ?? "unscored"} but its demand is not reachable yet: ${priority.reason}`
      : priority.reason,
  };
}
