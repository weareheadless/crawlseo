import { ctrAtPosition } from "@/lib/funnel/scoring";
import type { TopicCluster, TopicMap } from "@/lib/research/topic-map";

/**
 * Board priority is arithmetic on facts the map already measured: reach,
 * position, demand and the topic's intent. It is a planning estimate, not a
 * promise. The code never decides which topic matters; it only orders the work
 * the model already described.
 */

export type PriorityTrack = "money" | "content" | "foundation";
export type PriorityBand = "top3" | "page1" | "page2" | "deep" | "unranked";

export type PriorityInput = {
  lane: "timely" | "content_business" | "aeo_geo" | "technical";
  kind: "article" | "update" | "cluster_hub" | "business" | "aeo" | "technical";
  effort: "small" | "medium" | "large" | "unknown";
  confidence: "high" | "medium" | "low" | null;
};

export type ProposalPriority = {
  /** Expected clicks per month at the measured position band, null when unmeasured. */
  score: number | null;
  expectedClicks: number | null;
  band: PriorityBand;
  intentFit: number;
  track: PriorityTrack;
  /** True when the site is too invisible for content work and this is not a foundation. */
  hold: boolean;
  reason: string;
};

/**
 * A topic needs enough observed reach before a click estimate means anything.
 * Below this, provider volume is market size, not reachable demand, and the
 * honest label is "not quantified".
 */
export const MIN_REACH_IMPRESSIONS = 100;

export function intentFitFor(intent: TopicCluster["intent"] | null | undefined): number {
  switch (intent) {
    case "commercial":
    case "transactional":
    case "local":
      return 1;
    case "mixed":
      return 0.7;
    case "informational":
      return 0.35;
    default:
      return 0.5;
  }
}

export function bandFor(position: number | null | undefined): PriorityBand {
  if (position == null || position <= 0) return "unranked";
  if (position <= 3) return "top3";
  if (position <= 10) return "page1";
  if (position <= 20) return "page2";
  return "deep";
}

export function bandLabel(band: PriorityBand): string {
  switch (band) {
    case "top3":
      return "top 3";
    case "page1":
      return "page 1";
    case "page2":
      return "page 2";
    case "deep":
      return "page 3+";
    case "unranked":
      return "no measured position";
  }
}

export function foundationsGate(map: TopicMap): {
  needed: boolean;
  impressions: number;
  clicks: number;
  reason: string;
} {
  // Site-level totals, not the sum of topic memberships: topics overlap and
  // omit queries, so the cluster sum is a lower bound that can hide the site's
  // real reach.
  const impressions = map.site?.impressions ?? map.clusters.reduce((sum, cluster) => sum + cluster.metrics.impressions, 0);
  const clicks = map.site?.clicks ?? map.clusters.reduce((sum, cluster) => sum + cluster.metrics.clicks, 0);
  // The site is not in the results yet: content cannot be ranked by expected
  // clicks because there are none. A site with impressions but no clicks is a
  // different diagnosis (titles and intent), so it does not open the gate.
  const needed = impressions < MIN_REACH_IMPRESSIONS;
  return {
    needed,
    impressions,
    clicks,
    reason: needed
      ? `${impressions} impressions and ${clicks} clicks in the window: the site is not visible enough for content priority. Foundations first.`
      : `${impressions} impressions and ${clicks} clicks in the window: the site has measured reach, so content can be ranked by expected clicks.`,
  };
}

function trackFor(input: PriorityInput, intent: TopicCluster["intent"] | null | undefined): PriorityTrack {
  if (input.lane === "technical") return "foundation";
  if (input.kind === "business") return "money";
  if (intent === "informational") return "content";
  return "money";
}

export function proposalPriority(
  proposal: PriorityInput,
  cluster: TopicCluster | null,
  gate: { needed: boolean }
): ProposalPriority {
  const intent = cluster?.intent ?? null;
  const intentFit = intentFitFor(intent);
  const track = trackFor(proposal, intent);
  const position = cluster?.metrics.position ?? null;
  const band = bandFor(position);
  const reach = cluster?.metrics.impressions ?? 0;
  const marketDemand = cluster?.metrics.volume ?? 0;
  const ctr = ctrAtPosition(position);
  // Expected clicks start from impressions the site actually received in the
  // window, not from the size of the market. Provider volume is market size:
  // it is shown next to the estimate, never multiplied into it, or a single
  // 1.2M-search informational term outranks every page that earns money.
  const measured = track !== "foundation" && ctr != null && reach >= MIN_REACH_IMPRESSIONS;
  const expectedClicks = measured ? reach * ctr * intentFit : null;
  const score = expectedClicks == null ? null : Math.round(expectedClicks * 10) / 10;

  let reason: string;
  if (track === "foundation") {
    reason = "technical defect; priority comes from severity and reach, not from clicks";
  } else if (score != null) {
    const market = marketDemand > 0 ? ` · ${marketDemand} monthly market demand` : "";
    reason = `position ${position?.toFixed(1)} (${bandLabel(band)}) · ${reach} impressions in the window${market} · ${Math.round(intentFit * 100)}% intent fit`;
  } else if (reach === 0) {
    reason = "no measured impressions; demand is market size, not reachable yet";
  } else if (reach < MIN_REACH_IMPRESSIONS) {
    reason = `only ${reach} impressions (below the ${MIN_REACH_IMPRESSIONS} reach threshold); demand is market size, not reachable yet`;
  } else if (position == null) {
    reason = "impressions but no measured position; confirm the query and the page before estimating";
  } else {
    reason = "no measured demand for this topic in the window";
  }

  return {
    score,
    expectedClicks,
    band,
    intentFit,
    track,
    hold: gate.needed && track !== "foundation",
    reason,
  };
}

const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * The board order. When the site is invisible, foundations lead regardless of
 * demand. Otherwise measured money comes first, then unmeasured money, then
 * content, then foundations.
 */
export function comparePriority(
  a: { proposal: PriorityInput; priority: ProposalPriority },
  b: { proposal: PriorityInput; priority: ProposalPriority },
  gate: { needed: boolean }
): number {
  // Foundations lead when the site is invisible. Otherwise measured work leads,
  // and within it a page that can earn leads comes before pure audience growth:
  // a buyer page with fewer projected clicks is worth more than an informational
  // page with more. Foundations follow, then unmeasured money, then unmeasured
  // content. A content-led business marks its core work as a business proposal,
  // which the model can do without a tenant branch here.
  const rank = (item: { priority: ProposalPriority }) => {
    if (gate.needed && item.priority.track === "foundation") return 0;
    if (item.priority.score != null && item.priority.track === "money") return 1;
    if (item.priority.score != null) return 2;
    if (item.priority.track === "foundation") return 3;
    if (item.priority.track === "money") return 4;
    return 5;
  };
  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) return rankDiff;
  if (a.priority.score != null && b.priority.score != null && a.priority.score !== b.priority.score) {
    return b.priority.score - a.priority.score;
  }
  const confidence = (CONFIDENCE_RANK[a.proposal.confidence ?? ""] ?? 3) - (CONFIDENCE_RANK[b.proposal.confidence ?? ""] ?? 3);
  if (confidence !== 0) return confidence;
  const effort = { small: 0, medium: 1, large: 2, unknown: 3 } as const;
  return (effort[a.proposal.effort] ?? 3) - (effort[b.proposal.effort] ?? 3);
}
